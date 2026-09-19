import {
  bytesToBase64,
  base64ToBytes,
  randId,
  doConnection,
} from "./util/index.mjs";
import http from "http";
import { WebSocketServer } from "ws";
import { timingSafeEqual } from "node:crypto";

/** @type {Set<import('./types/types.d.ts').ServerStrategy>} */
const serverStrategies = new Set([
  "first",
  "last-used",
  "random",
  "round-robin",
  "most-recent",
  "last",
]);

/**
 * Same shape as the `LOG_LEVELS` in `agent.mjs` (duplicated here rather than
 * imported so `server.mjs` and `agent.mjs` stay independently importable).
 * @type {import('./types/types.d.ts').LOG_LEVELS}
 */
const LOG_LEVELS = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

/**
 * @class
 * @implements {import('./types/types.d.ts').Server}
 */
const Server = class {
  /** @type {import('./types/types.d.ts').ServerStrategy} */
  #strategy = "first";
  /** @type {() => Response} */
  #defaultHandler = null;
  /** @type {import('./types/types.d.ts').Connection[]} */
  #connections = [];
  /** @type {number} */
  #currentIndex = 0;
  /**
   * Pending in-flight requests, keyed by request id, awaiting a
   * `response`/`response:body`/`response:body:end` cycle from an agent.
   * @type {Map<string, { resolve: (value: Response) => void, reject: (reason?: any) => void, connection: import('./types/types.d.ts').Connection, bodyController: ReadableStreamDefaultController | null }>}
   */
  #pendingRequests = new Map();
  /**
   * Per-connection bookkeeping for every registered (agent) connection.
   * @type {Map<import('./types/types.d.ts').Connection, { send: (data: any) => void, receive: AsyncGenerator<any, void, unknown>, close: () => void, agentId: string | null, connectedAt: number, lastUsedAt: number | null, readLoop: Promise<void> | null }>}
   */
  #agents = new Map();
  /** @type {Map<string, import('./types/types.d.ts').Connection>} */
  #agentsById = new Map();
  /** @type {string} */
  #id = null;
  /** @type {(request: Request | string, options?: RequestInit, moreOptions?: any) => Promise<Response>} */
  #boundFetch = null;
  /** @type {string | null} */
  #secret = null;
  /** @type {boolean} */
  #allowUnauthenticatedAgents = false;
  /** @type {http.Server | null} */
  #httpServer = null;
  /** @type {WebSocketServer | null} */
  #wss = null;
  /** @type {boolean} */
  #listening = false;
  /** @type {number} */
  #logLevel = LOG_LEVELS.NONE;

  /**
   * @param {() => Response} defaultHandler
   * @param {import('./types/types.d.ts').ServerOptions} options
   */
  constructor(defaultHandler = () => new Response(null), options = {}) {
    const {
      strategy = "first",
      secret = null,
      allowUnauthenticatedAgents = false,
      log = LOG_LEVELS.NONE,
    } = options;
    if (!secret && !allowUnauthenticatedAgents) {
      // Without a secret, `#handleAgentMessage`'s "agent" case has nothing
      // to check an incoming handshake against and would silently accept
      // *any* agent with zero verification. That's a footgun a caller is
      // unlikely to intend, so it must be opted into explicitly and loudly
      // rather than falling out of an omitted option.
      throw new Error(
        "Server requires a `secret` to authenticate agents (pass " +
          "`{ secret: '...' }`). If you understand the risk and want to " +
          "accept any agent with no verification, pass " +
          "`{ allowUnauthenticatedAgents: true }` explicitly."
      );
    }
    this.#id = randId("proxy-");
    this.#defaultHandler = defaultHandler;
    this.#connections = [];
    this.#boundFetch = this.unBoundFetch.bind(this);
    this.#logLevel = log;
    this.strategy = strategy;
    this.#secret = secret;
    this.#allowUnauthenticatedAgents = allowUnauthenticatedAgents;
    this.#log(LOG_LEVELS.INFO, "Server initialized with ID:", this.#id);
  }

  /**
   * Constant-time comparison against the configured secret, so a mismatch
   * can't be timed to leak how many leading bytes of a guess were correct.
   * @param {unknown} candidate
   * @returns {boolean}
   */
  #secretMatches(candidate) {
    const expected = Buffer.from(String(this.#secret));
    const actual = Buffer.from(String(candidate ?? ""));
    if (expected.length !== actual.length) {
      // Still perform a fixed-cost comparison rather than short-circuiting
      // immediately, so a length mismatch doesn't return measurably faster
      // than a same-length mismatch.
      timingSafeEqual(expected, expected);
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  /**
   * @param {number} level
   * @param {...any} args
   */
  #log(level, ...args) {
    if (this.#logLevel >= level) {
      console.log(...args);
    }
  }

  /**
   * @param {...any} args
   */
  #logError(...args) {
    if (this.#logLevel >= LOG_LEVELS.ERROR) {
      console.error(...args);
    }
  }

  /**
   * @param {number} port
   * @returns {Promise<void>}
   */
  async listen(port) {
    if (this.#listening) {
      throw new Error("Server is already listening");
    }

    this.#httpServer = http.createServer(async (req, res) => {
      this.#log(LOG_LEVELS.DEBUG, "Received HTTP request:", req.method, req.url);

      let request;
      try {
        // `req.url` from Node's `http` module is a relative path (e.g.
        // "/foo?bar"). The Web `Request` constructor requires an absolute
        // URL, so build one from the Host header first. This has to happen
        // inside a try/catch of its own (rather than relying on the outer
        // try/catch below) so a malformed request can never escape
        // uncaught and hang the client.
        // `X-Forwarded-Host` (standard reverse-proxy convention) takes
        // priority over `Host` so the agent sees the URL the original
        // client intended, not this proxy's own host:port.
        const forwardedHost = req.headers["x-forwarded-host"];
        const host =
          (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ||
          req.headers.host ||
          "localhost";
        const url = new URL(req.url, `http://${host}`).toString();
        const requestInit = {
          method: req.method,
          headers: req.headers,
        };
        // A Request with GET/HEAD method cannot carry a body.
        if (req.method !== "GET" && req.method !== "HEAD") {
          requestInit.body = req;
          requestInit.duplex = "half";
        }
        request = new Request(url, requestInit);
      } catch (error) {
        this.#logError("Error constructing request:", error);
        res.writeHead(500);
        res.end("Internal Server Error");
        return;
      }

      try {
        const response = await this.#boundFetch(request);
        res.writeHead(
          response.status,
          response.statusText,
          Object.fromEntries(response.headers)
        );
        if (response.body) {
          for await (const chunk of response.body) {
            res.write(chunk);
          }
        }
        res.end();
        this.#log(LOG_LEVELS.DEBUG, "Response sent to client");
      } catch (error) {
        this.#logError("Error handling request:", error);
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });

    this.#wss = new WebSocketServer({ server: this.#httpServer });

    this.#wss.on("connection", (ws) => {
      this.#log(LOG_LEVELS.INFO, "New WebSocket connection established");
      this.addConnection(ws);
      ws.on("close", () => {
        this.#log(LOG_LEVELS.INFO, "WebSocket connection closed");
        this.removeConnection(ws);
      });
    });

    await new Promise((resolve) => {
      this.#httpServer.listen(port, () => {
        this.#listening = true;
        this.#log(LOG_LEVELS.INFO, "Server listening on port", port);
        resolve();
      });
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.#listening) {
      throw new Error("Server is not listening");
    }

    this.#log(LOG_LEVELS.INFO, "Closing WebSocket server");
    await new Promise((resolve, reject) => {
      this.#wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.#log(LOG_LEVELS.INFO, "Closing HTTP server");
    await new Promise((resolve, reject) => {
      this.#httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.#listening = false;
    this.#httpServer = null;
    this.#wss = null;
    this.#log(LOG_LEVELS.INFO, "Server closed");
  }

  /**
   * Register a raw connection (a `ws` WebSocket server-side or a
   * Deno-native WebSocket, anything matching the `Connection` interface) as
   * a candidate agent connection, and start consuming its incoming
   * messages.
   * @param {import('./types/types.d.ts').Connection} connection
   * @returns {Promise<import('./types/types.d.ts').Connection>}
   */
  async addConnection(connection) {
    if (this.#agents.has(connection)) {
      return connection;
    }
    const [send, receive] = doConnection(connection);
    const record = {
      send,
      receive,
      close: connection.close ? connection.close.bind(connection) : () => {},
      agentId: null,
      // "Connected" is tracked from registration time (not from a
      // successful handshake) so the `most-recent` strategy still has a
      // sensible answer even before/without a handshake, and stays
      // consistent with how `first`/`last`/`random`/`round-robin` already
      // operate over raw connections regardless of handshake state.
      connectedAt: Date.now(),
      lastUsedAt: null,
      readLoop: null,
    };
    this.#agents.set(connection, record);
    this.#connections.push(connection);

    record.readLoop = this.#runReceiveLoop(connection, record).catch(
      (error) => {
        this.#logError("Agent connection read loop error:", error);
      }
    );

    return connection;
  }

  /**
   * @param {import('./types/types.d.ts').Connection} connection
   */
  removeConnection(connection) {
    const record = this.#agents.get(connection);
    if (!record) return;

    this.#agents.delete(connection);
    const index = this.#connections.indexOf(connection);
    if (index !== -1) {
      this.#connections.splice(index, 1);
    }
    if (record.agentId && this.#agentsById.get(record.agentId) === connection) {
      this.#agentsById.delete(record.agentId);
    }

    // Any request still in flight against this connection can never
    // receive a response now; reject it instead of leaving `fetch()`
    // hanging forever.
    for (const [id, entry] of this.#pendingRequests) {
      if (entry.connection !== connection) continue;
      this.#pendingRequests.delete(id);
      const error = new Error(
        "Agent connection closed before response completed"
      );
      try {
        entry.bodyController?.error(error);
      } catch {}
      entry.reject(error);
    }
  }

  /**
   * @param {string} id
   */
  removeConnectionById(id) {
    const connection = this.#agentsById.get(id);
    if (connection) {
      this.removeConnection(connection);
    }
  }

  /**
   * @param {number} index
   */
  removeConnectionByIndex(index) {
    const connection = this.#connections[index];
    if (connection) {
      this.removeConnection(connection);
    }
  }

  /**
   * @param {string} id
   * @returns {import('./types/types.d.ts').Connection | undefined}
   */
  getConnectionById(id) {
    return this.#agentsById.get(id);
  }

  /**
   * @param {number} index
   * @returns {import('./types/types.d.ts').Connection | undefined}
   */
  getConnectionByIndex(index) {
    return this.#connections[index];
  }

  /**
   * @param {import('./types/types.d.ts').ServerStrategy} newStrategy
   */
  setStrategy(newStrategy) {
    if (!serverStrategies.has(newStrategy)) {
      throw new Error(`Invalid strategy: ${newStrategy}`);
    }
    this.#strategy = newStrategy;
  }

  /**
   * @returns {import('./types/types.d.ts').ServerStrategy}
   */
  get strategy() {
    return this.#strategy;
  }

  /**
   * @param {import('./types/types.d.ts').ServerStrategy} newStrategy
   */
  set strategy(newStrategy) {
    this.setStrategy(newStrategy);
  }

  /**
   * Consume every incoming message on a registered connection: handshake,
   * responses, and streamed response bodies.
   * @param {import('./types/types.d.ts').Connection} connection
   * @param {{ send: (data: any) => void, receive: AsyncGenerator<any, void, unknown>, agentId: string | null, connectedAt: number, lastUsedAt: number | null }} record
   */
  async #runReceiveLoop(connection, record) {
    for await (const message of record.receive) {
      this.#handleAgentMessage(connection, record, message);
    }
  }

  /**
   * @param {import('./types/types.d.ts').Connection} connection
   * @param {{ send: (data: any) => void, agentId: string | null, connectedAt: number, lastUsedAt: number | null }} record
   * @param {any} message
   */
  #handleAgentMessage(connection, record, message) {
    const { kind, id, payload } = message;
    switch (kind) {
      case "agent": {
        if (this.#secret !== null && !this.#secretMatches(message.secret)) {
          this.#logError(
            "Rejected agent handshake: invalid secret for agent",
            message.agent
          );
          this.removeConnection(connection);
          try {
            record.close();
          } catch {}
          return;
        }
        record.agentId = message.agent;
        this.#agentsById.set(message.agent, connection);
        this.#log(LOG_LEVELS.INFO, "Agent registered:", message.agent);
        break;
      }
      case "response": {
        const entry = this.#pendingRequests.get(id);
        if (!entry) {
          this.#log(
            LOG_LEVELS.WARN,
            "Received response for unknown/expired request:",
            id
          );
          return;
        }
        const headers = new Headers(payload.headers || {});
        if (payload.body) {
          let controller = null;
          const stream = new ReadableStream({
            start(c) {
              controller = c;
            },
          });
          entry.bodyController = controller;
          entry.resolve(
            new Response(stream, {
              status: payload.status,
              statusText: payload.statusText,
              headers,
            })
          );
          record.send({ kind: "response:body?", id });
        } else {
          entry.resolve(
            new Response(null, {
              status: payload.status,
              statusText: payload.statusText,
              headers,
            })
          );
          // No body means the request/response cycle is already complete.
          record.lastUsedAt = Date.now();
          this.#pendingRequests.delete(id);
        }
        break;
      }
      case "response:body": {
        const entry = this.#pendingRequests.get(id);
        if (!entry || !entry.bodyController) {
          this.#log(
            LOG_LEVELS.WARN,
            "Received response:body for unknown/non-streaming request:",
            id
          );
          return;
        }
        try {
          const bytes =
            payload.bodyKind === "base64"
              ? base64ToBytes(payload.body)
              : payload.body;
          entry.bodyController.enqueue(bytes);
        } catch (error) {
          this.#logError("Error enqueuing response body chunk:", error);
        }
        break;
      }
      case "response:body:end": {
        const entry = this.#pendingRequests.get(id);
        if (!entry || !entry.bodyController) {
          this.#log(
            LOG_LEVELS.WARN,
            "Received response:body:end for unknown/non-streaming request:",
            id
          );
          return;
        }
        try {
          entry.bodyController.close();
        } catch (error) {
          this.#logError("Error closing response body stream:", error);
        }
        // The body finished draining: the cycle is now complete.
        record.lastUsedAt = Date.now();
        this.#pendingRequests.delete(id);
        break;
      }
      default:
        this.#log(LOG_LEVELS.DEBUG, "Unhandled message kind from agent:", kind);
    }
  }

  /**
   * @param {Request | string} request
   * @param {RequestInit} [options]
   * @param {any} [moreOptions]
   * @returns {Promise<Response>}
   */
  unBoundFetch(request, options = {}, moreOptions = {}) {
    this.#log(
      LOG_LEVELS.DEBUG,
      "unBoundFetch called with request:",
      request?.url
    );
    let req;
    let opts;
    if (!(request instanceof Request)) {
      if (typeof request !== "string") {
        throw new Error("req must be a string or Request");
      }
      req = new Request(request, options);
      opts = moreOptions;
    } else {
      req = request;
      opts = { options, ...moreOptions };
    }
    // Promise.withResolvers() is Node 22+ only -- this package's engines
    // range goes down to 14.0.0. Portable manual-executor equivalent.
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.commit(req, opts, resolve, reject);
    return promise;
  }

  /**
   * @returns {(request: Request | string, options?: RequestInit, moreOptions?: any) => Promise<Response>}
   */
  get fetch() {
    return this.#boundFetch;
  }

  /**
   * @returns {boolean}
   */
  get listening() {
    return this.#listening;
  }

  /**
   * Select a connection according to the current strategy, preferring
   * whichever bookkeeping timestamp the strategy needs.
   * @param {"connectedAt" | "lastUsedAt"} field
   * @returns {import('./types/types.d.ts').Connection | null}
   */
  #pickByTimestamp(field) {
    let best = null;
    let bestTime = -Infinity;
    for (const connection of this.#connections) {
      const record = this.#agents.get(connection);
      const time = record?.[field];
      if (typeof time === "number" && time > bestTime) {
        bestTime = time;
        best = connection;
      }
    }
    return best;
  }

  /**
   * @param {Request} request
   * @param {any} options
   * @param {(value: Response) => void} resolve
   * @param {(reason: any) => void} reject
   */
  commit(request, options, resolve, reject) {
    const id = randId("req-");
    const connections = this.#connections;
    if (connections.length === 0) {
      this.#log(LOG_LEVELS.DEBUG, "No agents available, using default handler");
      try {
        resolve(this.#defaultHandler(request));
      } catch (error) {
        reject(error);
      }
      return;
    }

    let connection;
    switch (this.#strategy) {
      case "first":
        connection = connections[0];
        break;
      case "last":
        connection = connections[connections.length - 1];
        break;
      case "random":
        connection = connections[Math.floor(Math.random() * connections.length)];
        break;
      case "round-robin":
        connection = connections[this.#currentIndex % connections.length];
        this.#currentIndex = (this.#currentIndex + 1) % connections.length;
        break;
      case "last-used":
        // Falls back to the first connection if no agent has completed a
        // request/response cycle yet.
        connection = this.#pickByTimestamp("lastUsedAt") ?? connections[0];
        break;
      case "most-recent":
        connection = this.#pickByTimestamp("connectedAt") ?? connections[0];
        break;
      default:
        reject(new Error(`Invalid strategy: ${this.#strategy}`));
        return;
    }

    const record = this.#agents.get(connection);
    if (!record) {
      reject(new Error("Selected agent connection is no longer registered"));
      return;
    }

    this.#pendingRequests.set(id, {
      resolve,
      reject,
      connection,
      bodyController: null,
    });

    const headers = {};
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }

    record.send({
      kind: "request",
      id,
      payload: {
        url: request.url,
        method: request.method,
        headers,
        body: request.body !== null,
      },
    });

    if (request.body) {
      this.#streamRequestBody(request.body, id, record.send, connection);
    }
  }

  /**
   * @param {ReadableStream} body
   * @param {string} id
   * @param {(message: any) => void} send
   * @param {import('./types/types.d.ts').Connection} connection
   */
  async #streamRequestBody(body, id, send, connection) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          send({ kind: "request:body:end", id });
          break;
        }
        send({
          kind: "request:body",
          id,
          payload: { body: bytesToBase64(value), bodyKind: "base64" },
        });
        // Backpressure: wait if the WebSocket's outgoing buffer is full,
        // mirroring the same pattern used for response bodies in agent.mjs.
        while (connection.bufferedAmount > 1024 * 64) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } catch (error) {
      this.#logError("Error streaming request body:", error);
      send({ kind: "request:body:error", id, error: error.message });
    } finally {
      reader.releaseLock();
    }
  }
};

export { Server, LOG_LEVELS };
export default Server;

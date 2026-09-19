import WebSocket from "ws";
import EventEmitter from "node:events";
import {
  bytesToBase64,
  base64ToBytes,
  doConnection,
  randId,
} from "./util/index.mjs";

/** @type {import('./types/types.d.ts').LOG_LEVELS} */
const LOG_LEVELS = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

/**
 * @class
 * @implements {import('./types/types.d.ts').Agent}
 */
const Agent = class extends EventEmitter {
  /** @type {Promise<import('./types/types.d.ts').Connection> | null} */
  #connection = null;
  /** @type {string | null} */
  #id = null;
  /** @type {Map<string, any>} */
  #sessions = null;
  /** @type {(data: any) => void} */
  #send = null;
  /** @type {AsyncGenerator<any, void, unknown>} */
  #recieve = null;
  /** @type {number | undefined} */
  #reconnect = undefined;
  /** @type {(handler: (request: Request, options: { id: string }) => Promise<Response>) => void} */
  #boundServe = (handler) => {};
  /** @type {number} */
  #log = 0;
  /** @type {() => Response} */
  #abort = () => {};
  /** @type {(request: Request, options: { id: string }) => Promise<Response>} */
  #handler = () => new Response("empty responder", { status: 500 });
  /** @type {((request: Request) => Request | Promise<Request>) | null} */
  #onRequest = null;
  /** @type {((request: Request, response: Response) => Response | Promise<Response>) | null} */
  #onResponse = null;

  /** @type {((address: string) => Promise<import('./types/types.d.ts').Connection>) | null} */
  #transportFactory = null;

  /**
   * @param {string} address
   * @param {import('./types/types.d.ts').AgentOptions} options
   */
  constructor(
    address,
    { reconnect, log, abort, secret, onRequest, onResponse, transport } = {
      reconnect: undefined,
      log: 0,
      abort: () => new Response("aborted", { status: 500 }),
      secret: undefined,
      onRequest: null,
      onResponse: null,
      transport: undefined,
    }
  ) {
    super();
    this.#log = log;
    this.#reconnect = reconnect;
    this.#id = randId("agent-");
    this.#abort = abort;
    this.#onRequest = onRequest || null;
    this.#onResponse = onResponse || null;
    this.#transportFactory = transport || null;
    this.#sessions = new Map();
    if (this.#log > LOG_LEVELS.WARN) {
      console.log("AgentID", this.#id);
    }
    this.#connection = this.createConnection(address, secret);
    this.#boundServe = this.unboundServe.bind(this);
  }

  /**
   * Runs the dialback wire-protocol handshake (send the `"agent"` message)
   * and starts the message-dispatch loop against an already-connected
   * `Connection`, then resolves `success` with it. Shared by both the
   * default `WebSocket` path and the pluggable `transport` path in
   * `createConnection()` below, so the two stay behaviorally identical past
   * the point where a `Connection` exists.
   * @param {import('./types/types.d.ts').Connection} connection
   * @param {string | undefined} secret
   * @param {(connection: import('./types/types.d.ts').Connection) => void} success
   */
  #runHandshake(connection, secret, success) {
    const [send, recieve] = doConnection(connection);
    send({
      kind: "agent",
      secret,
      agent: this.#id,
    });
    this.#send = send;
    this.#recieve = recieve;
    // Request-body writers, keyed by request id, for requests whose
    // body hasn't finished streaming in yet.
    //
    // NOTE: this used to open a *second*, per-request-scoped
    // `doConnection(connection, {filter, transform})` channel (its own
    // extra "message" listener) the moment a "request" message was
    // handled, and consume "request:body"/"request:body:end" there
    // instead of in this loop. That has a real race: the server can
    // send "request:body" chunks fast enough (e.g. over a same-process
    // loopback connection where the incoming body is already buffered)
    // that they arrive and fire before the per-request listener has
    // been registered. Since only the *outer* (unfiltered) listener
    // exists at that point, and this loop below ignores anything that
    // isn't `kind === "request"`, those early chunks were silently
    // dropped forever, truncating the reconstructed request body. Using
    // a single loop with id-keyed lookups (like the server side) avoids
    // the window entirely: every message is seen by exactly one
    // listener, in arrival order, regardless of timing.
    const requestBodyWriters = new Map();
    setTimeout(async () => {
      for await (const message of this.#recieve) {
        const { kind, id, payload } = message;
        if (kind === "request") {
          let response;
          let body = null;
          if (payload.body) {
            const stream = new TransformStream();
            body = stream.readable;
            requestBodyWriters.set(id, stream.writable.getWriter());
          }

          let request = new Request(payload.url, {
            method: payload.method,
            headers: payload.headers,
            body: body,
            duplex: "half",
          });
          if (this.#onRequest) {
            request = (await this.#onRequest(request)) || request;
          }
          try {
            response = this.#handler(request, {
              id,
              proxy: { agentId: this.#id, requestId: id },
              state: new Map(),
            });
          } catch (err) {
            if (this.#log >= LOG_LEVELS.ERROR) {
              console.error("Handler error:", err);
            }
            this.emit("error", err);
            response = Promise.resolve(
              new Response("Internal Server Error", { status: 500 })
            );
          }
          this.#sessions.set(id, {
            request,
            response,
          });
          response.then(
            async (response = new Response(null, { status: 500 })) => {
              if (this.#onResponse) {
                response =
                  (await this.#onResponse(request, response)) || response;
              }
              const session = this.#sessions.get(id);
              this.#sessions.set(id, {
                ...session,
                response,
              });
              send({
                kind: "response",
                id,
                payload: {
                  headers: Object.fromEntries(response.headers),
                  statusText: response.statusText,
                  status: response.status,
                  body: !!response.body,
                },
              });
              if (response.body) {
                setTimeout(async () => {
                  const reader = response.body.getReader();
                  let { value, done } = await reader.read();
                  while (!done) {
                    send({
                      kind: "response:body",
                      id,
                      payload: {
                        body: bytesToBase64(value),
                        bodyKind: "base64",
                      },
                    });
                    // Backpressure: wait if WebSocket buffer is full
                    while (connection.bufferedAmount > 1024 * 64) {
                      await new Promise((r) => setTimeout(r, 10));
                    }
                    ({ value, done } = await reader.read());
                  }
                  send({ kind: "response:body:end", id });
                });
              }
            }
          ).catch((err) => {
            if (this.#log >= LOG_LEVELS.ERROR) {
              console.error("Response error:", err);
            }
            this.emit("error", err);
            send({
              kind: "response",
              id,
              payload: {
                headers: {},
                statusText: err?.message || "Internal Server Error",
                status: 500,
                body: false,
              },
            });
          });
        } else if (kind === "request:body") {
          const writer = requestBodyWriters.get(id);
          writer?.write(
            payload.bodyKind === "base64"
              ? base64ToBytes(payload.body)
              : payload.body
          );
        } else if (kind === "request:body:end" || kind === "request:end") {
          const writer = requestBodyWriters.get(id);
          writer?.close();
          requestBodyWriters.delete(id);
        }
      }
    });
    success(connection);
  }

  /**
   * @param {string} address
   * @param {string | undefined} secret
   * @returns {Promise<import('./types/types.d.ts').Connection>}
   */
  createConnection(address, secret) {
    return new Promise((success) => {
      const closer = () => {
        if (this.#log > LOG_LEVELS.WARN) {
          console.log(`reconnecting in ${this.#reconnect} ms`);
        }

        if (this.#reconnect !== undefined) {
          this.#connection = new Promise(async (success) => {
            await new Promise((success) =>
              setTimeout(success, this.#reconnect)
            );
            success(this.createConnection(address));
          });
        }
      };

      // Pluggable transport: when provided, used instead of `new
      // WebSocket(address)` below. The factory does its own connecting
      // (e.g. `VirtualNetwork#connect()` plus an identity handshake, see
      // `transports/browsermesh.mjs`) and resolves with an
      // already-connected `Connection` -- there's no separate "open" event
      // to wait for, so the handshake runs as soon as the factory's promise
      // resolves. This branch leaves the default `new WebSocket(...)` path
      // below completely untouched.
      if (this.#transportFactory) {
        Promise.resolve(this.#transportFactory(address))
          .then((connection) => {
            connection.on?.("close", closer);
            this.#runHandshake(connection, secret, success);
          })
          .catch((error) => {
            if (this.#log >= LOG_LEVELS.ERROR) {
              console.error("Transport connection error:", error);
            }
            this.emit("error", error);
          });
        return;
      }

      const connection = new WebSocket(address);
      const handshaker = () => this.#runHandshake(connection, secret, success);
      connection.on("open", handshaker);
      connection.on("close", closer);
    });
  }

  /**
   * @returns {Promise<import('./types/types.d.ts').Connection>}
   */
  get connection() {
    return this.#connection;
  }

  /**
   * @param {(request: Request, options: { id: string }) => Promise<Response>} handler
   */
  unboundServe(handler) {
    this.#handler = handler;
  }

  /**
   * @returns {(handler: (request: Request, options: { id: string }) => Promise<Response>) => void}
   */
  get serve() {
    return this.#boundServe;
  }

  /**
   * Close the WebSocket connection and emit a 'close' event
   */
  async close() {
    if (this.#connection) {
      const connection = await this.#connection;
      connection.close();
      this.#connection = null;
      this.emit("close");
    }
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
};

/**
 * @param {Request} req
 * @returns {Response}
 */
const upgradeWebSocket = (req) => {
  const response = new Response(null, { websocket: true });
  return response;
};

export { Agent, upgradeWebSocket, LOG_LEVELS };

export default Agent;

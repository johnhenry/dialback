import WebSocket from "ws";
import EventEmitter from "node:events";
import {
  bytesToBase64,
  base64ToBytes,
  doConnection,
  randId,
} from "./util/index.mjs";

/** @type {import('./types/types').LOG_LEVELS} */
const LOG_LEVELS = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

/**
 * @class
 * @implements {import('./types/types').Agent}
 */
const Agent = class extends EventEmitter {
  /** @type {Promise<import('./types/types').Connection> | null} */
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

  /**
   * @param {string} address
   * @param {import('./types/types').AgentOptions} options
   */
  constructor(
    address,
    { reconnect, log, abort, secret, onRequest, onResponse } = {
      reconnect: undefined,
      log: 0,
      abort: () => new Response("aborted", { status: 500 }),
      secret: undefined,
      onRequest: null,
      onResponse: null,
    }
  ) {
    super();
    this.#log = log;
    this.#reconnect = reconnect;
    this.#id = randId("agent-");
    this.#abort = abort;
    this.#onRequest = onRequest || null;
    this.#onResponse = onResponse || null;
    this.#sessions = new Map();
    if (this.#log > LOG_LEVELS.WARN) {
      console.log("AgentID", this.#id);
    }
    this.#connection = this.createConnection(address, secret);
    this.#boundServe = this.unboundServe.bind(this);
  }

  /**
   * @param {string} address
   * @param {string | undefined} secret
   * @returns {Promise<import('./types/types').Connection>}
   */
  createConnection(address, secret) {
    return new Promise((success) => {
      const connection = new WebSocket(address);
      const handshaker = () => {
        const [send, recieve] = doConnection(connection);
        send({
          kind: "agent",
          secret,
          agent: this.#id,
        });
        this.#send = send;
        this.#recieve = recieve;
        setTimeout(async () => {
          let stream = null;
          let send, recieve;
          for await (const message of this.#recieve) {
            const { kind, id, payload, request: req } = message;
            if (kind === "request") {
              let response;
              [send, recieve] = doConnection(connection, {
                filter: (x) => x.request === req,
                transform: (x) => ({ ...x, request: req }),
              });
              let body = null;
              if (payload.body) {
                stream = new TransformStream();
                body = stream.readable;
                setTimeout(async () => {
                  const writer = stream.writable.getWriter();
                  for await (const message of recieve) {
                    const { kind, payload } = message;
                    if (kind === "request:body") {
                      writer?.write(
                        payload.bodyKind === "base64"
                          ? base64ToBytes(payload.body)
                          : payload.body
                      );
                    } else if (
                      kind === "request:body:end" ||
                      kind === "request:end"
                    ) {
                      writer?.close();
                    } else if (kind === "response:body?") {
                      // read response body
                      const res = await response;
                      const reader = res.body.getReader();
                      let value, done;
                      while (!done) {
                        // TODO: bail out if collection empty?
                        ({ value, done } = await reader.read());
                        send({
                          kind: "response:body",
                          payload: {
                            body: bytesToBase64(value),
                            bodyKind: "base64",
                          },
                        });
                      }
                      //reader.close();
                      send({ kind: "response:body:end" });
                    }
                  }
                });
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
                  id: req,
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
                send,
                recieve,
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
                      send({ kind: "response:body:end" });
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
                  payload: {
                    headers: {},
                    statusText: err?.message || "Internal Server Error",
                    status: 500,
                    body: false,
                  },
                });
              });
            }
          }
        });
        success(connection);
      };
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
      connection.on("open", handshaker);
      connection.on("close", closer);
    });
  }

  /**
   * @returns {Promise<import('./types/types').Connection>}
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

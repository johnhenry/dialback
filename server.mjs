import {
  bytesToBase64,
  base64ToBytes,
  randId,
  invertedPromise,
  doConnection,
} from "./util/index.mjs";

/** @type {Set<import('./types/types').ServerStrategy>} */
const serverStrategies = new Set([
  "first",
  "last-used",
  "random",
  "round-robin",
  "most-recent",
  "last",
]);

/**
 * @class
 * @implements {import('./types/types').Server}
 */
const Server = class {
  /** @type {import('./types/types').ServerStrategy} */
  #strategy = "first";
  /** @type {() => Response} */
  #defaultHandler = null;
  /** @type {import('./types/types').Connection[]} */
  #connections = [];
  /** @type {number} */
  #currentIndex = 0;
  /** @type {Map<string, import('./types/types').Connection>} */
  #connectionsById = new Map();
  /** @type {Map<import('./types/types').Connection, ReturnType<typeof doConnection>>} */
  #agents = new Map();
  /** @type {string} */
  #id = null;
  /** @type {(request: Request | string, options?: RequestInit, moreOptions?: any) => Promise<Response>} */
  #boundFetch = null;
  /** @type {string | null} */
  #secret = null;

  /**
   * @param {() => Response} defaultHandler
   * @param {import('./types/types').ServerOptions} options
   */
  constructor(
    defaultHandler = () => new Response(null),
    { strategy = "first", secret } = { strategy: "first", secret }
  ) {
    this.#id = randId("proxy-");
    this.#defaultHandler = defaultHandler;
    this.#connections = [];
    this.#boundFetch = this.unBoundFetch.bind(this);
    this.strategy = strategy;
    this.#secret = secret;
  }

  /**
   * @param {import('./types/types').Connection} connection
   * @param {string} [connectionId]
   * @returns {ReturnType<typeof doConnection>}
   */
  getAgent(connection, connectionId = undefined) {
    if (this.#agents.has(connection)) {
      return this.#agents.get(connection);
    } else {
      if (!connectionId) {
        throw new Error("connectionId required if connection is new");
      }
      this.#connectionsById.set(connectionId, connection);
      this.#connections.push(connection);
      const agent = doConnection(connection);
      this.#agents.set(connection, agent);
      return agent;
    }
  }

  /**
   * @param {import('./types/types').Connection} connection
   * @returns {Promise<import('./types/types').Connection>}
   */
  addConnection(connection) {
    return new Promise((succeed, fail) => {
      const handshaker = (event) => {
        const { kind, agent, secret } = JSON.parse(event.data);
        if (kind === "agent") {
          if (this.#secret && this.#secret !== secret) {
            connection.close();
            fail(new Error("handshake failed: secret mismatch"));
            return;
          }
          const [send] = this.getAgent(connection, agent);
          send({
            kind: "proxy",
            proxy: this.#id,
            agent,
          });
          succeed(connection);
        } else {
          connection.close();
          fail(new Error("handshake failed: kind mismatch"));
        }
        connection.removeEventListener("message", handshaker);
      };
      connection.addEventListener("message", handshaker);
    });
  }

  /**
   * @param {import('./types/types').Connection} connection
   * @returns {string | undefined}
   */
  findConnectionId(connection) {
    for (const [id, conn] of this.#connectionsById) {
      if (conn === connection) {
        return id;
      }
    }
  }

  /**
   * @param {import('./types/types').Connection} connection
   * @returns {number}
   */
  findConnectionIndex(connection) {
    return this.#connections.indexOf(connection);
  }

  /**
   * @param {import('./types/types').Connection} connection
   */
  removeConnection(connection) {
    const id = this.findConnectionId(connection);
    if (id) {
      this.#connectionsById.delete(id);
    }
    const index = this.findConnectionIndex(connection);
    if (index !== -1) {
      this.#connections.splice(index, 1);
    }
    this.#agents.delete(connection);
  }

  /**
   * @param {string} id
   */
  removeConnectionById(id) {
    const connection = this.#connectionsById.get(id);
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
   * @returns {import('./types/types').Connection | undefined}
   */
  getConnectionById(id) {
    return this.#connectionsById.get(id);
  }

  /**
   * @param {number} index
   * @returns {import('./types/types').Connection | undefined}
   */
  getConnectionByIndex(index) {
    return this.#connections[index];
  }

  /**
   * @param {import('./types/types').ServerStrategy} newStrategy
   */
  setStrategy(newStrategy) {
    if (serverStrategies.has(newStrategy)) {
      this.#strategy = newStrategy;
    }
  }

  /**
   * @param {import('./types/types').ServerStrategy} newStrategy
   */
  set strategy(newStrategy) {
    this.setStrategy(newStrategy);
  }

  /**
   * @returns {import('./types/types').Connection}
   */
  get connection() {
    switch (this.#strategy) {
      case "first":
        this.#currentIndex = 0;
        break;
      case "last":
        this.#currentIndex = this.#connections.length - 1;
      case "random":
        this.#currentIndex = Math.floor(
          Math.random() * this.#connections.length
        );
        break;
      case "round-robin":
        this.#currentIndex++;
        if ((this.#currentIndex = this.#connections.length)) {
          this.#currentIndex = 0;
        }
        break;
      case "most-recent":
      default:
      // do nothing
    }
    return this.#connections[this.#currentIndex];
  }

  /**
   * @param {Request} request
   * @param {{ id?: string }} options
   * @param {(response: Response) => void} callback
   * @param {(error: Error) => void} die
   */
  async commit(
    request,
    { id = randId("request-") } = { id: randId("request-") },
    callback,
    die
  ) {
    try {
      const { connection } = this;
      if (!connection) {
        return callback(this.#defaultHandler(request));
      }
      const [send, recieve] = doConnection(connection, {
        filter: (x) => x.request === id,
        transform: (x) => ({ ...x, request: id }),
      });
      send({
        kind: "request",
        payload: {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: !!request.body,
        },
      });

      // Send body asynchronously
      if (request.body) {
        setTimeout(async () => {
          const reader = request.body.getReader();
          let { value, done } = await reader.read();

          while (!done) {
            // TODO: bail out if collection empty?
            send({
              kind: "request:body",
              payload: {
                body: bytesToBase64(value),
                bodyKind: "base64",
              },
            });
            ({ value, done } = await reader.read());
            await new Promise((succeed) => setTimeout(succeed, 1));
          }
          send({ kind: "request:body:end" });
        });
      }
      setTimeout(async () => {
        let stream = null;
        let writer = null;
        for await (const event of recieve) {
          const { kind, payload } = event;

          let body = null;
          if (kind === "response") {
            if (payload.body) {
              stream = new TransformStream();
              body = stream.readable;
              writer = stream.writable.getWriter();
            }
            callback(
              new Response(body, {
                status: payload.status,
                statusText: payload.statusText,
                // Note: HTTP2+ does not support statusText: https://github.com/hyperium/http/issues/345#issuecomment-558763905
                headers: payload.headers,
              })
            );
          } else if (kind === "response:body") {
            writer?.write(
              payload.bodyKind === "base64"
                ? base64ToBytes(payload.body)
                : payload.body
            );
          } else if (kind === "response:end" || kind === "response:body:end") {
            writer?.close();
            break;
          } else if (kind === "response:abort") {
            die(new Error("response:abort"));
            break;
          }
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * @param {Request | string} request
   * @param {RequestInit} [options]
   * @param {any} [moreOptions]
   * @returns {Promise<Response>}
   */
  unBoundFetch(request, options = {}, moreOptions = {}) {
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
    const [response, callback, die] = invertedPromise();
    this.commit(req, opts, callback, die);
    return response;
  }

  /**
   * @returns {(request: Request | string, options?: RequestInit, moreOptions?: any) => Promise<Response>}
   */
  get fetch() {
    return this.#boundFetch;
  }
};

export { Server };
export default Server;

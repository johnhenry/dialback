import {
  bytesToBase64,
  base64ToBytes,
  randId,
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
  constructor(defaultHandler = () => new Response(null), options = {}) {
    const { strategy = "first", secret = null } = options;
    this.#id = randId("proxy-");
    this.#defaultHandler = defaultHandler;
    this.#connections = [];
    this.#boundFetch = this.unBoundFetch.bind(this);
    this.strategy = strategy;
    this.#secret = secret;
  }

  // ... rest of the code remains unchanged

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
    const { promise, resolve, reject } = Promise.withResolvers();
    this.commit(req, opts, resolve, reject);
    return promise;
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

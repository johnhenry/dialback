// Non-Node stand-in for `./node-listener.mjs` (package.json `imports` ->
// `#node-listener`, `default` condition). Importing this must never pull a
// Node built-in into a browser/worker bundle, so it carries no imports.

/**
 * Hooks `Server` hands the listener so it never needs private state.
 * @typedef {object} ListenerHooks
 * @property {(request: Request) => Promise<Response>} fetch
 * @property {(connection: any) => Promise<any>} addConnection
 * @property {(connection: any) => void} removeConnection
 * @property {(level: number, ...args: any[]) => void} log
 * @property {(...args: any[]) => void} logError
 * @property {Record<string, number>} levels
 */

/**
 * @returns {{ listen: (port: number) => Promise<void>, close: () => Promise<void> }}
 */
export function createNodeListener() {
  return {
    async listen() {
      throw new Error(
        "Server#listen() needs Node.js (an HTTP/WebSocket listener). In a " +
          "browser or worker, drive the Server with server.fetch() and " +
          "server.addConnection() instead."
      );
    },
    async close() {},
  };
}

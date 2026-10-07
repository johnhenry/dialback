// Node-only HTTP + WebSocket listener for `Server#listen()`.
//
// This module is resolved through the `#node-listener` entry in package.json's
// `imports` map under the `node` condition; every other condition (browser
// bundlers, workers) gets `node-listener.browser.mjs`, which has no Node
// built-in or `ws`/`@johnhenry/webwire` imports. Keep all Node-only imports
// here, never in `server.mjs`, so `server.mjs` stays bundle-safe.
import http from "node:http";
import { WebSocketServer } from "ws";
import { toWebRequest, writeWebResponse } from "@johnhenry/webwire";

/**
 * @param {import('./node-listener.browser.mjs').ListenerHooks} hooks
 * @returns {{ listen: (port: number) => Promise<void>, close: () => Promise<void> }}
 */
export function createNodeListener({
  fetch,
  addConnection,
  removeConnection,
  log,
  logError,
  levels,
}) {
  /** @type {http.Server | null} */
  let httpServer = null;
  /** @type {WebSocketServer | null} */
  let wss = null;

  return {
    async listen(port) {
      httpServer = http.createServer(async (req, res) => {
        log(levels.DEBUG, "Received HTTP request:", req.method, req.url);

        let request;
        try {
          // This has to happen inside a try/catch of its own (rather than
          // relying on the outer try/catch below) so a malformed request can
          // never escape uncaught and hang the client. `hostHeaders` keeps
          // this proxy's original priority: `X-Forwarded-Host` (standard
          // reverse-proxy convention) before `Host`, so the agent sees the
          // URL the original client intended, not this proxy's own host:port.
          request = toWebRequest(req, { hostHeaders: ["x-forwarded-host", "host"] });
        } catch (error) {
          logError("Error constructing request:", error);
          res.writeHead(Number.isInteger(error?.status) ? error.status : 500);
          res.end("Internal Server Error");
          return;
        }

        try {
          const response = await fetch(request);
          await writeWebResponse(response, res, {
            onError: (err) => logError("Error streaming response body:", err),
          });
          log(levels.DEBUG, "Response sent to client");
        } catch (error) {
          logError("Error handling request:", error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal Server Error");
          } else {
            res.destroy(error);
          }
        }
      });

      wss = new WebSocketServer({ server: httpServer });

      wss.on("connection", (ws) => {
        log(levels.INFO, "New WebSocket connection established");
        addConnection(ws);
        ws.on("close", () => {
          log(levels.INFO, "WebSocket connection closed");
          removeConnection(ws);
        });
      });

      await new Promise((resolve) => {
        httpServer.listen(port, () => {
          log(levels.INFO, "Server listening on port", port);
          resolve();
        });
      });
    },

    async close() {
      log(levels.INFO, "Closing WebSocket server");
      await new Promise((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });

      log(levels.INFO, "Closing HTTP server");
      await new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      httpServer = null;
      wss = null;
    },
  };
}

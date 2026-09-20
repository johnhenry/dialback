import { Server } from "../index.mjs";

// A real deployment should set DIALBACK_SECRET to a strong, unguessable
// value shared out-of-band with each Agent; the fallback below is only for
// running this demo standalone.
const server = new Server(
  () => new Response("no responder", { status: 500 }), // TODO: can 'null' be used here? nothing?
  { secret: process.env.DIALBACK_SECRET ?? "demo-secret-change-me" }
);

// Single Endpoint
Deno.serve({ port: 8082 }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return server.fetch(req);
  }
  const { socket: connection, response } = Deno.upgradeWebSocket(req);
  server.addConnection(connection);
  connection.addEventListener("close", () => {
    server.removeConnection(connection);
  });
  return response;
});

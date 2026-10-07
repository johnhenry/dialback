// Server#close() in "bring your own listener" mode (#9).
import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Server, Agent } from "../index.mjs";

class FakeSocket extends EventEmitter {
  closed = false;
  bufferedAmount = 0;
  send() {}
  addEventListener(event, cb) { this.on(event, cb); }
  close() { this.closed = true; this.emit("close"); }
}

test("close() is a no-op for the listener in addConnection-only mode, and idempotent", async () => {
  const server = new Server(() => new Response("none", { status: 503 }), { secret: "s" });
  await server.close(); // nothing registered, never listened
  await server.close();
});

test("close() closes and unregisters registered connections", async () => {
  const server = new Server(() => new Response("none", { status: 503 }), { secret: "s" });
  const socket = new FakeSocket();
  await server.addConnection(socket);
  assert.ok(server.getConnectionByIndex(0));
  await server.close();
  assert.strictEqual(socket.closed, true);
  assert.strictEqual(server.getConnectionByIndex(0), undefined);
  assert.strictEqual(server.listening, false);
  await server.close(); // twice is fine
});

test("close() works with an external ws listener and a real agent", async () => {
  const server = new Server(undefined, { secret: "s" });
  const httpServer = createServer((req, res) => res.end("x"));
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => server.addConnection(ws));
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const { port } = httpServer.address();
  const agent = new Agent(`ws://127.0.0.1:${port}`, { secret: "s" });
  agent.serve(async () => new Response("hi"));
  const start = Date.now();
  while (!server.getConnectionByIndex(0)) {
    if (Date.now() - start > 5000) throw new Error("agent never registered");
    await new Promise((r) => setTimeout(r, 20));
  }
  await server.close();
  assert.strictEqual(server.getConnectionByIndex(0), undefined);
  await agent.close();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => httpServer.close(r));
});

test("close() still tears down the listener in listen() mode", async () => {
  const server = new Server(() => new Response("hello"), { secret: "s" });
  await server.listen(0);
  assert.strictEqual(server.listening, true);
  await server.close();
  assert.strictEqual(server.listening, false);
  await server.close();
});

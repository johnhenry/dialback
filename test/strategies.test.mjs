// Regression tests for Server's connection-management API
// (addConnection/removeConnection/removeConnectionById/removeConnectionByIndex/
// getConnectionById/getConnectionByIndex/setStrategy) and its agent-selection
// strategies ("first", "last", "random", "round-robin", "last-used",
// "most-recent"). None of this had any test coverage before, and the
// connection-management methods didn't exist as real implementations at all
// (server.mjs only had a bare `strategy` field set once in the constructor).
import { test } from "node:test";
import assert from "node:assert";
import { Server } from "../index.mjs";

/**
 * A minimal, correct stand-in for the `Connection` interface
 * (`send`/`addEventListener`/`close`) declared in types/types.d.ts — unlike
 * node.test.mjs's EventEmitter-based mock (which doesn't actually implement
 * `addEventListener`, so `doConnection()` silently fails against it), this
 * mock is wired up so `Server#addConnection` can register real message
 * listeners and this test can simulate agent traffic by calling `deliver()`.
 */
class MockConnection {
  constructor() {
    this.messageListeners = [];
    this.closed = false;
    this.bufferedAmount = 0;
    this.sent = [];
  }
  addEventListener(event, callback) {
    if (event === "message") this.messageListeners.push(callback);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  /** Parsed view of every message this mock connection has sent. */
  get sentMessages() {
    return this.sent.map((raw) => JSON.parse(raw));
  }
  get lastSentMessage() {
    const messages = this.sentMessages;
    return messages[messages.length - 1];
  }
}

/** Simulate an incoming WebSocket message on a mock connection. */
const deliver = (mockConnection, message) => {
  for (const callback of mockConnection.messageListeners) {
    callback({ data: JSON.stringify(message) });
  }
};

/** Simulate a full agent handshake so the connection gets a known agentId. */
const handshake = (mockConnection, agentId) => {
  deliver(mockConnection, { kind: "agent", agent: agentId });
};

/**
 * `deliver()` synchronously fires the "message" event listener, matching
 * real WebSocket behavior — but the server's receive loop consumes that
 * message through an async generator (`doConnection`'s `invertedAsyncIterator`),
 * so the actual dispatch (`#handleAgentMessage`) happens a few microtask
 * ticks later, not synchronously within `deliver()`. Tests that assert on
 * the *effects* of a delivered message must wait for that processing to
 * settle first; a macrotask tick reliably flushes any pending microtasks.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const makeRequest = (url = "http://test.com/") => new Request(url, { method: "GET" });

test("Server connection management", async (t) => {
  await t.test("addConnection registers a connection and getConnectionByIndex finds it", async () => {
    const server = new Server();
    const a = new MockConnection();
    await server.addConnection(a);
    assert.strictEqual(server.getConnectionByIndex(0), a);
    assert.strictEqual(server.getConnectionByIndex(1), undefined);
  });

  await t.test("getConnectionById resolves only after the agent handshake is processed", async () => {
    const server = new Server();
    const a = new MockConnection();
    await server.addConnection(a);
    assert.strictEqual(server.getConnectionById("agent-a"), undefined);
    handshake(a, "agent-a");
    await flush();
    assert.strictEqual(server.getConnectionById("agent-a"), a);
  });

  await t.test("removeConnection unregisters a connection", async () => {
    const server = new Server();
    const a = new MockConnection();
    const b = new MockConnection();
    await server.addConnection(a);
    await server.addConnection(b);
    server.removeConnection(a);
    assert.strictEqual(server.getConnectionByIndex(0), b);
    assert.strictEqual(server.getConnectionByIndex(1), undefined);
  });

  await t.test("removeConnectionById removes by handshake-registered agent id", async () => {
    const server = new Server();
    const a = new MockConnection();
    await server.addConnection(a);
    handshake(a, "agent-a");
    await flush();
    assert.strictEqual(server.getConnectionById("agent-a"), a);
    server.removeConnectionById("agent-a");
    assert.strictEqual(server.getConnectionById("agent-a"), undefined);
    assert.strictEqual(server.getConnectionByIndex(0), undefined);
  });

  await t.test("removeConnectionByIndex removes by position", async () => {
    const server = new Server();
    const a = new MockConnection();
    const b = new MockConnection();
    await server.addConnection(a);
    await server.addConnection(b);
    server.removeConnectionByIndex(0);
    assert.strictEqual(server.getConnectionByIndex(0), b);
  });

  await t.test("a request in flight is rejected if its connection is removed", async () => {
    const server = new Server();
    const a = new MockConnection();
    await server.addConnection(a);
    const promise = new Promise((resolve, reject) => {
      server.commit(makeRequest(), {}, resolve, reject);
    });
    server.removeConnection(a);
    await assert.rejects(promise);
  });

  await t.test("setStrategy validates against the declared strategy set", async () => {
    const server = new Server();
    assert.strictEqual(server.strategy, "first");
    server.setStrategy("random");
    assert.strictEqual(server.strategy, "random");
    assert.throws(() => server.setStrategy("not-a-real-strategy"));
    // Rejecting an invalid strategy shouldn't corrupt the previously-valid one.
    assert.strictEqual(server.strategy, "random");
  });

  await t.test("the strategy getter/setter is equivalent to setStrategy", async () => {
    const server = new Server();
    server.strategy = "round-robin";
    assert.strictEqual(server.strategy, "round-robin");
    assert.throws(() => {
      server.strategy = "bogus";
    });
  });

  await t.test("a mismatched secret handshake is rejected and the connection is dropped", async () => {
    const server = new Server(undefined, { secret: "correct-secret" });
    const a = new MockConnection();
    await server.addConnection(a);
    deliver(a, { kind: "agent", agent: "agent-a", secret: "wrong-secret" });
    await flush();
    assert.strictEqual(server.getConnectionById("agent-a"), undefined);
    assert.strictEqual(server.getConnectionByIndex(0), undefined);
    assert.ok(a.closed, "connection with a bad secret should be closed");
  });

  await t.test("a matching secret handshake is accepted", async () => {
    const server = new Server(undefined, { secret: "correct-secret" });
    const a = new MockConnection();
    await server.addConnection(a);
    deliver(a, { kind: "agent", agent: "agent-a", secret: "correct-secret" });
    await flush();
    assert.strictEqual(server.getConnectionById("agent-a"), a);
    assert.ok(!a.closed);
  });
});

test("Server agent-selection strategies", async (t) => {
  await t.test("first always routes to the first-connected agent", async () => {
    const server = new Server();
    server.setStrategy("first");
    const a = new MockConnection();
    const b = new MockConnection();
    const c = new MockConnection();
    for (const conn of [a, b, c]) await server.addConnection(conn);

    for (let i = 0; i < 3; i++) {
      server.commit(makeRequest(), {}, () => {}, () => {});
    }
    assert.strictEqual(a.sentMessages.length, 3);
    assert.strictEqual(b.sentMessages.length, 0);
    assert.strictEqual(c.sentMessages.length, 0);
  });

  await t.test("last always routes to the last-connected agent", async () => {
    const server = new Server();
    server.setStrategy("last");
    const a = new MockConnection();
    const b = new MockConnection();
    const c = new MockConnection();
    for (const conn of [a, b, c]) await server.addConnection(conn);

    server.commit(makeRequest(), {}, () => {}, () => {});
    assert.strictEqual(c.sentMessages.length, 1);
    assert.strictEqual(a.sentMessages.length, 0);
    assert.strictEqual(b.sentMessages.length, 0);
  });

  await t.test("round-robin cycles through every connected agent in order", async () => {
    const server = new Server();
    server.setStrategy("round-robin");
    const a = new MockConnection();
    const b = new MockConnection();
    const c = new MockConnection();
    for (const conn of [a, b, c]) await server.addConnection(conn);

    const order = [];
    for (let i = 0; i < 6; i++) {
      const before = [a, b, c].map((conn) => conn.sentMessages.length);
      server.commit(makeRequest(), {}, () => {}, () => {});
      const after = [a, b, c].map((conn) => conn.sentMessages.length);
      order.push(["a", "b", "c"][after.findIndex((n, idx) => n > before[idx])]);
    }
    assert.deepStrictEqual(order, ["a", "b", "c", "a", "b", "c"]);
  });

  await t.test("random distributes requests across connected agents", async () => {
    const server = new Server();
    server.setStrategy("random");
    const a = new MockConnection();
    const b = new MockConnection();
    await server.addConnection(a);
    await server.addConnection(b);

    for (let i = 0; i < 40; i++) {
      server.commit(makeRequest(), {}, () => {}, () => {});
    }
    // With 40 draws across 2 agents, the odds every draw lands on the same
    // agent are 2 * 0.5^40 — not a real source of flakiness in practice.
    assert.ok(a.sentMessages.length > 0, "agent a should receive at least one request");
    assert.ok(b.sentMessages.length > 0, "agent b should receive at least one request");
    assert.strictEqual(a.sentMessages.length + b.sentMessages.length, 40);
  });

  await t.test("most-recent routes to whichever agent connected most recently", async () => {
    const server = new Server();
    const a = new MockConnection();
    await server.addConnection(a);
    // Force a distinct connectedAt timestamp for the second connection —
    // Date.now() has ~1ms resolution and these are otherwise synchronous.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = new MockConnection();
    await server.addConnection(b);

    server.setStrategy("most-recent");
    server.commit(makeRequest(), {}, () => {}, () => {});
    assert.strictEqual(b.sentMessages.length, 1, "the more recently connected agent should be selected");
    assert.strictEqual(a.sentMessages.length, 0);
  });

  await t.test("last-used routes to whichever agent most recently completed a request/response cycle", async () => {
    const server = new Server();
    server.setStrategy("round-robin");
    const a = new MockConnection();
    const b = new MockConnection();
    await server.addConnection(a);
    await server.addConnection(b);

    // Round-robin: request 1 -> a (left dangling, never completes).
    server.commit(makeRequest(), {}, () => {}, () => {});
    assert.strictEqual(a.sentMessages.length, 1);
    // Round-robin: request 2 -> b. Complete b's cycle so it gets a
    // `lastUsedAt` timestamp, even though it is *not* first positionally.
    const bResponse = new Promise((resolve, reject) => {
      server.commit(makeRequest(), {}, resolve, reject);
    });
    assert.strictEqual(b.sentMessages.length, 1);
    const bRequestId = b.lastSentMessage.id;
    deliver(b, {
      kind: "response",
      id: bRequestId,
      payload: { headers: {}, statusText: "", status: 200, body: false },
    });
    await bResponse;

    // Now last-used should prefer b (completed a cycle) over a (still
    // positionally first, and would win under "first" or "round-robin").
    server.setStrategy("last-used");
    server.commit(makeRequest(), {}, () => {}, () => {});
    assert.strictEqual(b.sentMessages.length, 2, "b should receive the third request under last-used");
    assert.strictEqual(a.sentMessages.length, 1, "a should not receive any more requests");
  });

  await t.test("with no agents connected, commit() falls back to the default handler", async () => {
    const defaultResponse = new Response("fallback", { status: 200 });
    const server = new Server(() => defaultResponse);
    const response = await new Promise((resolve, reject) => {
      server.commit(makeRequest(), {}, resolve, reject);
    });
    assert.strictEqual(response, defaultResponse);
  });
});

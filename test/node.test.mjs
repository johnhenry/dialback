//node.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { Agent, Server } from "../index.mjs";
import {
  invertedAsyncIterator,
  KILLED,
} from "../util/invertedAsyncIterator.mjs";
import EventEmitter from "node:events";

// Mock WebSocket class
class MockWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    setTimeout(() => this.emit("open"), 0);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  static OPEN = 1;
  static CLOSED = 3;
}

// Override the WebSocket import in the Agent class
import * as agentModule from "../agent.mjs";
agentModule.default.prototype.createConnection = function (address, secret) {
  return Promise.resolve(new MockWebSocket(address));
};

test("Server", async (t) => {
  const server = new Server();
  assert.ok(server, "Server should be created");
});

test("Agent", async (t) => {
  const agent = new Agent("ws://localhost:8080"); // Provide a dummy URL
  assert.ok(agent, "Agent should be created");

  // Close the agent to prevent any lingering connections
  await new Promise((resolve) => {
    agent.on("close", resolve);
    agent.close();
  });
});

test("invertedAsyncIterator", async (t) => {
  const [generator, enqueue, toggle] = invertedAsyncIterator();

  // Enqueue items in normal order
  enqueue(1);
  enqueue(2);
  enqueue(3);

  const result = [];
  try {
    for await (const item of generator()) {
      result.push(item);
      if (result.length === 3) {
        toggle(); // End the iterator after we've received all items
      }
    }
  } catch (error) {
    assert.strictEqual(error, KILLED, "Iterator should be killed after toggle");
  }

  assert.deepStrictEqual(
    result,
    [1, 2, 3],
    "Inverted async iterator should maintain the order of enqueued items"
  );
});

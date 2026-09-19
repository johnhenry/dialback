// deno.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { Server } from "../server.mjs";
import { Agent } from "../agent.mjs";
import {
  invertedAsyncIterator,
  KILLED,
} from "../util/invertedAsyncIterator.mjs";
// Mock WebSocket class
class MockWebSocket extends EventTarget {
  constructor(url: string) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }

  url: string;
  readyState: number;

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  static OPEN = 1;
  static CLOSED = 3;
}

// Override the WebSocket import in the Agent class
// Note: This might need adjustment based on how Deno handles imports
(Agent.prototype as any).createConnection = function (
  address: string,
  secret: string
) {
  return Promise.resolve(new MockWebSocket(address));
};

Deno.test("Server", async () => {
  const server = new Server(undefined, { allowUnauthenticatedAgents: true });
  assertEquals(typeof server, "object", "Server should be created");
});

Deno.test(
  "Agent",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const agent = new Agent("ws://localhost:8080"); // Provide a dummy URL
    assertEquals(typeof agent, "object", "Agent should be created");
    agent.emit("close", new Event("close")); // Simulate the WebSocket connection
    // Close the agent to prevent any lingering connections
    await new Promise<void>((resolve) => {
      agent.on("close", () => resolve());
      agent.close();
    });
  }
);

Deno.test("invertedAsyncIterator", async () => {
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
    assertEquals(error, KILLED, "Iterator should be killed after toggle");
  }

  assertEquals(
    result,
    [1, 2, 3],
    "Inverted async iterator should maintain the order of enqueued items"
  );
});

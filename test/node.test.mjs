import { test } from "node:test";
import assert from "node:assert";
import { Agent, Server } from "../index.mjs";
import { invertedAsyncIterator, KILLED } from "../util/invertedAsyncIterator.mjs";
import EventEmitter from "events";

// Mock WebSocket class
class MockWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    setTimeout(() => this.emit('open'), 0);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }

  send(data) {
    this.emit('message', { data });
  }

  static OPEN = 1;
  static CLOSED = 3;
}

// Override the WebSocket import in the Agent class
import * as agentModule from "../agent.mjs";
agentModule.default.prototype.createConnection = function(address, secret) {
  return Promise.resolve(new MockWebSocket(address));
};

test("Server", async (t) => {
  await t.test("createServer", async (t) => {
    const server = new Server();
    assert.ok(server, "Server should be created");
    assert.strictEqual(typeof server.listen, "function", "Server should have a listen method");
    assert.strictEqual(typeof server.close, "function", "Server should have a close method");
  });

  await t.test("Server listen and close", async (t) => {
    const server = new Server();
    await server.listen(8080);
    assert.ok(server.listening, "Server should be listening");
    await server.close();
    assert.ok(!server.listening, "Server should not be listening after close");
  });
});

test("Agent", async (t) => {
  await t.test("Agent creation and basic functionality", async (t) => {
    const agent = new Agent("ws://localhost:8080");
    assert.ok(agent, "Agent should be created");
    assert.strictEqual(typeof agent.serve, "function", "Agent should have a serve method");
    assert.strictEqual(typeof agent.close, "function", "Agent should have a close method");
    
    // Test close method
    await new Promise(resolve => {
      agent.on('close', () => {
        assert.ok(true, "Close event should be emitted");
        resolve();
      });
      agent.close();
    });
  });

  await t.test("Agent connection handling", async (t) => {
    const agent = new Agent("ws://localhost:8080");
    const connection = await agent.connection;
    assert.ok(connection instanceof MockWebSocket, "Agent should create a WebSocket connection");

    // Test connection event handling
    await new Promise(resolve => {
      connection.emit('message', { data: JSON.stringify({ kind: "test" }) });
      setTimeout(() => {
        // Add assertions here to check if the message was handled correctly
        // This depends on the specific implementation of your Agent class
        resolve();
      }, 100);
    });
  });

  await t.test("Agent serve method", async (t) => {
    const agent = new Agent("ws://localhost:8080");
    const testHandler = async (request, options) => {
      assert.strictEqual(request.url, "http://test.com", "Request URL should match");
      assert.strictEqual(request.method, "GET", "Request method should match");
      return new Response("Test response", { status: 200 });
    };

    agent.serve(testHandler);

    // Simulate a request
    const connection = await agent.connection;
    connection.emit('message', {
      data: JSON.stringify({
        kind: "request",
        id: "test-id",
        payload: {
          url: "http://test.com",
          method: "GET",
          headers: {}
        }
      })
    });

    // Wait for the response to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Add more specific assertions based on your Agent implementation
    // For example, you could check if the response was sent correctly
  });

  await t.test("Agent error handling", async (t) => {
    const agent = new Agent("ws://localhost:8080");
    const errorHandler = async (request, options) => {
      throw new Error("Test error");
    };

    agent.serve(errorHandler);

    // Simulate a request that will cause an error
    const connection = await agent.connection;
    connection.emit('message', {
      data: JSON.stringify({
        kind: "request",
        id: "error-test-id",
        payload: {
          url: "http://test.com",
          method: "GET",
          headers: {}
        }
      })
    });

    // Wait for the error to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Add assertions to check if the error was handled correctly
    // This depends on how your Agent class handles errors
  });
});

test("invertedAsyncIterator", async (t) => {
  await t.test("Basic functionality", async (t) => {
    const [generator, enqueue, toggle] = invertedAsyncIterator();
    
    enqueue(1);
    enqueue(2);
    enqueue(3);
    
    const result = [];
    try {
      for await (const item of generator()) {
        result.push(item);
        if (result.length === 3) {
          toggle();
        }
      }
    } catch (error) {
      assert.strictEqual(error, KILLED, "Iterator should be killed after toggle");
    }

    assert.deepStrictEqual(result, [1, 2, 3], "Inverted async iterator should maintain the order of enqueued items");
  });

  await t.test("Empty iterator", async (t) => {
    const [generator, enqueue, toggle] = invertedAsyncIterator();
    
    toggle(); // End the iterator immediately
    
    const result = [];
    try {
      for await (const item of generator()) {
        result.push(item);
      }
    } catch (error) {
      assert.strictEqual(error, KILLED, "Empty iterator should be killed immediately");
    }

    assert.deepStrictEqual(result, [], "Empty iterator should not yield any items");
  });

  await t.test("Async enqueue", async (t) => {
    const [generator, enqueue, toggle] = invertedAsyncIterator();
    
    const queue = [];
    const dequeue = () => {
      return new Promise(resolve => {
        if (queue.length > 0) {
          resolve(queue.shift());
        } else {
          queue.push(resolve);
        }
      });
    };

    const enqueueAsync = (value) => {
      if (queue.length > 0 && typeof queue[0] === 'function') {
        queue.shift()(value);
      } else {
        queue.push(value);
      }
      enqueue(value);
    };

    const iteratorPromise = (async () => {
      const result = [];
      try {
        for await (const item of generator()) {
          result.push(item);
          if (result.length === 3) {
            toggle();
          }
          await dequeue(); // Wait for the next item to be enqueued
        }
      } catch (error) {
        assert.strictEqual(error, KILLED, "Iterator should be killed after toggle");
      }
      return result;
    })();

    // Enqueue items asynchronously
    setTimeout(() => enqueueAsync(1), 10);
    setTimeout(() => enqueueAsync(2), 20);
    setTimeout(() => enqueueAsync(3), 30);

    const result = await iteratorPromise;
    assert.deepStrictEqual(result, [1, 2, 3], "Async enqueue should work correctly");
  });
});

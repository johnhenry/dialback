import { test } from "node:test";
import assert from "node:assert";
import { Agent, Server } from "../index.mjs";
import WebSocket from "ws";
import http from "http";

test("Integration tests", async (t) => {
  let server;
  let agent;

  t.beforeEach(async () => {
    server = new Server();
    await server.listen(8080);
    agent = new Agent("ws://localhost:8080");
  });

  t.afterEach(async () => {
    await agent.close();
    await server.close();
  });

  await t.test("Agent can connect to Server", async (t) => {
    const connection = await agent.connection;
    assert.ok(connection instanceof WebSocket, "Agent should connect to the server");
    assert.strictEqual(connection.readyState, WebSocket.OPEN, "Connection should be open");
  });

  await t.test("Server can handle requests through Agent", async (t) => {
    const testHandler = async (request, options) => {
      assert.strictEqual(request.url, "http://test.com", "Request URL should match");
      assert.strictEqual(request.method, "GET", "Request method should match");
      return new Response("Test response", { status: 200 });
    };

    agent.serve(testHandler);

    const response = await new Promise((resolve) => {
      const req = http.request(
        "http://localhost:8080",
        {
          method: "GET",
          headers: {
            "X-Forwarded-Host": "test.com",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode, data });
          });
        }
      );
      req.end();
    });

    assert.strictEqual(response.status, 200, "Response status should be 200");
    assert.strictEqual(response.data, "Test response", "Response data should match");
  });

  await t.test("Server can handle multiple concurrent requests", async (t) => {
    const testHandler = async (request, options) => {
      const delay = parseInt(request.url.split("=")[1]);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response(`Response after ${delay}ms`);
    };

    agent.serve(testHandler);

    const makeRequest = (delay) => {
      return new Promise((resolve) => {
        const req = http.request(
          `http://localhost:8080?delay=${delay}`,
          {
            method: "GET",
            headers: {
              "X-Forwarded-Host": "test.com",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              resolve({ status: res.statusCode, data });
            });
          }
        );
        req.end();
      });
    };

    const responses = await Promise.all([
      makeRequest(100),
      makeRequest(50),
      makeRequest(150),
    ]);

    assert.strictEqual(responses.length, 3, "Should receive 3 responses");
    responses.forEach((response, index) => {
      assert.strictEqual(response.status, 200, `Response ${index + 1} status should be 200`);
    });
    assert.strictEqual(responses[0].data, "Response after 100ms", "First response should be correct");
    assert.strictEqual(responses[1].data, "Response after 50ms", "Second response should be correct");
    assert.strictEqual(responses[2].data, "Response after 150ms", "Third response should be correct");
  });

  await t.test("Server and Agent can handle large payload", async (t) => {
    const largePayload = "x".repeat(1024 * 1024); // 1MB of data

    const testHandler = async (request, options) => {
      const body = await request.text();
      assert.strictEqual(body.length, largePayload.length, "Request body should match large payload size");
      return new Response(body);
    };

    agent.serve(testHandler);

    const response = await new Promise((resolve) => {
      const req = http.request(
        "http://localhost:8080",
        {
          method: "POST",
          headers: {
            "X-Forwarded-Host": "test.com",
            "Content-Type": "text/plain",
            "Content-Length": largePayload.length,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode, data });
          });
        }
      );
      req.write(largePayload);
      req.end();
    });

    assert.strictEqual(response.status, 200, "Response status should be 200");
    assert.strictEqual(response.data.length, largePayload.length, "Response data should match large payload size");
  });
});
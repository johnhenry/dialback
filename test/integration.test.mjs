import { test } from "node:test";
import assert from "node:assert";
import { Agent, Server } from "../index.mjs";
import WebSocket from "ws";
import http from "http";

let port = 8080;

test("Integration tests", async (t) => {
  let server;
  let agent;
  let currentPort;

  t.beforeEach(async () => {
    currentPort = port++;
    console.log(`Setting up server and agent on port ${currentPort}...`);
    server = new Server();
    await server.listen(currentPort);
    agent = new Agent(`ws://localhost:${currentPort}`);
    // Wait for the agent's WebSocket handshake to actually register with
    // the server before returning. Without this, a subtest that fires HTTP
    // requests immediately after `beforeEach` can race the connection: if
    // the first request's `commit()` runs before the agent is registered,
    // the server correctly falls back to its (bodyless) default handler
    // instead of routing to the not-yet-connected agent.
    await agent.connection;
    console.log("Server and agent set up complete.");
  });

  t.afterEach(async () => {
    console.log("Cleaning up...");
    if (agent) {
      await agent.close().catch(console.error);
    }
    if (server) {
      await server.close().catch(console.error);
    }
    console.log("Cleanup complete.");
  });

  await t.test("Agent can connect to Server", async (t) => {
    console.log("Starting 'Agent can connect to Server' test...");
    const connection = await agent.connection;
    assert.ok(
      connection instanceof WebSocket,
      "Agent should connect to the server"
    );
    assert.strictEqual(
      connection.readyState,
      WebSocket.OPEN,
      "Connection should be open"
    );
    console.log("'Agent can connect to Server' test completed.");
  });

  await t.test("Server can handle requests through Agent", async (t) => {
    console.log("Starting 'Server can handle requests through Agent' test...");
    const testHandler = async (request, options) => {
      console.log("Test handler called with request:", request.url);
      assert.strictEqual(
        request.url,
        // The Fetch spec's URL serializer always includes a path, so a
        // root-path Request's `.url` normalizes to a trailing slash (this
        // is standard `Request`/`URL` behavior, not proxy-specific).
        "http://test.com/",
        "Request URL should match"
      );
      assert.strictEqual(request.method, "GET", "Request method should match");
      return new Response("Test response", { status: 200 });
    };

    agent.serve(testHandler);

    try {
      const response = await new Promise((resolve, reject) => {
        console.log("Sending HTTP request to server...");
        const req = http.request(
          `http://localhost:${currentPort}`,
          {
            method: "GET",
            headers: {
              "X-Forwarded-Host": "test.com",
            },
          },
          (res) => {
            console.log("Received response from server");
            let data = "";
            res.on("data", (chunk) => {
              console.log("Received data chunk:", chunk.toString());
              data += chunk;
            });
            res.on("end", () => {
              console.log("Response data:", data);
              resolve({ status: res.statusCode, data });
            });
          }
        );
        req.on("error", (error) => {
          console.error("Error in HTTP request:", error);
          reject(error);
        });
        req.end();
      });

      console.log("Asserting response...");
      assert.strictEqual(response.status, 200, "Response status should be 200");
      assert.strictEqual(
        response.data,
        "Test response",
        "Response data should match"
      );
      console.log("'Server can handle requests through Agent' test completed.");
    } catch (error) {
      console.error("Error in test:", error);
      throw error;
    }
  });

  await t.test("Server can handle multiple concurrent requests", async (t) => {
    console.log("Starting 'Server can handle multiple concurrent requests' test...");
    const testHandler = async (request, options) => {
      const delay = parseInt(request.url.split("=")[1]);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response(`Response after ${delay}ms`);
    };

    agent.serve(testHandler);

    const makeRequest = (delay) => {
      return new Promise((resolve, reject) => {
        console.log(`Sending request with ${delay}ms delay...`);
        const req = http.request(
          `http://localhost:${currentPort}?delay=${delay}`,
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
              console.log(`Received response for ${delay}ms delay request`);
              resolve({ status: res.statusCode, data });
            });
          }
        );
        req.on("error", (error) => {
          console.error(`Error in request with ${delay}ms delay:`, error);
          reject(error);
        });
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
      assert.strictEqual(
        response.status,
        200,
        `Response ${index + 1} status should be 200`
      );
    });
    assert.strictEqual(
      responses[0].data,
      "Response after 100ms",
      "First response should be correct"
    );
    assert.strictEqual(
      responses[1].data,
      "Response after 50ms",
      "Second response should be correct"
    );
    assert.strictEqual(
      responses[2].data,
      "Response after 150ms",
      "Third response should be correct"
    );
    console.log("'Server can handle multiple concurrent requests' test completed.");
  });

  await t.test("Server and Agent can handle large payload", async (t) => {
    console.log("Starting 'Server and Agent can handle large payload' test...");
    const largePayload = "x".repeat(1024 * 1024); // 1MB of data

    const testHandler = async (request, options) => {
      console.log("Large payload handler called");
      const body = await request.text();
      assert.strictEqual(
        body.length,
        largePayload.length,
        "Request body should match large payload size"
      );
      return new Response(body);
    };

    agent.serve(testHandler);

    const response = await new Promise((resolve, reject) => {
      console.log("Sending large payload request...");
      const req = http.request(
        `http://localhost:${currentPort}`,
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
            console.log("Received response for large payload request");
            resolve({ status: res.statusCode, data });
          });
        }
      );
      req.on("error", (error) => {
        console.error("Error in large payload request:", error);
        reject(error);
      });
      req.write(largePayload);
      req.end();
    });

    assert.strictEqual(response.status, 200, "Response status should be 200");
    assert.strictEqual(
      response.data.length,
      largePayload.length,
      "Response data should match large payload size"
    );
    console.log("'Server and Agent can handle large payload' test completed.");
  });
});

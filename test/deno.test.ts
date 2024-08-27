import { assertEquals, assertRejects } from "https://deno.land/std/testing/asserts.ts";
import { Server } from '../server.mjs';
import { Agent } from '../agent.mjs';
import { invertedAsyncIterator } from '../util/invertedAsyncIterator.mjs';
import { invertedPromise } from '../util/invertedPromise.mjs';

Deno.test("Server", () => {
  const defaultHandler = () => new Response("default handler", { status: 404 });
  const server = new Server(defaultHandler);
  assertEquals(typeof server, "object", "Server should be created");
  // Add more specific tests for server functionality
});

Deno.test("Agent", () => {
  const address = "ws://localhost:8080";
  const options = {
    reconnect: 1000,
    log: 2,
    abort: () => new Response("aborted", { status: 500 }),
    secret: "test-secret"
  };
  const agent = new Agent(address, options);
  assertEquals(typeof agent, "object", "Agent should be created");
  // Add more specific tests for agent functionality
});

Deno.test("invertedAsyncIterator", async () => {
  const asyncIterable = {
    async *[Symbol.asyncIterator]() {
      yield 1;
      yield 2;
      yield 3;
    }
  };

  const inverted = invertedAsyncIterator(asyncIterable);
  const result = [];
  for await (const item of inverted) {
    result.push(item);
  }

  assertEquals(result, [3, 2, 1], "Inverted async iterator should reverse the order");
});

Deno.test("invertedPromise", async () => {
  const promise = Promise.resolve("test");
  const inverted = invertedPromise(promise);

  await assertRejects(
    () => inverted,
    Error,
    "test",
    "Inverted promise should reject with the resolved value"
  );
});
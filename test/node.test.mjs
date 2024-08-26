import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../server.mjs';
import { createAgent } from '../agent.mjs';
import { invertedAsyncIterator } from '../util/invertedAsyncIterator.mjs';
import { invertedPromise } from '../util/invertedPromise.mjs';

test('createServer', async (t) => {
  const server = await createServer();
  assert.ok(server, 'Server should be created');
  // Add more specific tests for server functionality
});

test('createAgent', async (t) => {
  const agent = await createAgent();
  assert.ok(agent, 'Agent should be created');
  // Add more specific tests for agent functionality
});

test('invertedAsyncIterator', async (t) => {
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

  assert.deepStrictEqual(result, [3, 2, 1], 'Inverted async iterator should reverse the order');
});

test('invertedPromise', async (t) => {
  const promise = Promise.resolve('test');
  const inverted = invertedPromise(promise);

  assert.rejects(inverted, 'test', 'Inverted promise should reject with the resolved value');
});
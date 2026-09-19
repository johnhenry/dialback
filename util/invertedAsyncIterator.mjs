/** @type {symbol} */
const KILLED = Symbol.for("KILLED_INVERTED_ASYNC_ITERATOR");

/** @type {import('../types/types.d.ts').bufferOverRunStrategies} */
const bufferOverRunStrategies = {
  ERROR: "error",
  DROP: "drop",
  SHIFT: "shift",
  DIE: "die",
};

/** @type {Set<import('../types/types.d.ts').BufferOverRunStrategy>} */
const bufferOverRunStrategiesValuesSet = new Set(
  Object.values(bufferOverRunStrategies)
);

/**
 * @template T
 * @param {number} [bufferSize]
 * @param {import('../types/types.d.ts').BufferOverRunStrategy} [bufferOverrunStrategy]
 * @returns {[
 *   () => AsyncGenerator<T, void, unknown>,
 *   (data: T) => T,
 *   () => void,
 *   () => T | undefined
 * ]}
 */
const invertedAsyncIterator = (
  bufferSize = -1,
  bufferOverrunStrategy = bufferOverRunStrategies.ERROR
) => {
  if (!bufferOverRunStrategiesValuesSet.has(bufferOverrunStrategy)) {
    throw new Error(`Invalid bufferOverrunStrategy: ${bufferOverrunStrategy}`);
  }
  /** @type {T[]} */
  let buffer = [];
  let killed = false;
  /** @type {Promise<T> | undefined} */
  let promise;
  /** @type {((value: T) => void) | undefined} */
  let resolve;
  const generator = async function* () {
    while (!killed) {
      if (buffer.length) {
        yield buffer.shift();
      } else {
        // Promise.withResolvers() is Node 22+ only -- this package's
        // engines range goes down to 14.0.0, and real CI (Node 18/20)
        // confirmed the failure: a TypeError here, not a hang, but still a
        // real break for every consumer of this generator on those
        // versions. Portable manual-executor equivalent.
        promise = new Promise((res) => {
          resolve = res;
        });
        yield await promise;
      }
    }
    throw KILLED;
  };
  const enqueue = (data) => {
    if (resolve) {
      // Claim (and clear) the pending resolver before calling it. If two
      // `enqueue()` calls happen synchronously back-to-back — e.g. several
      // WebSocket messages arriving in the same tick — the generator won't
      // get a chance to run its microtask continuation and install a fresh
      // `resolve` between them. Without clearing it here, the second call
      // would invoke the same (already-settled) resolver again, which is a
      // silent no-op on an already-resolved Promise: the second message
      // would be dropped instead of buffered, and any consumer awaiting a
      // later message would hang forever waiting for data that already
      // arrived and was discarded.
      const resolvePending = resolve;
      resolve = undefined;
      resolvePending(data);
    } else if (bufferSize < 0) {
      buffer.push(data);
    } else if (buffer.length === bufferSize) {
      // NOTE: im pretty sure that `buffer.length` can never exceed `bufferSize` as we only increase it in this function... pretty sure...
      switch (bufferOverrunStrategy) {
        case bufferOverRunStrategies.DROP:
          // do nothing with incoming data
          break;
        case bufferOverRunStrategies.DIE:
          killed = true;
          break;
        case bufferOverRunStrategies.SHIFT:
          buffer.shift();
          buffer.push(data);
          break;
        case bufferOverRunStrategies.ERROR:
        default:
          throw new Error(
            `Buffer overrun: ${bufferSize}. Cannot enque: ${data}`
          );
      }
    } else {
      buffer.push(data);
    }
    return data;
  };
  const toggle = () => {
    killed = !killed;
  };
  const pop = () => {
    return buffer.pop();
  };
  return [generator, enqueue, toggle, pop];
};

export { KILLED, invertedAsyncIterator, bufferOverRunStrategies };
export default invertedAsyncIterator;

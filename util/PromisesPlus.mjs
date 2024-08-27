export {
  KILLED,
  invertedAsyncIterator,
  bufferOverRunStrategies,
} from "./invertedAsyncIterator.mjs";

/**
 * @template T
 * @returns {{ promise: Promise<T>, resolve: (value: T) => void, reject: (reason?: any) => void }}
 */
const withResolvers = () => {
  return Promise.withResolvers();
};

/**
 * @template T
 * @param {number} [ms]
 * @param {{ value?: T, signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
const resolveAfter = (
  ms = undefined,
  { value = undefined, signal = undefined } = {}
) => {
  return new Promise((resolve, reject) => {
    const rej = (e) => {
      signal.removeEventListener("abort", rej);
      reject(e);
    };
    if (signal) {
      signal.addEventListener("abort", rej);
    }
    setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", rej);
      }
      resolve(value);
    }, ms);
  });
};

export { withResolvers, resolveAfter };

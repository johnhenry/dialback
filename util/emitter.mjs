// Minimal stand-in for `node:events`' EventEmitter, used outside Node via the
// `#events` entry in package.json `imports` (the `node` condition resolves to
// the real `node:events`, so Node and Deno behaviour is unchanged). Covers the
// surface dialback uses -- on/addListener/once/off/removeListener/emit/
// removeAllListeners/listenerCount -- including Node's rule that emitting
// "error" with no listener throws.
export default class Emitter {
  #listeners = new Map();

  on(event, fn) {
    const list = this.#listeners.get(event);
    if (list) list.push(fn);
    else this.#listeners.set(event, [fn]);
    return this;
  }

  addListener(event, fn) {
    return this.on(event, fn);
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      return fn.apply(this, args);
    };
    wrapper.listener = fn;
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const list = this.#listeners.get(event);
    if (!list) return this;
    const index = list.findIndex((l) => l === fn || l.listener === fn);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this.#listeners.delete(event);
    return this;
  }

  removeListener(event, fn) {
    return this.off(event, fn);
  }

  removeAllListeners(event) {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  listenerCount(event) {
    return this.#listeners.get(event)?.length ?? 0;
  }

  emit(event, ...args) {
    const list = this.#listeners.get(event);
    if (!list || list.length === 0) {
      if (event === "error") {
        throw args[0] instanceof Error
          ? args[0]
          : new Error(`Unhandled error. (${String(args[0])})`);
      }
      return false;
    }
    for (const fn of [...list]) fn.apply(this, args);
    return true;
  }
}

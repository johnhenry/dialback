import EventEmitter from "node:events";
import { encodeFrame, FrameReader } from "./framing.mjs";

/**
 * Wraps a `@johnhenry/browsermesh-netway` `StreamSocket` (a byte-chunk
 * stream: `read()`/`write()`/`close()`, no message boundaries, no
 * `bufferedAmount`) as a `dialback` `Connection` -- the same shape the `ws`
 * package's `WebSocket` satisfies today.
 *
 * `dialback` uses two overlapping APIs against a `Connection` depending on
 * which file is looking at it:
 *  - `util/connection.mjs`'s `doConnection()` uses the DOM style:
 *    `.send(data)` / `.addEventListener("message", cb)` where `cb` receives
 *    `{ data: string }`.
 *  - `agent.mjs` additionally uses the EventEmitter style directly on the
 *    raw connection: `.on("open", cb)` / `.on("close", cb)`, plus polls
 *    `.bufferedAmount` for backpressure.
 * The `ws` package's `WebSocket` happens to implement both simultaneously,
 * which is why the existing code works unmodified against it. This class
 * does the same: it extends `node:events`' `EventEmitter` (free
 * `.on()`/`.emit()`) and adds `.addEventListener()` as a thin alias emitting
 * the same events, so both call sites work against the same object.
 *
 * Framing: every message is newline-delimited JSON over the raw byte
 * stream -- see `framing.mjs` for why that's a safe, simple choice here.
 *
 * `bufferedAmount`: `StreamSocket` has no queue-depth or in-flight-byte
 * introspection. `write()` either enqueues successfully or throws
 * `SocketClosedError` once the peer's `AsyncBuffer` has already exceeded its
 * `highWaterMark` -- there is no partial/in-between signal to report, only
 * "fine" or "already too late". This class always reports `0`. That means
 * `agent.mjs`'s and `server.mjs`'s `while (connection.bufferedAmount > N) {
 * await sleep }` backpressure-wait loops never actually block on this
 * transport; writes are attempted eagerly and only fail (loudly, via the
 * `"error"` event) once the peer is already overwhelmed. This is a
 * deliberate, documented simplification given the layer below genuinely has
 * no graduated backpressure signal to expose -- not a pretend measurement.
 */
export class StreamSocketConnection extends EventEmitter {
  /** @type {import('@johnhenry/browsermesh-netway').StreamSocket} */
  #socket;
  /** @type {FrameReader} */
  #reader;
  #closed = false;

  /**
   * @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket
   * @param {{ reader?: FrameReader }} [options] `reader`, when given, is an
   *   existing `FrameReader` for this socket (typically handed over from the
   *   identity handshake in `handshake.mjs`) so any bytes already read off
   *   the socket -- and any buffered partial frame -- carry forward instead
   *   of being silently dropped.
   */
  constructor(socket, { reader } = {}) {
    super();
    this.#socket = socket;
    this.#reader = reader || new FrameReader(socket);
    this.#runReadLoop();
  }

  async #runReadLoop() {
    try {
      while (true) {
        const frame = await this.#reader.next();
        if (frame === null) {
          break; // EOF: peer closed (or our own #close() closed our inbound side).
        }
        this.emit("message", { data: frame });
      }
    } catch (error) {
      this.emit("error", error);
    } finally {
      this.#finishClose();
    }
  }

  #finishClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }

  /**
   * DOM-`WebSocket`-shaped send: fire-and-forget, matching `doConnection()`,
   * which already calls `JSON.stringify()` before handing `send()` a plain
   * string. A non-string is stringified defensively for any other caller.
   *
   * `StreamSocket#write()` is async and can reject (`SocketClosedError`) if
   * the peer's buffer has overflowed; since `.send()` itself must stay
   * synchronous/void to match the `Connection` interface, a write failure is
   * surfaced via the `"error"` event (and the connection is torn down)
   * rather than thrown back at the caller or silently swallowed.
   * @param {any} data
   */
  send(data) {
    if (this.#closed) return;
    const jsonString = typeof data === "string" ? data : JSON.stringify(data);
    this.#socket.write(encodeFrame(jsonString)).catch((error) => {
      this.emit("error", error);
      this.#finishClose();
    });
  }

  /**
   * DOM-`WebSocket`-shaped listener registration, implemented as a thin
   * alias over `EventEmitter#on()` so both `.addEventListener()` and `.on()`
   * observe the same `"message"`/`"open"`/`"close"`/`"error"` events.
   * @param {string} event
   * @param {(event: any) => void} callback
   */
  addEventListener(event, callback) {
    this.on(event, callback);
  }

  /** @param {string} event @param {(event: any) => void} callback */
  removeEventListener(event, callback) {
    this.off(event, callback);
  }

  /**
   * Closes the underlying `StreamSocket` in both directions. This signals
   * EOF to the peer *and* unblocks this side's own read loop (a `read()`
   * blocked on the local inbound buffer resolves with `null` once that
   * buffer is closed), so `"close"` fires promptly on this side too.
   */
  close() {
    if (this.#closed) return;
    this.#socket.close().catch(() => {
      // #socket.close() is documented as a no-op on an already-closed
      // socket; nothing meaningful to do with a rejection here beyond not
      // crashing the caller.
    });
  }

  /** Always `0` -- see the class-level doc comment for why. */
  get bufferedAmount() {
    return 0;
  }
}

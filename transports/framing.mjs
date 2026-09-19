/**
 * Newline-delimited JSON framing over a raw byte stream.
 *
 * `dialback`'s wire protocol (see `util/connection.mjs`'s `doConnection()`) is
 * discrete JSON messages: `connection.send(JSON.stringify(x))` on the way
 * out, `JSON.parse(event.data)` on a per-message `"message"` event on the
 * way in. `StreamSocket` (from `@johnhenry/browsermesh-netway`) has no such
 * boundaries -- `read()`/`write()` move raw `Uint8Array` chunks with no
 * guarantee that one `write()` call arrives as one `read()` call on the
 * other side.
 *
 * Newline-delimited JSON is the simplest correct framing here because every
 * frame this module ever encodes is the *output* of `JSON.stringify()`
 * (either directly, via `doConnection`'s `send`, or via the handshake
 * messages in `handshake.mjs`) -- and `JSON.stringify` always escapes a
 * literal newline inside a string value as the two characters `\` `n`, never
 * emitting a raw `0x0A` byte. So a raw `0x0A` byte on the wire can only ever
 * be *our* frame delimiter, never message content, with zero extra
 * escaping work needed on top of what `JSON.stringify` already does.
 *
 * @module framing
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a single already-serialized JSON string as a newline-terminated
 * UTF-8 frame ready to `write()` to a `StreamSocket`.
 *
 * @param {string} jsonString
 * @returns {Uint8Array}
 */
export function encodeFrame(jsonString) {
  if (typeof jsonString !== "string") {
    throw new TypeError(
      "encodeFrame expects a string (an already-JSON.stringify'd message)"
    );
  }
  return textEncoder.encode(jsonString + "\n");
}

/**
 * Stateful newline-delimited-frame decoder. Feed it raw chunks as they
 * arrive from `StreamSocket#read()`; it returns however many complete
 * frames (0, 1, or many) that chunk completed, buffering any trailing
 * partial frame internally until the rest of it arrives.
 *
 * Handles all three ways a chunk can fail to line up with message
 * boundaries: a chunk containing a partial message, a chunk containing
 * multiple messages, and a message split across two or more chunks.
 */
export class FrameDecoder {
  /** @type {Uint8Array} */
  #buffer = new Uint8Array(0);

  /**
   * @param {Uint8Array} chunk
   * @returns {string[]} Zero or more complete, decoded JSON strings.
   */
  push(chunk) {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);

    const frames = [];
    let start = 0;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] === 0x0a) {
        frames.push(textDecoder.decode(merged.subarray(start, i)));
        start = i + 1;
      }
    }
    // Only the unprocessed remainder (at most one partial frame's worth) is
    // retained -- this does not re-scan or re-copy previously-decoded data
    // on the next push, so cost is proportional to new bytes, not total
    // bytes ever seen.
    this.#buffer = merged.subarray(start);
    return frames;
  }
}

/**
 * Pulls one decoded frame at a time off a `StreamSocket`, internally
 * batching via `FrameDecoder` when a single `read()` chunk contains more
 * than one frame.
 *
 * This is the shared primitive behind both the identity handshake
 * (`handshake.mjs`) and `StreamSocketConnection`'s message loop. The
 * handshake reads a couple of frames directly off the socket *before* any
 * `StreamSocketConnection` exists; if the peer pipelined its first
 * application-layer message into the same `write()`/chunk as the final
 * handshake frame, that extra frame (and the decoder's internal partial-
 * frame buffer) must not be discarded when handshake code hands the socket
 * off to `StreamSocketConnection`. Passing the *same* `FrameReader`
 * instance to both keeps that state intact across the handoff.
 */
export class FrameReader {
  #socket;
  #decoder;
  /** @type {string[]} */
  #pending = [];
  #eof = false;

  /**
   * @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket
   * @param {FrameDecoder} [decoder]
   */
  constructor(socket, decoder = new FrameDecoder()) {
    this.#socket = socket;
    this.#decoder = decoder;
  }

  /** The underlying `FrameDecoder`, exposed so its buffered state can be
   * threaded through to a later `FrameReader` over the same socket. */
  get decoder() {
    return this.#decoder;
  }

  /**
   * @returns {Promise<string|null>} The next decoded frame, or `null` once
   *   the socket has reached EOF and no frames remain buffered.
   */
  async next() {
    if (this.#pending.length > 0) {
      return this.#pending.shift();
    }
    if (this.#eof) {
      return null;
    }
    while (true) {
      const chunk = await this.#socket.read();
      if (chunk === null) {
        this.#eof = true;
        return null;
      }
      const frames = this.#decoder.push(chunk);
      if (frames.length > 0) {
        this.#pending.push(...frames);
        return this.#pending.shift();
      }
      // Partial frame only -- loop and read more.
    }
  }
}

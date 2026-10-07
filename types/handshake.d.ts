// Types for `@johnhenry/dialback/handshake` (and the same two functions
// re-exported from `@johnhenry/dialback/browsermesh`).
import type { PodIdentity } from "@johnhenry/browsermesh-primitives";

/**
 * The minimal byte-stream socket contract the handshake needs. A netway
 * `StreamSocket` satisfies it, and so can an adapter over a plain
 * WebSocket, a `MessagePort`, or an in-memory pair.
 */
export interface HandshakeSocket {
  /** Next chunk of bytes, or `null` once the stream has ended. */
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<unknown> | unknown;
  close?(): Promise<unknown> | unknown;
}

/**
 * Opaque handle over the socket's incoming frames. Hand it to
 * `StreamSocketConnection` (via its `reader` option) after a successful
 * handshake so any already-buffered post-handshake bytes are not lost.
 */
export interface FrameReader {
  next(): Promise<string | null>;
  readonly decoder: unknown;
}

export interface HandshakeOptions {
  /** Per-step timeout in milliseconds (default 10000; `0` disables it). */
  timeoutMs?: number;
}

/**
 * Listener side: send a random nonce, verify the connecting peer's signed
 * response, then send accept or reject. Throws on any failure -- never use
 * the socket afterwards.
 */
export function challengeConnectingPeer(
  socket: HandshakeSocket,
  identity: PodIdentity,
  options?: HandshakeOptions
): Promise<{ reader: FrameReader; podId: string }>;

/**
 * Connecting side: sign the listener's nonce with the local identity.
 * Throws on timeout, EOF, malformed messages, or an explicit reject.
 */
export function respondToChallenge(
  socket: HandshakeSocket,
  identity: PodIdentity,
  options?: HandshakeOptions
): Promise<{ reader: FrameReader }>;

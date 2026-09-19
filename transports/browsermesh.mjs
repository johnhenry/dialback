/**
 * Optional, additive integration between `leproxy` and
 * `@johnhenry/browsermesh-netway` (virtual networking) +
 * `@johnhenry/browsermesh-primitives` (Ed25519 identity).
 *
 * This module is never imported by `index.mjs`, `server.mjs`, or
 * `agent.mjs` -- requiring `leproxy` normally never touches
 * browsermesh-netway or browsermesh-primitives at all, and neither package
 * is a hard `dependencies` entry (both are optional `peerDependencies`).
 * Import this module explicitly (`import { ... } from "leproxy/browsermesh"`)
 * to opt in.
 *
 * What this buys you over `leproxy`'s built-in WebSocket + shared-`secret`
 * transport: real, per-agent Ed25519 identity (a distinct keypair per agent,
 * verified via a challenge/response handshake) instead of one shared secret
 * string compared against every connecting agent. See `handshake.mjs` for
 * the exact protocol and `stream-socket-connection.mjs` for how a
 * `StreamSocket` (byte-oriented, no message framing, no `bufferedAmount`)
 * is adapted into the `Connection` shape `leproxy` already expects.
 *
 * @module transports/browsermesh
 */

import { StreamSocketConnection } from "./stream-socket-connection.mjs";
import { challengeConnectingPeer, respondToChallenge } from "./handshake.mjs";

/**
 * Same shape as `LOG_LEVELS` in `server.mjs`/`agent.mjs` (duplicated here
 * rather than imported, matching this repo's existing convention of keeping
 * files independently importable -- see the comment on `server.mjs`'s copy).
 */
const LOG_LEVELS = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

/**
 * Build a `transport` function for `Agent`'s `{ transport }` constructor
 * option: given a `VirtualNetwork` (or `ScopedNetwork`) and a local
 * `PodIdentity`, returns a function `(address) => Promise<Connection>` that
 * opens a `StreamSocket` via `net.connect(address)`, proves the local
 * identity to the listener (see `handshake.mjs`'s
 * `respondToChallenge`), and only then resolves with a `Connection`.
 *
 * The caller supplies whatever `VirtualNetwork` instance it wants -- a
 * default loopback-only one (for same-process use or tests, `mem://`
 * addresses) or one configured with a `GatewayBackend` for real
 * cross-machine TCP. This module does not care which backend is behind it.
 *
 * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} net
 * @param {import('@johnhenry/browsermesh-primitives').PodIdentity} identity
 * @param {{ timeoutMs?: number, log?: number }} [options]
 * @returns {(address: string) => Promise<import('../types/types.d.ts').Connection>}
 */
export function createBrowsermeshTransport(net, identity, options = {}) {
  if (!net || typeof net.connect !== "function") {
    throw new TypeError(
      "createBrowsermeshTransport requires a VirtualNetwork (or ScopedNetwork) " +
        "with a `connect(address)` method"
    );
  }
  if (!identity || typeof identity.sign !== "function" || typeof identity.podId !== "string") {
    throw new TypeError(
      "createBrowsermeshTransport requires a PodIdentity (from " +
        "@johnhenry/browsermesh-primitives, e.g. `await PodIdentity.generate()`)"
    );
  }
  const { timeoutMs, log = LOG_LEVELS.NONE } = options;

  return async function browsermeshTransport(address) {
    const socket = await net.connect(address);
    try {
      const { reader } = await respondToChallenge(socket, identity, { timeoutMs });
      return new StreamSocketConnection(socket, { reader });
    } catch (error) {
      if (log >= LOG_LEVELS.ERROR) {
        console.error("leproxy/browsermesh: identity handshake failed while connecting:", error);
      }
      try {
        await socket.close();
      } catch {
        // Already broken; nothing more to do.
      }
      throw error;
    }
  };
}

/**
 * Server-side counterpart to `createBrowsermeshTransport`: loops a netway
 * `Listener#accept()`, runs the challenger side of the identity handshake
 * on each accepted `StreamSocket` (`handshake.mjs`'s
 * `challengeConnectingPeer`), and only calls `server.addConnection()` for
 * connections that pass verification. A connection that fails the handshake
 * is closed immediately and never reaches the `Server`.
 *
 * Runs until the listener closes (`listener.accept()` resolving `null`).
 * Callers typically do not `await` this -- it's a long-running loop, the
 * same shape as `Server#listen()`'s own internal WebSocket "connection"
 * handler -- but the returned promise does resolve once the listener closes,
 * which is useful for tests.
 *
 * A `Server` used with this helper should be constructed with
 * `{ allowUnauthenticatedAgents: true }`: that is not a security regression
 * here, since real per-agent authentication already happened in the
 * handshake, before `addConnection()` was ever called -- see the doc
 * comment in `handshake.mjs` for the full reasoning.
 *
 * @param {import('@johnhenry/browsermesh-netway').Listener} listener
 * @param {import('../types/types.d.ts').Server} server
 * @param {import('@johnhenry/browsermesh-primitives').PodIdentity} identity
 * @param {{
 *   timeoutMs?: number,
 *   log?: number,
 *   onConnection?: (connection: import('../types/types.d.ts').Connection, podId: string) => void,
 *   onRejected?: (error: Error, socket: import('@johnhenry/browsermesh-netway').StreamSocket) => void,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function acceptBrowsermeshConnections(listener, server, identity, options = {}) {
  if (!listener || typeof listener.accept !== "function") {
    throw new TypeError(
      "acceptBrowsermeshConnections requires a Listener (from VirtualNetwork#listen)"
    );
  }
  if (!server || typeof server.addConnection !== "function") {
    throw new TypeError("acceptBrowsermeshConnections requires a leproxy Server");
  }
  const { timeoutMs, log = LOG_LEVELS.NONE, onConnection, onRejected } = options;

  while (true) {
    const socket = await listener.accept();
    if (!socket) break; // Listener closed.
    // Each accepted connection's handshake runs independently, concurrently
    // with accepting the next one -- a slow or hostile peer stalling its
    // handshake must not block every other agent from connecting.
    acceptOne(socket, server, identity, { timeoutMs, log, onConnection, onRejected }).catch(
      (error) => {
        if (log >= LOG_LEVELS.ERROR) {
          console.error("leproxy/browsermesh: error accepting connection:", error);
        }
      }
    );
  }
}

/**
 * @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket
 * @param {import('../types/types.d.ts').Server} server
 * @param {import('@johnhenry/browsermesh-primitives').PodIdentity} identity
 * @param {{ timeoutMs?: number, log: number, onConnection?: Function, onRejected?: Function }} options
 */
async function acceptOne(socket, server, identity, { timeoutMs, log, onConnection, onRejected }) {
  let handshake;
  try {
    handshake = await challengeConnectingPeer(socket, identity, { timeoutMs });
  } catch (error) {
    if (log >= LOG_LEVELS.WARN) {
      console.warn("leproxy/browsermesh: rejecting connection, identity handshake failed:", error);
    }
    try {
      await socket.close();
    } catch {
      // Already broken; nothing more to do.
    }
    onRejected?.(error, socket);
    return;
  }

  const connection = new StreamSocketConnection(socket, { reader: handshake.reader });
  // Not part of the `Connection` interface leproxy itself relies on, but a
  // useful, harmless extra: the verified remote identity, for callers that
  // want to log or make routing decisions based on which agent connected.
  connection.peerPodId = handshake.podId;

  if (log >= LOG_LEVELS.INFO) {
    console.log("leproxy/browsermesh: accepted verified connection from", handshake.podId);
  }

  await server.addConnection(connection);
  onConnection?.(connection, handshake.podId);
}

export { StreamSocketConnection };

import {
  PodIdentity,
  derivePodId,
  encodeBase64url,
  decodeBase64url,
} from "@johnhenry/browsermesh-primitives";
import { encodeFrame, FrameReader } from "./framing.mjs";

/**
 * Identity-based handshake, run directly on a freshly-connected
 * `StreamSocket` *before* it is ever wrapped as a `Connection` and handed to
 * `Server#addConnection()` or used by `Agent`. By the time either of those
 * ever sees the connection, it is already a verified, authenticated
 * channel -- so neither `server.mjs` nor `agent.mjs` needed any changes to
 * their own message-handling protocol for this to work. A `Server` used
 * this way should be constructed with `{ allowUnauthenticatedAgents: true }`
 * (see the readme's "browsermesh transport" section): that is not a
 * security regression, since real per-agent authentication already happened
 * here, at the transport layer, before the connection existed at all -- a
 * connection that fails this handshake is closed and never reaches
 * `Server#addConnection()`.
 *
 * Protocol (newline-delimited JSON frames, see `framing.mjs`), one-directional
 * by design, mirroring today's shared-`secret` model where the *server*
 * validates the *agent* and not the other way around:
 *
 *   listener (challenger)                    connecting peer (agent)
 *   ----------------------                   -----------------------
 *   { type: "challenge",
 *     nonce: base64url(32 random bytes),
 *     listenerPodId }              -->
 *                                             sign(nonce) with local identity
 *                             <--  { type: "response", podId, publicKey,
 *                                    signature: base64url(sig) }
 *   verify signature; verify
 *   podId == hash(publicKey)
 *   { type: "accept" }           -->            (or "reject" + close, on failure)
 *                                             (throws if "reject", EOF, or
 *                                              malformed -- never hands back
 *                                              a usable connection)
 *
 * `listenerPodId` in the challenge is informational only -- a plain string,
 * not a signature -- so the connecting side can log/identify which listener
 * it reached. It is *not* cryptographic proof of the listener's identity:
 * this handshake authenticates the connecting peer to the listener, not the
 * other way around, exactly matching the asymmetry of the existing
 * shared-`secret` handshake (an agent today has no way to verify the
 * server's secret either). Documented here as a deliberate scope choice,
 * not an oversight -- true mutual authentication (the listener also signing
 * a counter-nonce) would be a reasonable future extension if a caller's
 * threat model needs the agent to authenticate the server too.
 *
 * @module handshake
 */

const NONCE_BYTES = 32;

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 * @template T
 */
async function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Identity handshake timed out waiting for ${label}`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket
 * @param {string} [reason]
 */
async function sendReject(socket, reason) {
  try {
    await socket.write(encodeFrame(JSON.stringify({ type: "reject", reason })));
  } catch {
    // Best-effort -- the socket may already be unusable; the caller closes
    // it regardless.
  }
}

/**
 * Listener/challenger side of the handshake: send a random nonce, verify the
 * connecting peer's signed response, and send accept/reject.
 *
 * @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket
 * @param {InstanceType<typeof PodIdentity>} identity Local identity, used
 *   only for its `podId` (sent informationally in the challenge -- see the
 *   module doc comment on why this handshake is one-directional).
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ reader: FrameReader, podId: string }>} On success, the
 *   verified connecting peer's `podId`, and the `FrameReader` (carrying any
 *   already-buffered post-handshake bytes) to hand to `StreamSocketConnection`.
 * @throws {Error} On any failure (timeout, EOF, malformed message, bad
 *   signature, podId/publicKey mismatch). Callers must treat a throw as "do
 *   not use this socket" -- close it and never construct a `Connection`
 *   from it.
 */
export async function challengeConnectingPeer(socket, identity, { timeoutMs = 10000 } = {}) {
  const reader = new FrameReader(socket);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  await socket.write(
    encodeFrame(
      JSON.stringify({
        type: "challenge",
        nonce: encodeBase64url(nonce),
        listenerPodId: identity?.podId,
      })
    )
  );

  const raw = await withTimeout(reader.next(), timeoutMs, "identity response");
  if (raw === null) {
    throw new Error("Identity handshake failed: connection closed before a response arrived");
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Identity handshake failed: response was not valid JSON", { cause });
  }
  if (
    message.type !== "response" ||
    typeof message.podId !== "string" ||
    typeof message.publicKey !== "string" ||
    typeof message.signature !== "string"
  ) {
    throw new Error(
      "Identity handshake failed: malformed response (expected podId/publicKey/signature)"
    );
  }

  let publicKey;
  try {
    const publicKeyBytes = decodeBase64url(message.publicKey);
    publicKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      true,
      ["verify"]
    );
  } catch (cause) {
    await sendReject(socket, "malformed public key");
    throw new Error("Identity handshake failed: could not import claimed public key", { cause });
  }

  const derivedPodId = await derivePodId(publicKey);
  if (derivedPodId !== message.podId) {
    await sendReject(socket, "podId does not match publicKey");
    throw new Error(
      `Identity handshake failed: claimed podId "${message.podId}" does not match the ` +
        `hash of the supplied public key ("${derivedPodId}")`
    );
  }

  let verified;
  try {
    const signature = decodeBase64url(message.signature);
    verified = await PodIdentity.verify(publicKey, nonce, signature);
  } catch (cause) {
    await sendReject(socket, "malformed signature");
    throw new Error("Identity handshake failed: could not verify signature", { cause });
  }
  if (!verified) {
    await sendReject(socket, "invalid signature");
    throw new Error(`Identity handshake failed: invalid signature for podId "${message.podId}"`);
  }

  await socket.write(encodeFrame(JSON.stringify({ type: "accept" })));
  return { reader, podId: message.podId };
}

/**
 * Connecting-peer side of the handshake: wait for the listener's challenge,
 * sign the nonce with the local identity, and send back proof of identity.
 * Waits for the listener's accept/reject before resolving, so a rejected
 * handshake never hands back a connection a caller could accidentally use.
 *
 * @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket
 * @param {InstanceType<typeof PodIdentity>} identity Local identity to prove
 *   possession of via a signature over the listener's nonce.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ reader: FrameReader }>} On success, the `FrameReader`
 *   (carrying any already-buffered post-handshake bytes) to hand to
 *   `StreamSocketConnection`.
 * @throws {Error} On any failure (timeout, EOF, malformed message, or an
 *   explicit reject from the listener).
 */
export async function respondToChallenge(socket, identity, { timeoutMs = 10000 } = {}) {
  const reader = new FrameReader(socket);
  const raw = await withTimeout(reader.next(), timeoutMs, "identity challenge");
  if (raw === null) {
    throw new Error("Identity handshake failed: connection closed before a challenge arrived");
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Identity handshake failed: challenge was not valid JSON", { cause });
  }
  if (message.type !== "challenge" || typeof message.nonce !== "string") {
    throw new Error("Identity handshake failed: malformed challenge (missing nonce)");
  }

  const nonce = decodeBase64url(message.nonce);
  const signature = await identity.sign(nonce);
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", identity.keyPair.publicKey)
  );

  await socket.write(
    encodeFrame(
      JSON.stringify({
        type: "response",
        podId: identity.podId,
        publicKey: encodeBase64url(publicKeyBytes),
        signature: encodeBase64url(signature),
      })
    )
  );

  const ack = await withTimeout(reader.next(), timeoutMs, "identity accept/reject");
  if (ack === null) {
    throw new Error(
      "Identity handshake failed: connection closed before the listener accepted or rejected"
    );
  }
  let ackMessage;
  try {
    ackMessage = JSON.parse(ack);
  } catch (cause) {
    throw new Error("Identity handshake failed: accept/reject was not valid JSON", { cause });
  }
  if (ackMessage.type === "reject") {
    throw new Error(
      `Identity handshake rejected by listener: ${ackMessage.reason || "unspecified reason"}`
    );
  }
  if (ackMessage.type !== "accept") {
    throw new Error(`Identity handshake failed: unexpected acknowledgement type "${ackMessage.type}"`);
  }

  return { reader };
}

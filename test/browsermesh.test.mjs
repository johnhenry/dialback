// Tests for leproxy's optional `leproxy/browsermesh` transport
// (transports/browsermesh.mjs, framing.mjs, handshake.mjs,
// stream-socket-connection.mjs).
//
// These deliberately do NOT mock StreamSocket, VirtualNetwork, or
// PodIdentity: every test here builds a real `VirtualNetwork`, uses its
// built-in `LoopbackBackend` (`mem://` addresses) to get real connected
// `StreamSocket`s, generates real Ed25519 `PodIdentity` keypairs, and runs
// the actual sign/verify handshake -- matching this repo's existing
// "verify by actually running it" testing discipline (see
// test/integration.test.mjs for the WebSocket-transport equivalent of the
// end-to-end test below).
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { VirtualNetwork } from "@johnhenry/browsermesh-netway";
import { PodIdentity } from "@johnhenry/browsermesh-primitives";
import { Agent, Server } from "../index.mjs";
import {
  createBrowsermeshTransport,
  acceptBrowsermeshConnections,
} from "../transports/browsermesh.mjs";
import {
  challengeConnectingPeer,
  respondToChallenge,
} from "../transports/handshake.mjs";
import { encodeFrame, FrameDecoder } from "../transports/framing.mjs";

let port = 9200;

test("FrameDecoder", async (t) => {
  await t.test("decodes a single frame delivered in one chunk", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(JSON.stringify({ a: 1 })));
    assert.deepStrictEqual(frames, [JSON.stringify({ a: 1 })]);
  });

  await t.test("buffers a frame split across two chunks", () => {
    const decoder = new FrameDecoder();
    const whole = encodeFrame(JSON.stringify({ hello: "world" }));
    const splitAt = 5;
    const first = decoder.push(whole.subarray(0, splitAt));
    assert.deepStrictEqual(first, [], "no complete frame yet");
    const second = decoder.push(whole.subarray(splitAt));
    assert.deepStrictEqual(second, [JSON.stringify({ hello: "world" })]);
  });

  await t.test("splits multiple frames delivered in a single chunk", () => {
    const decoder = new FrameDecoder();
    const messages = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const combined = new Uint8Array(
      messages.reduce((sum, m) => sum + encodeFrame(JSON.stringify(m)).length, 0)
    );
    let offset = 0;
    for (const m of messages) {
      const frame = encodeFrame(JSON.stringify(m));
      combined.set(frame, offset);
      offset += frame.length;
    }
    const frames = decoder.push(combined);
    assert.deepStrictEqual(
      frames,
      messages.map((m) => JSON.stringify(m))
    );
  });

  await t.test("handles a chunk containing a full frame plus a partial one", () => {
    const decoder = new FrameDecoder();
    const full = encodeFrame(JSON.stringify({ complete: true }));
    const partial = encodeFrame(JSON.stringify({ incomplete: true })).subarray(0, 6);
    const combined = new Uint8Array(full.length + partial.length);
    combined.set(full, 0);
    combined.set(partial, full.length);
    const frames = decoder.push(combined);
    assert.deepStrictEqual(frames, [JSON.stringify({ complete: true })]);

    const rest = encodeFrame(JSON.stringify({ incomplete: true })).subarray(6);
    const secondFrames = decoder.push(rest);
    assert.deepStrictEqual(secondFrames, [JSON.stringify({ incomplete: true })]);
  });
});

test("identity handshake (handshake.mjs, direct)", async (t) => {
  await t.test("succeeds for a genuine, correctly-signed identity", async () => {
    const net = new VirtualNetwork();
    const address = `mem://localhost:${port++}`;
    const listenerIdentity = await PodIdentity.generate();
    const peerIdentity = await PodIdentity.generate();

    const listener = await net.listen(address);
    const clientPromise = net.connect(address).then((socket) =>
      respondToChallenge(socket, peerIdentity)
    );
    const serverSocket = await listener.accept();
    const serverResult = await challengeConnectingPeer(serverSocket, listenerIdentity);

    assert.strictEqual(serverResult.podId, peerIdentity.podId);
    await clientPromise; // Must resolve (accepted), not throw.
    listener.close();
  });

  await t.test("rejects a response signed by a different identity than it claims", async () => {
    const net = new VirtualNetwork();
    const address = `mem://localhost:${port++}`;
    const listenerIdentity = await PodIdentity.generate();
    const claimedIdentity = await PodIdentity.generate();
    const actualSigningIdentity = await PodIdentity.generate();

    const listener = await net.listen(address);

    const clientSocketPromise = net.connect(address);
    const serverSocket = await listener.accept();
    const clientSocket = await clientSocketPromise;

    // `challengeConnectingPeer` sends the challenge frame as its first
    // action, then blocks awaiting a response -- start it concurrently
    // rather than awaiting it up front, so the client side below has
    // something to read.
    const challengePromise = challengeConnectingPeer(serverSocket, listenerIdentity);

    // Hand-craft a malicious response: claim `claimedIdentity`'s podId, but
    // sign with (and send the public key of) a different identity entirely
    // -- exactly the attack a podId/publicKey cross-check must catch.
    const raw = await clientSocket.read();
    const challenge = JSON.parse(new TextDecoder().decode(raw));
    const nonce = Uint8Array.from(
      atob(challenge.nonce.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const b64u = (bytes) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const signature = await actualSigningIdentity.sign(nonce);
    const publicKeyBytes = new Uint8Array(
      await crypto.subtle.exportKey("raw", actualSigningIdentity.keyPair.publicKey)
    );
    await clientSocket.write(
      encodeFrame(
        JSON.stringify({
          type: "response",
          podId: claimedIdentity.podId, // Mismatched on purpose.
          publicKey: b64u(publicKeyBytes),
          signature: b64u(signature),
        })
      )
    );

    await assert.rejects(
      () => challengePromise,
      /does not match the hash of the supplied public key/
    );

    const ackRaw = await clientSocket.read();
    const ack = JSON.parse(new TextDecoder().decode(ackRaw));
    assert.strictEqual(ack.type, "reject");
    listener.close();
  });

  await t.test("rejects a signature over the wrong data (correct identity, wrong nonce)", async () => {
    const net = new VirtualNetwork();
    const address = `mem://localhost:${port++}`;
    const listenerIdentity = await PodIdentity.generate();
    const peerIdentity = await PodIdentity.generate();

    const listener = await net.listen(address);
    const clientSocketPromise = net.connect(address);
    const serverSocket = await listener.accept();
    const clientSocket = await clientSocketPromise;

    const challengePromise = challengeConnectingPeer(serverSocket, listenerIdentity);
    await clientSocket.read(); // consume (and ignore) the real challenge
    const b64u = (bytes) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    // Sign the wrong bytes entirely (not the nonce the listener sent).
    const wrongData = new TextEncoder().encode("not the nonce you sent me");
    const signature = await peerIdentity.sign(wrongData);
    const publicKeyBytes = new Uint8Array(
      await crypto.subtle.exportKey("raw", peerIdentity.keyPair.publicKey)
    );
    await clientSocket.write(
      encodeFrame(
        JSON.stringify({
          type: "response",
          podId: peerIdentity.podId,
          publicKey: b64u(publicKeyBytes),
          signature: b64u(signature),
        })
      )
    );

    await assert.rejects(() => challengePromise, /invalid signature/);
    listener.close();
  });
});

test("createBrowsermeshTransport / acceptBrowsermeshConnections", async (t) => {
  await t.test("a forged identity is rejected and never reaches Server#addConnection", async () => {
    const net = new VirtualNetwork();
    const address = `mem://localhost:${port++}`;
    const listenerIdentity = await PodIdentity.generate();
    const realIdentity = await PodIdentity.generate();
    const impostorIdentity = await PodIdentity.generate();
    // A "PodIdentity" whose podId doesn't match the key it will actually
    // sign with -- e.g. a bug or an attacker claiming someone else's podId.
    const forgedIdentity = {
      keyPair: realIdentity.keyPair,
      podId: impostorIdentity.podId,
      sign: (data) => realIdentity.sign(data),
    };

    const server = new Server(undefined, { allowUnauthenticatedAgents: true });
    const listener = await net.listen(address);
    const acceptLoop = acceptBrowsermeshConnections(listener, server, listenerIdentity);

    // From the connecting side's point of view, the failure surfaces as an
    // explicit rejection from the listener (it never sees the listener's
    // own internal "does not match the hash..." message -- only that its
    // handshake was rejected and why).
    const transport = createBrowsermeshTransport(net, forgedIdentity);
    await assert.rejects(
      () => transport(address),
      /Identity handshake rejected by listener: podId does not match publicKey/
    );

    // Give the accept loop a tick to finish processing the rejection.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(
      server.getConnectionByIndex(0),
      undefined,
      "a rejected handshake must never result in a registered connection"
    );

    listener.close();
    await acceptLoop;
  });

  await t.test("Agent's `transport` option never resolves its connection on a rejected handshake", async () => {
    const net = new VirtualNetwork();
    const address = `mem://localhost:${port++}`;
    const listenerIdentity = await PodIdentity.generate();
    const realIdentity = await PodIdentity.generate();
    const impostorIdentity = await PodIdentity.generate();
    const forgedIdentity = {
      keyPair: realIdentity.keyPair,
      podId: impostorIdentity.podId,
      sign: (data) => realIdentity.sign(data),
    };

    const server = new Server(undefined, { allowUnauthenticatedAgents: true });
    const listener = await net.listen(address);
    const acceptLoop = acceptBrowsermeshConnections(listener, server, listenerIdentity);

    const transport = createBrowsermeshTransport(net, forgedIdentity);
    let observedError = null;
    const agent = new Agent(address, { transport });
    agent.on("error", (error) => {
      observedError = error;
    });

    const outcome = await Promise.race([
      agent.connection.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);
    assert.strictEqual(
      outcome,
      "timeout",
      "agent.connection must not resolve when the identity handshake is rejected"
    );
    assert.ok(observedError, "Agent should emit an 'error' event for the failed handshake");

    listener.close();
    await acceptLoop;
  });
});

test("end-to-end: Server + Agent over the browsermesh transport, through a real HTTP request", async (t) => {
  let server;
  let agent;
  let listener;
  let acceptLoop;
  let currentPort;
  let net;
  let meshAddress;

  t.beforeEach(async () => {
    currentPort = port++;
    net = new VirtualNetwork();
    meshAddress = `mem://localhost:${port++}`;
    const serverIdentity = await PodIdentity.generate();
    const agentIdentity = await PodIdentity.generate();

    server = new Server(undefined, { allowUnauthenticatedAgents: true });
    await server.listen(currentPort);

    listener = await net.listen(meshAddress);
    acceptLoop = acceptBrowsermeshConnections(listener, server, serverIdentity);

    const transport = createBrowsermeshTransport(net, agentIdentity);
    agent = new Agent(meshAddress, { transport });
    // Same reasoning as test/integration.test.mjs: wait for the connection
    // (here, the full identity handshake) to finish before firing requests,
    // so the first request doesn't race an unregistered agent.
    await agent.connection;
  });

  t.afterEach(async () => {
    if (agent) await agent.close().catch(() => {});
    if (listener) listener.close();
    if (acceptLoop) await acceptLoop.catch(() => {});
    if (server) await server.close().catch(() => {});
  });

  await t.test("a real HTTP request is proxied to the agent's handler and back", async () => {
    agent.serve(async (request) => {
      assert.strictEqual(request.url, "http://test.local/hello");
      assert.strictEqual(request.method, "GET");
      return new Response("hello over browsermesh", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${currentPort}/hello`,
        { method: "GET", headers: { "X-Forwarded-Host": "test.local" } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        }
      );
      req.on("error", reject);
      req.end();
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data, "hello over browsermesh");
  });

  await t.test("a POST body round-trips through the mesh transport", async () => {
    agent.serve(async (request) => {
      const body = await request.text();
      return new Response(`echo: ${body}`, { status: 201 });
    });

    const payload = "x".repeat(200_000); // large enough to span several frames/chunks
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${currentPort}/echo`,
        {
          method: "POST",
          headers: { "X-Forwarded-Host": "test.local", "Content-Type": "text/plain" },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.data, `echo: ${payload}`);
  });
});

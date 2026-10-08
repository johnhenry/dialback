// The key-bound handshake must be reachable through the package's own
// `exports` map (no deep import into node_modules).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

for (const specifier of [
  "@johnhenry/dialback/transports/handshake",
  "@johnhenry/dialback/handshake",
]) {
  test(`${specifier} resolves through the exports map to handshake.mjs`, async () => {
    const resolved = import.meta.resolve(specifier);
    assert.ok(
      resolved.endsWith("/transports/handshake.mjs"),
      `unexpected resolution: ${resolved}`
    );
    const mod = await import(specifier);
    assert.strictEqual(typeof mod.challengeConnectingPeer, "function");
    assert.strictEqual(typeof mod.respondToChallenge, "function");
  });
}

test("the root entry stays transport-agnostic (no handshake exports)", async () => {
  const root = await import("@johnhenry/dialback");
  assert.strictEqual(root.challengeConnectingPeer, undefined);
  assert.strictEqual(root.respondToChallenge, undefined);
});

test("exports map lists the handshake subpaths", () => {
  assert.strictEqual(pkg.exports["./transports/handshake"].default, "./transports/handshake.mjs");
  assert.strictEqual(pkg.exports["./handshake"].default, "./transports/handshake.mjs");
});

test("./browsermesh re-exports the handshake functions", async () => {
  const mesh = await import("@johnhenry/dialback/browsermesh");
  const hs = await import("@johnhenry/dialback/handshake");
  assert.strictEqual(mesh.challengeConnectingPeer, hs.challengeConnectingPeer);
  assert.strictEqual(mesh.respondToChallenge, hs.respondToChallenge);
});

test("handshake and browsermesh subpaths declare types", () => {
  assert.strictEqual(pkg.exports["./handshake"].types, "./types/handshake.d.ts");
  assert.strictEqual(pkg.exports["./transports/handshake"].types, "./types/handshake.d.ts");
  assert.strictEqual(pkg.exports["./browsermesh"].types, "./types/browsermesh.d.ts");
  for (const key of ["./handshake", "./browsermesh"]) {
    const file = new URL("../" + pkg.exports[key].types, import.meta.url);
    assert.ok(readFileSync(file, "utf8").includes("challengeConnectingPeer"), key);
  }
});

test("./server and ./agent subpaths resolve", async () => {
  assert.ok(import.meta.resolve("@johnhenry/dialback/server").endsWith("/server.mjs"));
  assert.ok(import.meta.resolve("@johnhenry/dialback/agent").endsWith("/agent.mjs"));
  assert.strictEqual(typeof (await import("@johnhenry/dialback/server")).Server, "function");
  assert.strictEqual(typeof (await import("@johnhenry/dialback/agent")).Agent, "function");
});

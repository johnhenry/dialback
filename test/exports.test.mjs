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
  assert.strictEqual(pkg.exports["./transports/handshake"], "./transports/handshake.mjs");
  assert.strictEqual(pkg.exports["./handshake"], "./transports/handshake.mjs");
});

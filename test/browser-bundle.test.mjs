// `server.mjs` must bundle for the browser with no Node built-ins (#16): the
// Node-only listener lives behind the `#node-listener` "imports" entry, which
// only the `node` condition resolves to the real implementation.
import { test } from "node:test";
import assert from "node:assert";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));

async function bundle(extra = {}) {
  return build({
    stdin: { contents: `export { Server } from ${JSON.stringify(serverPath)};`, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
    ...extra,
  });
}

test("server.mjs bundles for the browser without Node built-ins", async () => {
  const result = await bundle();
  const inputs = Object.keys(result.metafile.inputs);
  for (const input of inputs) {
    assert.ok(!/webwire|node_modules\/ws\/|util\/node-listener\.mjs$/.test(input), `Node-only input bundled: ${input}`);
  }
  const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
  assert.deepStrictEqual(imports, [], "browser bundle must have no external imports");
  const code = result.outputFiles[0].text;
  assert.ok(!/node:|from ["']http["']|require\(/.test(code), "no Node built-in references in the output");
});

test("the browser bundle runs; listen() explains it needs Node, fetch() still works", async () => {
  const result = await bundle();
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64");
  const { Server } = await import(url);
  const server = new Server(() => new Response("no agent", { status: 503 }), { secret: "s" });
  await assert.rejects(() => server.listen(0), /needs Node\.js/);
  const res = await server.fetch(new Request("http://example.test/"));
  assert.strictEqual(res.status, 503);
  await server.close();
});

test("under the `node` condition the real listener is bundled (control)", async () => {
  const result = await bundle({ platform: "node", conditions: ["node"], packages: "external" });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some((i) => i.endsWith("util/node-listener.mjs")), inputs.join(", "));
});

// The whole root entry (Agent included) and the browsermesh transport bundle
// for the browser with no Node built-ins and no external imports.
for (const [name, entry] of [
  ["index.mjs (Server + Agent)", "../index.mjs"],
  ["transports/browsermesh.mjs", "../transports/browsermesh.mjs"],
]) {
  test(`${name} bundles for the browser without Node built-ins`, async () => {
    const path = fileURLToPath(new URL(entry, import.meta.url));
    const result = await build({
      stdin: { contents: `export * from ${JSON.stringify(path)};`, resolveDir: process.cwd() },
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent",
    });
    const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
    assert.deepStrictEqual(imports, []);
    assert.ok(!/node:/.test(result.outputFiles[0].text));
  });
}

test("the browser Emitter matches the EventEmitter behaviour dialback relies on", async () => {
  const { default: Emitter } = await import("../util/emitter.mjs");
  const { default: NodeEmitter } = await import("../util/emitter.node.mjs");
  for (const E of [Emitter, NodeEmitter]) {
    const e = new E();
    const seen = [];
    e.on("x", (v) => seen.push(["on", v]));
    e.once("x", (v) => seen.push(["once", v]));
    assert.strictEqual(e.emit("x", 1), true);
    assert.strictEqual(e.emit("x", 2), true);
    assert.deepStrictEqual(seen, [["on", 1], ["once", 1], ["on", 2]]);
    const fn = () => seen.push("gone");
    e.on("y", fn);
    e.off("y", fn);
    assert.strictEqual(e.emit("y"), false);
    assert.throws(() => e.emit("error", new Error("boom")), /boom/);
    e.on("error", () => {});
    assert.doesNotThrow(() => e.emit("error", new Error("handled")));
  }
});

# Agent playbook

`@johnhenry/dialback` -- a reverse proxy over WebSockets (an `Agent` dials
out, the `Server` dials back through that same connection). Single package,
Node >= 26, `node:test` (plus a separate Deno suite), ships source directly
(`index.mjs`/`server.mjs`/`agent.mjs`); no build step.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm run test:node` -- the core Node suite.
2. `npm run test:browsermesh` -- the optional `dialback/browsermesh`
   transport suite. Needs `@johnhenry/browsermesh-netway` and
   `@johnhenry/browsermesh-primitives` installed (they're `devDependencies`
   here even though they're optional `peerDependencies` for consumers).
3. `npm run test:int` -- the integration suite (`test/integration.test.mjs`).
4. `npm run test:deno` -- requires the Deno runtime; CI runs this as a
   separate job. Needs a real, empty `DENO_DIR` at least once to catch
   anything only working "by accident" via unrelated global state.
5. A genuinely fresh clone:
   `git clone . /tmp/dialback-verifyN && cd $_ && npm ci && npm test`.
6. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs `test:node` + `test:browsermesh` +
`test:int` on a Node matrix, and `test:deno` as its own job; match that
locally before pushing.

## Repo-specific gotchas

- **The optional `dialback/browsermesh` transport needs real WebCrypto
  Ed25519.** `PodIdentity.generate()` throws on a runtime with no global
  `crypto`. The suite feature-detects this and skips only the
  identity/handshake/e2e blocks that actually call it -- everything else
  (e.g. `FrameDecoder`) still runs. If you add a new test that touches
  `PodIdentity`, scope its skip the same way rather than gating the whole
  file.
- **`deno.lock` references `npm:@types/node`** (needed by Deno's Node-compat
  layer for the JSDoc `import('./types/types')` paths), but it isn't a real
  `devDependency` unless you keep it declared and pinned to what the lock
  file expects -- it previously only worked locally via unrelated global
  state, and failed outright on a clean checkout.
- **No `Promise.withResolvers()`, even though it's tempting.** This
  package's own declared floor is checked in CI on a real matrix; a
  Node-version-gated built-in that isn't actually supported everywhere the
  matrix runs will surface immediately -- use the manual
  Promise-executor pattern already used in `util/PromisesPlus.mjs` instead
  of assuming a newer global is available.

## Definition of done

A change is done when all of the following hold, not just when tests pass:
- A regression test exists for any bug fixed.
- Anything the feature does **not** do is stated in the README (the
  `## Honest limitations` section, or the auth note under `Server`), not
  only in an issue comment.
- `CHANGELOG.md` has an entry.

## Releases

Bump `version` in `package.json`, add the `CHANGELOG.md` entry, merge, then
`gh release create v<version>` -- the release event triggers
`.github/workflows/publish.yml`, which is idempotent (skips if the version
is already on npm).

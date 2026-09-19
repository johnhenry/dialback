# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project will adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.0.

## [Unreleased]

### Added

- **Optional `leproxy/browsermesh` transport**: a new, additive-only module (`transports/browsermesh.mjs`, `handshake.mjs`, `framing.mjs`, `stream-socket-connection.mjs`) that runs `Server`/`Agent` connections over `@johnhenry/browsermesh-netway`'s `VirtualNetwork`/`StreamSocket` instead of a raw WebSocket, with per-agent Ed25519 identity (`@johnhenry/browsermesh-primitives`' `PodIdentity`) replacing the single shared `secret` — see the readme's new "Optional: the `leproxy/browsermesh` transport" section for the handshake protocol and usage. Exposed via a new `"./browsermesh"` package-export subpath and a new `Agent` constructor option, `transport: (address) => Promise<Connection>`, that when provided is used instead of `new WebSocket(address)` — with no `transport` option, `Agent`'s behavior is unchanged (verified by re-running the full pre-existing test suite unmodified). `@johnhenry/browsermesh-netway` and `@johnhenry/browsermesh-primitives` are optional `peerDependencies`, never imported by `index.mjs`/`server.mjs`/`agent.mjs` — requiring plain `leproxy` never touches either package.
- **`Server#commit()` and the server-side response pipeline**: previously, `Server#fetch()` called `this.commit()`, which didn't exist anywhere in the codebase — every request unconditionally threw `TypeError: this.commit is not a function`. Implemented request dispatch (agent selection, request forwarding, request-body streaming with backpressure) and, critically, the response side: a per-connection receive loop that consumes incoming `response`/`response:body`/`response:body:end` messages from the selected agent and resolves/rejects/streams into the pending `Response`. This closes the loop the wire protocol was designed around but never actually implemented on the server side.
- Full connection-management API on `Server`: `addConnection`, `removeConnection`, `removeConnectionById`, `removeConnectionByIndex`, `getConnectionById`, `getConnectionByIndex`, `setStrategy`/`strategy` — all previously declared in `types/types.d.ts` but not implemented.
- Two previously-unimplemented agent-selection strategies: `last-used` and `most-recent` (`first`, `last`, `random`, `round-robin` already existed). All six now have dedicated test coverage (`test/strategies.test.mjs` — this API had zero coverage before).
- Backpressure on the server→agent request-body streaming path (`#streamRequestBody`), matching the backpressure already present on `agent.mjs`'s response-body path.
- `LOG_LEVELS`-gated logging in `server.mjs`, matching the pattern already used in `agent.mjs`, replacing raw `console.log` calls left over from in-progress debugging.

### Fixed

- **`listen()`'s request handler threw outside its own try/catch, hanging every request indefinitely**: `new Request(req.url, ...)` fails because Node's `req.url` is a relative path and `Request` requires an absolute URL; this also attached a body to GET/HEAD requests, which `Request` rejects. Both are now handled (absolute-URL construction + a GET/HEAD guard) inside a dedicated try/catch that returns a real error response instead of hanging the socket. Also added `X-Forwarded-Host` support.
- **Messages could be silently dropped when two arrived in the same tick**: `util/invertedAsyncIterator.mjs`'s `enqueue` reused a stale `resolve` reference instead of clearing it after use, so resolving it a second time in the same tick was a silent no-op. This was the root cause of intermittent hangs across every multi-message exchange in the protocol (agent registration, response headers, response-body chunks).
- **Responses could never be correlated back to their originating request**: `agent.mjs` tagged outgoing `response`/`response:body`/`response:body:end` messages via `request: message.request`, but the actual field on incoming request messages is `id` — `message.request` was always `undefined`. Fixed to use `id` consistently.
- **The first request-body chunk could be silently dropped**: the per-request body-chunk listener was registered only while handling the `"request"` message via a second `doConnection()` call; on a fast loopback connection, `"request:body"` could arrive before that listener existed. Replaced the per-request-channel pattern with a single dispatch loop keyed by request id.
- **Large payloads (~64KB+) crashed the base64 encoder**: `bytesToBase64` used `String.fromCodePoint(...bytes)`, which blows the call stack on large inputs. Fixed by chunking the spread.
- `test/integration.test.mjs`'s setup fired HTTP requests immediately after constructing the `Agent`, without waiting for its handshake to complete — occasionally hitting the server before the agent had registered. Now awaits `agent.connection` first.
- `package.json`'s `"types"` field pointed at `types/types.dts` (a near-empty placeholder with no `.d`), while the real, complete declarations were in `types/types.d.ts`. Fixed to point at the real file; deleted the placeholder.
- `package.json`'s `repository`/`bugs`/`homepage` URLs still pointed at this project's old name, `proxy-socks` (the repo was already renamed to `leproxy` on GitHub). Corrected.
- Deno type-checking (`deno test`) was broken by JSDoc `import('./types/types')` paths missing the `.d.ts` extension, and `test:deno`'s script was missing `--allow-all` (needed by the `ws` polyfill under Deno) — both pre-existing, found while verifying `test/deno.test.ts`.

### Removed

- `demo/perpetual.mjs`, an unrelated "perpetual calendar" scratch script with no connection to proxying.

### Security

- **`Server` silently accepted any agent handshake with zero verification whenever constructed without a `secret`** (the validation check itself was skipped entirely, not just weak). The constructor now throws unless either `secret` or an explicit `allowUnauthenticatedAgents: true` is passed, so skipping authentication is a visible, deliberate choice.
- The secret comparison now uses a constant-time compare (`node:crypto timingSafeEqual`) instead of `!==`, so a mismatch can't be timed to leak how many leading bytes of a guess were correct.
- Remaining known limitation, documented rather than fixed: authentication is still a single shared `secret` string for every agent (no per-agent identity, rotation, or session/token model), meaningfully weaker than e.g. `wsh`'s signed Ed25519 challenge-response handshake. A full swap to signed-challenge auth was investigated and scoped as a deliberate future breaking-change effort (see the design note this project's maintainer has, comparing against `wsh`'s and `browsermesh-primitives`' approaches) — not undertaken here, since it's infrastructure work disconnected from any current deployment pressure. Fine for the tunnel's current standalone scope; worth revisiting if this is ever used to expose real backends across a trust boundary.

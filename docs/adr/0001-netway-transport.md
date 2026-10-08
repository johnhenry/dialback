# ADR 0001: browsermesh-netway as an alternative transport

Status: accepted (2026-10-08). Resolves #2.

## Context

dialback's built-in model is a `Server` that accepts WebSocket connections
from `Agent`s, authenticated by one shared `secret` compared in constant
time. Issue #2 asked whether the Agent-to-Server link should instead be a
thin adapter over `@johnhenry/browsermesh-netway` virtual sockets with
per-agent identity (`@johnhenry/browsermesh-primitives`, Ed25519).

Since the issue was filed this was built as additive, opt-in modules:
`./browsermesh` (`createBrowsermeshTransport`, `acceptBrowsermeshConnections`)
and `./handshake` / `./transports/handshake` (a key-bound challenge/response
handshake). The Agent's `{ transport }` option and `Server#addConnection()`
are the seams; neither the root entry nor `Server`/`Agent` import netway.

## Comparison

| | Built-in WebSocket + secret | netway transport (`./browsermesh`) |
|---|---|---|
| Security model | One shared string for every agent; no per-agent identity, rotation or revocation. Fine behind a VPN or authenticating proxy. | Per-agent Ed25519 keypair; listener challenges, agent signs, server learns a verified identity. No shared secret to leak. Needs WebCrypto Ed25519. |
| NAT / reachability | Agent dials out over ordinary `ws(s)://`, so it works from behind NAT and through any HTTP proxy or CDN. Server must be publicly reachable. | netway itself does no NAT traversal. `mem://`/`loop://` are in-process; real cross-machine links need a `GatewayBackend` (a reachable wsh gateway), which is the same "someone must be reachable" requirement. No gain here. |
| Dependency weight | `ws` (Node only, zero in browsers) and `@johnhenry/webwire`. | Two extra packages (netway, primitives), declared as optional peers and loaded only on import of the subpath. |
| Browser support | Agent works in a page using the platform `WebSocket` (as of 0.1.0). Server-side listening needs Node. | Fully browser-safe; also enables page-to-page or worker-to-page links with no network at all. |

## Decision

Adopt netway as an optional transport and do not replace the default.
It is already shipped as `./browsermesh` plus `./handshake`; a second
`./transports/netway` adapter would duplicate it, so none is added. The
shared-secret WebSocket path stays the default because it is the only one
that is simple, NAT-friendly and dependency-light for the common case
(a Node server and remote agents). Users who need per-agent identity or
in-browser/in-process links opt in via `@johnhenry/dialback/browsermesh`.

## Consequences

- No new dependencies; netway and primitives remain optional peers.
- The shared-secret model stays documented as a deliberate simplification.
- Open follow-up (not decided here): whether `allowUnauthenticatedAgents`
  should be deprecated when every agent uses the handshake.

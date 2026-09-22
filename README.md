# dialback

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fdialback.svg)](https://www.npmjs.com/package/@johnhenry/dialback)
[![CI](https://github.com/johnhenry/dialback/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/dialback/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fdialback.svg)](https://www.npmjs.com/package/@johnhenry/dialback)

Full documentation: [opensource.johnhenry.me/dialback](https://opensource.johnhenry.me/dialback/)

<img alt="dialback logo" width="512" height="512" src="./logo.jpeg" style="width:512px;height:512px"/>

Library for creating a reverse proxy over websockets: an `Agent` dials out
(through a NAT/firewall it's behind), and the `Server` dials back through
that same connection to reach it -- the name is the mechanism, not just a
label.

> **Provenance:** previously developed as `leproxy` (itself a rename of the
> original `proxy-socks`), but never actually published to npm under either
> name. Renamed and adopted into the `@johnhenry` scope, starting fresh at
> `0.0.0`.

Request/Response <-HTTP-> [Server] <-WS-> [Agent]

## Contents

- [Quick Start](#quick-start)
  - [Installation](#installation)
  - [Usage with Node.js](#usage-with-nodejs)
  - [Usage with Deno](#usage-with-deno)
- [API Documentation](#api-documentation)
  - [Server](#server)
  - [Agent](#agent)
  - [Utility Functions](#utility-functions)
- [Security model](#security-model)
- [Optional: the `dialback/browsermesh` transport](#optional-the-dialbackbrowsermesh-transport)
- [Family](#family)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

### Installation

```bash
npm install @johnhenry/dialback
```

### Usage with Node.js

1. Create Server (Node.js)

```javascript
import { Server } from "@johnhenry/dialback";
import http from 'http';
import { WebSocketServer } from 'ws';

const server = new Server(() => new Response("no responder", { status: 500 }));

// Server#fetch() requires a real Request instance (or a URL string) --
// Node's IncomingMessage isn't one, so convert it first.
function toWebRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const init = { method: req.method, headers: req.headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  return new Request(url, init);
}

const httpServer = http.createServer(async (req, res) => {
  const response = await server.fetch(toWebRequest(req));
  res.writeHead(response.status, response.statusText, Object.fromEntries(response.headers));
  response.body.pipe(res);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  server.addConnection(ws);
  ws.on('close', () => {
    server.removeConnection(ws);
  });
});

httpServer.listen(8082, () => {
  console.log('Server running on http://localhost:8082');
});
```

2. Create Agent

```javascript
import { Agent } from "@johnhenry/dialback";

const address = `ws://localhost:8082`;
const { serve } = new Agent(address, { reconnect: 1000, log: 2 });

serve(async (request, { id }) => {
  return new Response(`Hello there!`, {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "application/text",
      etag: id,
    },
  });
});
```

### Usage with Deno

1. Create Server (Deno)

```javascript
import { Server } from "npm:@johnhenry/dialback";
const server = new Server(() => new Response("no responder", { status: 500 }));
Deno.serve({ port: 8082 }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return server.fetch(req);
  }
  const { socket: connection, response } = Deno.upgradeWebSocket(req);
  server.addConnection(connection);
  connection.addEventListener("close", () => {
    server.removeConnection(connection);
  });
  return response;
});
```

2. Create Agent (Same as Node.js version)

## API Documentation

### Server

The `Server` class is responsible for handling incoming HTTP requests and managing WebSocket connections to agents.

#### Constructor

```javascript
new Server(defaultHandler, options)
```

- `defaultHandler`: A function that returns a `Response` object when no agent is available to handle the request.
- `options`: An object with the following properties:
  - `strategy` (optional): A string specifying the agent selection strategy. Default is "first". One of `"first"`, `"last"`, `"random"`, `"round-robin"`, `"last-used"` (the agent that most recently completed a request/response cycle), or `"most-recent"` (the agent that most recently connected).
  - `secret`: A string used for authentication between the server and agents. **Required** unless `allowUnauthenticatedAgents` is set — the constructor throws otherwise, since without a secret the server has nothing to validate an agent handshake against and would accept any agent unverified.
  - `allowUnauthenticatedAgents` (optional): Set to `true` to explicitly opt out of the `secret` requirement and accept any agent handshake with no verification. Default is `false`.
  - `log` (optional): An integer log level (0-4, matching `LOG_LEVELS`/`Agent`'s `log` option). Default is `0` (no logging).

#### Methods

- `addConnection(connection)`: Registers a WebSocket-like connection (anything implementing `send`/`addEventListener`/`close`) as a candidate agent connection and starts consuming its messages. Returns a `Promise` that resolves to the connection.
- `removeConnection(connection)`: Unregisters a connection. Any request still in flight against it is rejected instead of hanging forever.
- `removeConnectionById(id)`: Removes the connection registered under the given agent id (the `agent` field from that connection's handshake).
- `removeConnectionByIndex(index)`: Removes the connection at the given position in connection order.
- `getConnectionById(id)`: Returns the connection registered under the given agent id, or `undefined`.
- `getConnectionByIndex(index)`: Returns the connection at the given position, or `undefined`.
- `fetch(request)`: Handles an incoming HTTP request and returns a `Promise` that resolves to a `Response` object.
- `setStrategy(newStrategy)`: Sets the agent selection strategy; throws on an unrecognized value.

#### Properties

- `strategy`: Gets or sets the current agent selection strategy (setting it validates the same way as `setStrategy`).
- `fetch`: A bound version of the `fetch` method that can be used directly with HTTP server libraries.

#### A note on authentication

The `secret` option is a single shared secret compared (in constant time) against whatever every agent sends in its handshake — there's no per-agent identity, rotation, or session/token model. That's an intentional simplification for now, not an oversight; if you need per-agent credentials or anything more sophisticated, put this behind your own auth layer (e.g. a reverse proxy or VPN in front of the WebSocket port) rather than expecting `dialback` to provide it.

`secret` is required precisely because omitting it isn't a safe default — a `Server` with no secret configured would accept a handshake from *any* agent with no verification at all. If that's genuinely what you want (e.g. local development, or a deployment secured entirely at the network layer), pass `allowUnauthenticatedAgents: true` explicitly so it's visible in the code that authentication was deliberately skipped, not merely forgotten.

### Agent

The `Agent` class is responsible for connecting to a Server and handling proxied requests.

#### Constructor

```javascript
new Agent(address, options)
```

- `address`: A string representing the WebSocket address of the server to connect to (or whatever address shape a custom `transport` expects — see below).
- `options`: An object with the following properties:
  - `reconnect` (optional): The number of milliseconds to wait before attempting to reconnect if the connection is lost.
  - `log` (optional): An integer representing the log level (0-4).
  - `abort` (optional): A function that returns a `Response` object when a request is aborted.
  - `secret` (optional): A string used for authentication between the server and agents.
  - `transport` (optional): `(address) => Promise<Connection>`. When provided, used instead of `new WebSocket(address)` to establish the connection — see [Optional: the `dialback/browsermesh` transport](#optional-the-dialbackbrowsermesh-transport) below.

#### Methods

- `serve(handler)`: Sets the request handler function for the agent. The handler function should accept a `Request` object and return a `Promise` that resolves to a `Response` object.

#### Properties

- `serve`: A bound version of the `serve` method that can be used to set the request handler.

### Utility Functions

#### upgradeWebSocket(req)

A utility function that creates a WebSocket connection from an HTTP request. This function is primarily used in Deno environments.

## Security model

`Server` gates every connecting agent behind a single shared secret before
it's ever handed to application code. That's the whole boundary the core
transport draws -- everything past the handshake (which requests go to
which agent, what those requests contain) is unauthenticated at this layer.

**What dialback guarantees:**

- **Every agent handshake is checked against `secret`.** The comparison
  uses `node:crypto`'s `timingSafeEqual` (constant-time), not `!==`, so a
  wrong guess can't be timed to leak how many leading bytes matched.
- **Authentication cannot be silently skipped.** `new Server(handler,
  options)` throws unless either `secret` is set or
  `allowUnauthenticatedAgents: true` is passed explicitly -- there is no
  code path that ends up accepting unverified agents by omission. See
  ["A note on authentication"](#a-note-on-authentication) above.
- **A request in flight against a removed connection is rejected, not left
  hanging.** `removeConnection()`/`removeConnectionById()` reject any
  pending request against that agent instead of leaving the caller to time
  out.

**What is still yours:**

- **The `secret` model has no per-agent identity, rotation, or session
  model.** Every agent presents the same string; there's no way to tell
  agents apart at the auth layer, and revoking one agent means rotating the
  secret for all of them. If you need per-agent credentials, put dialback
  behind your own auth layer (a reverse proxy or VPN in front of the
  WebSocket port), or use the [`dialback/browsermesh`
  transport](#optional-the-dialbackbrowsermesh-transport) below, which
  replaces the shared secret with real per-agent Ed25519 identity. Tracked
  as a possible core replacement in dialback #2.
- **Transport confidentiality is your deployment's responsibility.**
  dialback does not manage TLS itself -- run the WebSocket server behind
  `wss://` (or an equivalent terminating proxy) if the secret or proxied
  request/response bodies must not be visible on the wire.
- **`fetch(request)` forwards whatever the selected agent returns.**
  `Server` does not inspect, sanitize, or rate-limit request/response
  bodies -- that's the `defaultHandler`'s and the agent's own handler's
  job.

## Optional: the `dialback/browsermesh` transport

`dialback`'s built-in transport is a WebSocket plus a single shared `secret` string, compared against whatever every connecting agent sends. `dialback/browsermesh` is an **optional, additive** module — never imported by `dialback`'s own `index.mjs`/`server.mjs`/`agent.mjs`, so requiring plain `dialback` never touches it — that swaps that in for real, per-agent Ed25519 identity, built on [`@johnhenry/browsermesh-netway`](https://www.npmjs.com/package/@johnhenry/browsermesh-netway) (virtual networking: `StreamSocket`/`VirtualNetwork`/`Listener`) and [`@johnhenry/browsermesh-primitives`](https://www.npmjs.com/package/@johnhenry/browsermesh-primitives) (`PodIdentity`, an Ed25519 keypair whose `podId` is a base64url hash of its public key).

Why: a shared secret authenticates *that you're some agent this server trusts*, not *which* agent — every agent presents the same string, there's no revocation short of rotating the secret for everyone, and no way to tell agents apart at the auth layer. `dialback/browsermesh` gives each agent its own keypair; the server verifies a signed challenge before the connection is ever handed to `Server#addConnection()`, so a compromised or retired agent's key can simply stop being trusted without affecting any other agent.

Both `@johnhenry/browsermesh-netway` and `@johnhenry/browsermesh-primitives` are optional `peerDependencies` — install them yourself to use this module:

```bash
npm install @johnhenry/browsermesh-netway @johnhenry/browsermesh-primitives
```

### Usage

```javascript
import { Server, Agent } from "@johnhenry/dialback";
import {
  createBrowsermeshTransport,
  acceptBrowsermeshConnections,
} from "@johnhenry/dialback/browsermesh";
import { VirtualNetwork } from "@johnhenry/browsermesh-netway";
import { PodIdentity } from "@johnhenry/browsermesh-primitives";

// A VirtualNetwork is *your* responsibility to construct and configure. The
// default one (used below) only has its built-in LoopbackBackend, i.e.
// `mem://` addresses — real, in-process networking, good for same-process
// use and tests, but not cross-machine. For real cross-machine deployment,
// configure a `GatewayBackend` on your `VirtualNetwork` yourself (see
// `@johnhenry/browsermesh-netway`'s own docs) — this module takes whatever
// `VirtualNetwork` it's given and doesn't care which backend is behind it.
const net = new VirtualNetwork();

const serverIdentity = await PodIdentity.generate();
const agentIdentity = await PodIdentity.generate();

// `allowUnauthenticatedAgents: true` is correct and intentional here, not a
// security downgrade: by the time acceptBrowsermeshConnections() ever calls
// server.addConnection(), the connecting agent has already passed the
// identity handshake below — a connection that fails it is closed and never
// reaches the Server at all.
const server = new Server(undefined, { allowUnauthenticatedAgents: true });

const listener = await net.listen("mem://localhost:9000");
acceptBrowsermeshConnections(listener, server, serverIdentity); // long-running; don't await

const transport = createBrowsermeshTransport(net, agentIdentity);
const { serve } = new Agent("mem://localhost:9000", { transport });

serve(async (request) => new Response("Hello there!", { status: 200 }));
```

### The handshake

Run entirely inside the transport, before either side ever sees a `Connection`: the listener (mirroring how `Server` already validates incoming agents against its `secret` today) sends a random nonce; the connecting peer signs it with its `PodIdentity` and replies with `{ podId, publicKey, signature }`; the listener verifies the signature and that `podId` really is the hash of the supplied `publicKey`, then sends accept or reject. A rejected or malformed handshake closes the connection immediately — it's never wrapped as a `Connection` or handed to `Server#addConnection()`. See `transports/handshake.mjs` for the exact wire format and `transports/framing.mjs` for how `dialback`'s message-oriented protocol is framed (newline-delimited JSON) over `StreamSocket`'s raw byte stream.

This handshake is intentionally **one-directional** — the listener authenticates the connecting agent, not the other way around — exactly matching the asymmetry of the existing shared-`secret` model (an agent today has no way to verify the server's secret either). The listener does include its own `podId` in the initial challenge, but only informationally (not signed) — a connecting agent can log/identify which listener it reached, but that isn't cryptographic proof of the listener's identity.

### Honest limitations

- **No real backpressure signal.** `StreamSocket` has no `bufferedAmount`-equivalent — `write()` either succeeds or throws once the peer's buffer has already overflowed, with no graduated "getting full" signal in between. This transport's `Connection.bufferedAmount` always reports `0`, so `agent.mjs`'s/`server.mjs`'s backpressure-wait loops never actually block on it; writes are attempted eagerly and fail (loudly) only once the peer is already overwhelmed.
- **No mutual authentication.** As above, the connecting agent does not cryptographically verify the listener.

## Family

dialback isn't just a standalone WebSocket reverse proxy -- its optional
transport layer is the designed consumer of two sibling packages' identity
and networking primitives.

- **[`@johnhenry/browsermesh-primitives`](https://github.com/johnhenry/browsermesh)**
  -- `PodIdentity` (an Ed25519 keypair whose `podId` is a base64url hash of
  its public key) is what `dialback/browsermesh`'s handshake signs and
  verifies, replacing the built-in transport's single shared `secret`
  string with real per-agent identity. A real dependency on
  `@johnhenry/browsermesh-primitives`, **not** the other way around -- it's
  an optional `peerDependency`, never imported by plain `dialback`.
- **[`@johnhenry/browsermesh-netway`](https://github.com/johnhenry/browsermesh)**
  -- `VirtualNetwork`/`StreamSocket`/`Listener` are the virtual networking
  layer `dialback/browsermesh`'s transport runs Server/Agent connections
  over, in place of a raw WebSocket. Same optional-`peerDependency`
  relationship as above. See
  [Optional: the `dialback/browsermesh` transport](#optional-the-dialbackbrowsermesh-transport)
  for the full usage and handshake protocol.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

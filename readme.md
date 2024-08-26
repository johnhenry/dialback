# Le Proxy

[![npm version](https://badge.fury.io/js/leproxy.svg)](https://badge.fury.io/js/leproxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<img alt="LeRoute Logo" width="512" height="512" src="./logo.jpeg" style="width:512px;height:512px"/>

Library for creating a reverse proxy over websockets.

Request/Response <-HTTP-> [Server] <-WS-> [Agent]

## Quick Start

### Installation

```bash
npm install leproxy
```

### Usage with Node.js

1. Create Server (Node.js)

```javascript
import { Server } from "leproxy";
import http from 'http';
import { WebSocketServer } from 'ws';

const server = new Server(() => new Response("no responder", { status: 500 }));

const httpServer = http.createServer(async (req, res) => {
  const response = await server.fetch(req);
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
import { Agent } from "leproxy";

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
import { Server } from "npm:leproxy";
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
  - `strategy` (optional): A string specifying the agent selection strategy. Default is "first".
  - `secret` (optional): A string used for authentication between the server and agents.

#### Methods

- `addConnection(connection)`: Adds a WebSocket connection to the server.
- `removeConnection(connection)`: Removes a WebSocket connection from the server.
- `fetch(request)`: Handles an incoming HTTP request and returns a `Promise` that resolves to a `Response` object.
- `setStrategy(newStrategy)`: Sets the agent selection strategy.

#### Properties

- `strategy`: Gets or sets the current agent selection strategy.
- `fetch`: A bound version of the `fetch` method that can be used directly with HTTP server libraries.

### Agent

The `Agent` class is responsible for connecting to a Server and handling proxied requests.

#### Constructor

```javascript
new Agent(address, options)
```

- `address`: A string representing the WebSocket address of the server to connect to.
- `options`: An object with the following properties:
  - `reconnect` (optional): The number of milliseconds to wait before attempting to reconnect if the connection is lost.
  - `log` (optional): An integer representing the log level (0-4).
  - `abort` (optional): A function that returns a `Response` object when a request is aborted.
  - `secret` (optional): A string used for authentication between the server and agents.

#### Methods

- `serve(handler)`: Sets the request handler function for the agent. The handler function should accept a `Request` object and return a `Promise` that resolves to a `Response` object.

#### Properties

- `serve`: A bound version of the `serve` method that can be used to set the request handler.

### Utility Functions

#### upgradeWebSocket(req)

A utility function that creates a WebSocket connection from an HTTP request. This function is primarily used in Deno environments.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

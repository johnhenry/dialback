// Type definitions for dialback

export type ServerStrategy =
  | "first"
  | "last-used"
  | "random"
  | "round-robin"
  | "most-recent"
  | "last";

export interface ServerOptions {
  strategy?: ServerStrategy;
  secret?: string;
  /**
   * Without `secret`, the server has nothing to validate an agent
   * handshake against and would accept any agent with zero verification.
   * That must be opted into explicitly — the constructor throws if
   * neither `secret` nor this flag is provided.
   */
  allowUnauthenticatedAgents?: boolean;
  log?: number;
}

export interface AgentOptions {
  reconnect?: number;
  log?: number;
  abort?: () => Response | Promise<Response>;
  secret?: string;
  /**
   * Pluggable connection factory, used instead of `new WebSocket(address)`
   * when provided. Must resolve with an already-connected `Connection` --
   * any additional handshake the transport needs (e.g. an identity
   * challenge/response) should happen before this promise resolves. See
   * `dialback/browsermesh`'s `createBrowsermeshTransport()` for a concrete
   * implementation.
   */
  transport?: (address: string) => Promise<Connection>;
}

export interface Connection {
  send: (data: any) => void;
  addEventListener: (event: string, callback: (event: any) => void) => void;
  close: () => void;
  /**
   * `agent.mjs` and `server.mjs` also use a second, EventEmitter-style API
   * on top of the DOM-style one above (`.on("open"|"close", cb)`) and poll
   * `.bufferedAmount` for backpressure. The `ws` package's `WebSocket`
   * satisfies both simultaneously, which is why the existing code works
   * against it unmodified; any custom `Connection` (e.g. a `transport`
   * option's return value) needs to satisfy this same dual shape, not just
   * the narrower shape above. Declared optional here rather than folded
   * into the required shape, since not every caller passing a `Connection`
   * (e.g. into `Server#addConnection`) needs `"open"`/reconnect semantics.
   */
  on?: (event: string, callback: (...args: any[]) => void) => void;
  bufferedAmount?: number;
}

export interface ConnectionOptions {
  filter?: (data: any) => boolean;
  transform?: (data: any) => any;
  showSent?: boolean;
  showFiltered?: boolean;
  showRecieved?: boolean;
}

export type BufferOverRunStrategy = "error" | "drop" | "shift" | "die";

export interface InvertedAsyncIteratorOptions {
  bufferSize?: number;
  bufferOverrunStrategy?: BufferOverRunStrategy;
}

/**
 * `Server`/`Agent` are real, constructable classes at runtime
 * (`const Server = class { ... }` in server.mjs/agent.mjs, `new
 * Server(...)`/`new Agent(...)` -- confirmed by reading both files
 * directly), not plain interfaces -- declared as `declare class` here so
 * `new Server(...)` actually type-checks for consumers (previously
 * declared as bare `interface`s with no construct signature, which made
 * TypeScript reject `new Server(...)` with "only refers to a type, but is
 * being used as a value here"). `createServer`/`createAgent` factory
 * functions, previously declared below, were removed -- they don't exist
 * anywhere in the real runtime code (`index.mjs` only ever exports
 * `Server`/`Agent` directly), so they were phantom declarations.
 */
export declare class Server {
  constructor(defaultHandler?: () => Response | Promise<Response>, options?: ServerOptions);
  addConnection(connection: Connection): Promise<Connection>;
  removeConnection(connection: Connection): void;
  removeConnectionById(id: string): void;
  removeConnectionByIndex(index: number): void;
  getConnectionById(id: string): Connection | undefined;
  getConnectionByIndex(index: number): Connection | undefined;
  setStrategy(newStrategy: ServerStrategy): void;
  strategy: ServerStrategy;
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  readonly listening: boolean;
  fetch(
    request: Request | string,
    options?: RequestInit,
    moreOptions?: any
  ): Promise<Response>;
}

export declare class Agent {
  constructor(address: string, options?: AgentOptions);
  readonly connection: Promise<Connection>;
  serve(
    handler: (request: Request, options: { id: string }) => Promise<Response>
  ): void;
  close(): Promise<void>;
}

export declare function doConnection(
  connection: Connection,
  options?: ConnectionOptions
): [(data: any) => void, AsyncGenerator<any, void, unknown>, () => void];

export declare function invertedAsyncIterator(
  bufferSize?: number,
  bufferOverrunStrategy?: BufferOverRunStrategy
): [
  () => AsyncGenerator<any, void, unknown>,
  (data: any) => any,
  () => void,
  () => any
];

export declare function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
};

export declare function resolveAfter<T>(
  ms?: number,
  options?: { value?: T; signal?: AbortSignal }
): Promise<T>;

// Constants
export declare const KILLED: unique symbol;
export declare const bufferOverRunStrategies: {
  ERROR: "error";
  DROP: "drop";
  SHIFT: "shift";
  DIE: "die";
};
export declare const LOG_LEVELS: {
  NONE: 0;
  ERROR: 1;
  WARN: 2;
  INFO: 3;
  DEBUG: 4;
};

// Type definitions for leproxy

export type ServerStrategy = 'first' | 'last-used' | 'random' | 'round-robin' | 'most-recent' | 'last';

export interface ServerOptions {
  strategy?: ServerStrategy;
  secret?: string;
}

export interface AgentOptions {
  reconnect?: number;
  log?: number;
  abort?: () => Response;
  secret?: string;
}

export interface Connection {
  send: (data: any) => void;
  addEventListener: (event: string, callback: (event: any) => void) => void;
  close: () => void;
}

export interface ConnectionOptions {
  filter?: (data: any) => boolean;
  transform?: (data: any) => any;
  showSent?: boolean;
  showFiltered?: boolean;
  showRecieved?: boolean;
}

export type BufferOverRunStrategy = 'error' | 'drop' | 'shift' | 'die';

export interface InvertedAsyncIteratorOptions {
  bufferSize?: number;
  bufferOverrunStrategy?: BufferOverRunStrategy;
}

export interface Server {
  addConnection(connection: Connection): Promise<Connection>;
  removeConnection(connection: Connection): void;
  removeConnectionById(id: string): void;
  removeConnectionByIndex(index: number): void;
  getConnectionById(id: string): Connection | undefined;
  getConnectionByIndex(index: number): Connection | undefined;
  setStrategy(newStrategy: ServerStrategy): void;
  fetch(request: Request | string, options?: RequestInit, moreOptions?: any): Promise<Response>;
}

export interface Agent {
  connection: Promise<Connection>;
  serve(handler: (request: Request, options: { id: string }) => Promise<Response>): void;
}

export declare function createServer(defaultHandler?: () => Response, options?: ServerOptions): Server;
export declare function createAgent(address: string, options?: AgentOptions): Agent;

export declare function doConnection(
  connection: Connection,
  options?: ConnectionOptions
): [
  (data: any) => void,
  AsyncGenerator<any, void, unknown>,
  () => void
];

export declare function invertedAsyncIterator(
  bufferSize?: number,
  bufferOverrunStrategy?: BufferOverRunStrategy
): [
  () => AsyncGenerator<any, void, unknown>,
  (data: any) => any,
  () => void,
  () => any
];

export declare function invertedPromise<T>(): [Promise<T>, (value: T) => void, (reason?: any) => void];

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
  ERROR: 'error';
  DROP: 'drop';
  SHIFT: 'shift';
  DIE: 'die';
};
export declare const LOG_LEVELS: {
  NONE: 0;
  ERROR: 1;
  WARN: 2;
  INFO: 3;
  DEBUG: 4;
};
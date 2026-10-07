// Types for `@johnhenry/dialback/browsermesh`.
import type { PodIdentity } from "@johnhenry/browsermesh-primitives";
import type { Connection, Server } from "./types.d.ts";
import type { FrameReader, HandshakeSocket } from "./handshake.d.ts";

export { challengeConnectingPeer, respondToChallenge } from "./handshake.d.ts";
export type { HandshakeSocket, HandshakeOptions, FrameReader } from "./handshake.d.ts";

/** A netway `VirtualNetwork`/`ScopedNetwork`: anything with `connect(address)`. */
export interface BrowsermeshNetwork {
  connect(address: string): Promise<HandshakeSocket>;
}

/** A netway `Listener`: `accept()` resolves `null` once it is closed. */
export interface BrowsermeshListener {
  accept(): Promise<HandshakeSocket | null>;
}

export function createBrowsermeshTransport(
  net: BrowsermeshNetwork,
  identity: PodIdentity,
  options?: { timeoutMs?: number; log?: number }
): (address: string) => Promise<Connection>;

export function acceptBrowsermeshConnections(
  listener: BrowsermeshListener,
  server: Pick<Server, "addConnection">,
  identity: PodIdentity,
  options?: {
    timeoutMs?: number;
    log?: number;
    onConnection?: (connection: Connection, podId: string) => void;
    onRejected?: (error: Error, socket: HandshakeSocket) => void;
  }
): Promise<void>;

/** Adapts a byte-stream socket as a dialback `Connection`. */
export declare class StreamSocketConnection implements Connection {
  constructor(socket: HandshakeSocket, options?: { reader?: FrameReader });
  send(data: any): void;
  addEventListener(event: string, callback: (event: any) => void): void;
  on(event: string, callback: (...args: any[]) => void): this;
  close(): void;
  readonly bufferedAmount: number;
}

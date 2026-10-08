// `#websocket` for every non-`node` condition (browsers, workers, bundlers):
// the platform WebSocket, resolved lazily so importing this never throws in
// a runtime that lacks one and a late polyfill/mock is still picked up.
export default function PlatformWebSocket(...args) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("No global WebSocket available; pass a `transport` to Agent.");
  }
  return new globalThis.WebSocket(...args);
}

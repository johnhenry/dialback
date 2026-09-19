export { doConnection } from "./connection.mjs";
export { invertedAsyncIterator } from "./PromisesPlus.mjs";
export { routeEmptyFavicon } from "./routeEmptyFavicon.mjs";
// https://developer.mozilla.org/en-US/docs/Glossary/Base64

const base64ToBytes = (base64 = "") =>
  Uint8Array.from(atob(base64), (m) => m.codePointAt(0));
// Spreading the whole `bytes` array into `String.fromCodePoint(...bytes)`
// blows the call stack for large chunks (engines cap the number of
// arguments a function call can take, well under 1MB) — e.g. a single
// large request/response body chunk read from a stream. Process it in
// bounded-size slices instead so arbitrarily large payloads still encode.
const bytesToBase64 = (bytes = []) => {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCodePoint(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
};
const randId = (prefix = "") => {
  return `${prefix}${Math.random().toString(36).substring(2, 15)}`;
};

// // Usage
// bytesToBase64(new TextEncoder().encode("a Ā 𐀀 文 🦄")); // "YSDEgCDwkICAIOaWhyDwn6aE"
// new TextDecoder().decode(base64ToBytes("YSDEgCDwkICAIOaWhyDwn6aE")); // "a Ā 𐀀 文 🦄"

export { base64ToBytes, bytesToBase64, randId };

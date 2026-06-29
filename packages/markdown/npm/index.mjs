// @lumen-org/markdown -- Lumen Markdown renderer, compiled to wasm. Zero deps.
import fs from "node:fs";
const bytes = fs.readFileSync(new URL("./reactor.wasm", import.meta.url));
const wasi = new Proxy({}, { get: () => () => 0 });      // render is pure; stubs never run
const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
const ex = instance.exports, enc = new TextEncoder(), dec = new TextDecoder();
const inPtr = ex.__lumen_in_ptr(), inCap = ex.__lumen_in_cap();

/** Render a Markdown string to an HTML fragment. */
export function render(md) {
  const b = enc.encode(md);
  if (b.length > inCap) throw new RangeError("markdown too large");
  new Uint8Array(ex.memory.buffer).set(b, inPtr);
  const p = ex.__lumen_call_render(inPtr, b.length);
  return dec.decode(new Uint8Array(ex.memory.buffer, p, ex.__lumen_out_len()));
}

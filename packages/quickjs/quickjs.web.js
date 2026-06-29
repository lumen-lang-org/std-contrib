// quickjs.web.js -- web (wasm-target) binding for the `quickjs` package.
//
// The native build of this package links a real libqjs through `qjs_host.c`.
// On the wasm target there is no native linking, so a Lumen program that uses
// this package compiles to a module that imports the abstract FFI symbols
// `env.qjs_*`. This file is the package's *web binding*: it backs those symbols
// with a wasm build of QuickJS, pinned HERE with the package. A consumer needs
// no `brew install` and no file copying -- a Lumen wasm host fetches this module
// straight from the package URL (and the browser caches it), so the engine and
// its version travel with the package.
//
// A host (e.g. the playground) loads this module by URL, calls
// `createBinding(getInstance)`, and merges the returned table into the `env`
// import object before instantiating the program.

// The QuickJS engine, pinned with the package. Swap this single line to move
// providers or bump the version; consumers pick it up automatically.
import { getQuickJS } from "https://esm.sh/quickjs-emscripten@0.29.2";

// The FFI symbols this binding satisfies. A host matches a compiled module's
// `env.*` imports against this list to decide whether it needs this binding.
export const provides = [
  "qjs_open", "qjs_close",
  "qjs_set_int", "qjs_set_number", "qjs_set_bool", "qjs_set_string",
  "qjs_eval_int", "qjs_eval_number", "qjs_eval_bool", "qjs_eval_string",
  "qjs_get_int", "qjs_get_number", "qjs_get_bool", "qjs_get_string",
  "qjs_last_error",
];

let _engine = null;
function engine() { return _engine ?? (_engine = getQuickJS()); }

// Build the `env.qjs_*` table backed by a wasm QuickJS context. `getInstance`
// returns the running Lumen wasm instance: its linear memory carries FFI string
// arguments, and its exported `__lumen_ffi_buf` receives string returns (valid
// only until the next FFI call -- the package's documented contract).
export async function createBinding(getInstance) {
  const QuickJS = await engine();
  let vm = null, lastError = "";
  let scratchPtr = 0, scratchLen = 0;
  const exps = () => getInstance().exports;
  const mem = () => new Uint8Array(exps().memory.buffer);
  const scratch = () => {
    if (!scratchPtr) { scratchPtr = exps().__lumen_ffi_buf_ptr(); scratchLen = exps().__lumen_ffi_buf_len(); }
    return [scratchPtr, scratchLen];
  };
  const readStr = (ptr) => {
    const m = mem(); let e = ptr; while (m[e] !== 0) e++;
    return new TextDecoder().decode(m.subarray(ptr, e));
  };
  const retStr = (s) => {
    const [ptr, len] = scratch();
    const b = new TextEncoder().encode(s);
    const n = Math.min(b.length, len - 1);
    const m = mem(); m.set(b.subarray(0, n), ptr); m[ptr + n] = 0;
    return ptr;
  };
  const evalCode = (src) => {
    const r = vm.evalCode(src);
    if (r.error) { lastError = String(vm.dump(r.error)); r.error.dispose(); return undefined; }
    const v = vm.dump(r.value); r.value.dispose(); lastError = ""; return v;
  };
  const setGlobal = (name, h) => { vm.setProp(vm.global, name, h); h.dispose(); };
  const getGlobal = (name) => { const h = vm.getProp(vm.global, name); const v = vm.dump(h); h.dispose(); return v; };
  return {
    qjs_open: () => { vm = QuickJS.newContext(); lastError = ""; },
    qjs_close: () => { if (vm) { vm.dispose(); vm = null; } },
    qjs_set_int: (np, v) => setGlobal(readStr(np), vm.newNumber(v)),
    qjs_set_number: (np, v) => setGlobal(readStr(np), vm.newNumber(v)),
    qjs_set_bool: (np, v) => setGlobal(readStr(np), v ? vm.true : vm.false),
    qjs_set_string: (np, vp) => setGlobal(readStr(np), vm.newString(readStr(vp))),
    qjs_eval_int: (sp) => (evalCode(readStr(sp)) | 0),
    qjs_eval_number: (sp) => (Number(evalCode(readStr(sp))) || 0),
    qjs_eval_bool: (sp) => (evalCode(readStr(sp)) ? 1 : 0),
    qjs_eval_string: (sp) => retStr(String(evalCode(readStr(sp)) ?? "")),
    qjs_get_int: (np) => (getGlobal(readStr(np)) | 0),
    qjs_get_number: (np) => (Number(getGlobal(readStr(np))) || 0),
    qjs_get_bool: (np) => (getGlobal(readStr(np)) ? 1 : 0),
    qjs_get_string: (np) => retStr(String(getGlobal(readStr(np)) ?? "")),
    qjs_last_error: () => retStr(lastError),
  };
}

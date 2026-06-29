# quickjs

Embed a [QuickJS](https://github.com/quickjs-ng/quickjs) JavaScript sandbox in a
compiled Lumen program via FFI. The Lumen host stays a single static native
binary; only the script text you pass to the `eval*` functions is dynamic.

Values cross the boundary in both directions:

- **Lumen -> QuickJS** with `set*` (define globals the script can read)
- **QuickJS -> Lumen** with `eval*` (coerce a result) and `get*` (read a global back out)

## API

```ts
function open(): void;
function close(): void;

function setInt(name: string, value: int): void;
function setNumber(name: string, value: number): void;
function setBool(name: string, value: bool): void;
function setString(name: string, value: string): void;

function evalInt(src: string): int;
function evalNumber(src: string): number;
function evalBool(src: string): bool;
function evalString(src: string): string;

function getInt(name: string): int;
function getNumber(name: string): number;
function getBool(name: string): bool;
function getString(name: string): string;

function lastError(): string;   // "" if the last eval succeeded, else the message
```

## Install QuickJS

```sh
brew install quickjs-ng
```

This package was built and tested against **quickjs-ng 0.15.1** (Homebrew), which
installs the header at `/opt/homebrew/opt/quickjs-ng/include/quickjs.h` and the
runtime at `/opt/homebrew/opt/quickjs-ng/lib/libqjs.dylib`. The original
Bellard `quickjs` also works — the small API surface used by the shim is
identical; substitute its header/lib paths below.

## Build (local build model)

Unlike pure-Lumen packages, `quickjs` carries a C shim (`qjs_host.c`) that wraps
the QuickJS C API behind a scalar+string FFI surface. **A URL import alone cannot
carry the C shim**, so this package is built locally: copy both `quickjs.ts` and
`qjs_host.c` next to your app, compile the shim once, then build:

```sh
cp .../packages/quickjs/quickjs.ts .../packages/quickjs/qjs_host.c .

# compile the C shim against the QuickJS headers
cc -c qjs_host.c -I/opt/homebrew/opt/quickjs-ng/include -o qjs_host.o

# build your app; the // @link pragmas in quickjs.ts pull in qjs_host.o,
# libqjs, and libc
lumen compile app.ts
./app
```

The `// @link` pragmas in `quickjs.ts` are:

```ts
// @link ./qjs_host.o
// @link /opt/homebrew/opt/quickjs-ng/lib/libqjs.dylib
// @link c
```

If your QuickJS install prefix differs, adjust the absolute `libqjs.dylib` path
(and the `-I` include dir on the `cc` line) to match. If the link fails on your
platform, also try adding `// @link m`, `// @link pthread`, or `// @link dl`.

## Example

```ts
import { open, close, setInt, evalNumber, getString } from "https://lumen-lang.org/package/std-contrib/quickjs/quickjs.ts";

open();
using _ = defer(() => close());

setInt("base", 21);
console.log(evalNumber("base * 2 + Math.sqrt(16)"));   // 46

// export a var computed inside the sandbox back to Lumen:
evalNumber("globalThis.greeting = 'hi ' + base");
console.log(getString("greeting"));                    // hi 21
```

## V1 model

A single process-global QuickJS runtime + context (one VM per program). String
results from `eval*` / `get*` live in a static buffer valid only until the next
call into the shim; Lumen copies the bytes at the FFI boundary, so this is safe
for V1's single-threaded use. Multiple VMs, handle-based contexts, and exporting
structured JS values are future revisions — see `SPEC.md`.

## Web binding (wasm target)

On the wasm target there is no native linking, so the `cc`/`brew`/`@link` steps
above do not apply. Instead this package ships `quickjs.web.js`, a **web
binding** that backs the package's FFI symbols (`qjs_*`) with a wasm build of
QuickJS, pinned to a version here in the package. A Lumen wasm host loads it
straight from the package URL — so a consumer needs no install and no file
copying; the engine travels with the package.

A host (such as the playground) compiles the program, sees it imports `qjs_*`,
loads this module, and wires up the env table:

```js
import { createBinding } from "https://lumen-lang.org/package/std-contrib/quickjs/quickjs.web.js";
// `getInstance` returns the running Lumen wasm instance.
const env = await createBinding(getInstance);
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1, env });
```

String arguments cross in the program's linear memory; string results are
written into the program's exported `__lumen_ffi_buf` scratch buffer (the same
"valid until the next call" contract as the native shim). To move providers or
bump the engine version, edit the single import line at the top of
`quickjs.web.js`; consumers pick it up automatically.

## Security

The embedded code runs **arbitrary JavaScript** and gets **none of Lumen's
static guarantees**. Only `eval*` what you trust, or what you have otherwise
sandboxed. The current V1 sets no resource limits or interrupt handler.

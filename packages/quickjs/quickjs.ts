// quickjs -- embed a QuickJS JavaScript sandbox in a compiled Lumen program.
//
// The Lumen host stays a single static native binary; only the script text you
// pass to the eval* functions is dynamic. Values cross the boundary in both
// directions: Lumen -> QuickJS via set*, and QuickJS -> Lumen via eval* / get*.
//
// This package is plain Lumen + a small C shim (qjs_host.c) linked through the
// FFI. Because a URL import alone cannot carry the C shim, this package is built
// locally: see README.md. Build the shim first, e.g.
//
//   cc -c qjs_host.c -I/opt/homebrew/opt/quickjs-ng/include -o qjs_host.o
//   lumen compile app.ts
//
// SECURITY: the embedded code runs arbitrary JavaScript and gets none of
// Lumen's static guarantees.

// The compiled C shim, sitting next to your app at build time.
// @link ./qjs_host.o
// The QuickJS runtime (quickjs-ng, Homebrew). Absolute path is passed to the
// linker verbatim; adjust if your install prefix differs.
// @link /opt/homebrew/opt/quickjs-ng/lib/libqjs.dylib
// The C standard library, used by the shim (snprintf/strlen).
// @link c

declare function qjs_open(): void;
declare function qjs_close(): void;

declare function qjs_set_int(name: string, value: int): void;
declare function qjs_set_number(name: string, value: number): void;
declare function qjs_set_bool(name: string, value: bool): void;
declare function qjs_set_string(name: string, value: string): void;

declare function qjs_eval_int(src: string): int;
declare function qjs_eval_number(src: string): number;
declare function qjs_eval_bool(src: string): bool;
declare function qjs_eval_string(src: string): string;

declare function qjs_get_int(name: string): int;
declare function qjs_get_number(name: string): number;
declare function qjs_get_bool(name: string): bool;
declare function qjs_get_string(name: string): string;

declare function qjs_last_error(): string;

// Open the process-global QuickJS runtime + context. Call once before use.
export function open(): void { qjs_open(); }
// Free the runtime + context. Pair with `using _ = defer(() => close());` after open.
export function close(): void { qjs_close(); }

// Lumen -> QuickJS: define globals the evaluated script can read.
export function setInt(name: string, value: int): void { qjs_set_int(name, value); }
export function setNumber(name: string, value: number): void { qjs_set_number(name, value); }
export function setBool(name: string, value: bool): void { qjs_set_bool(name, value); }
export function setString(name: string, value: string): void { qjs_set_string(name, value); }

// Evaluate a script and coerce the result to a Lumen type.
export function evalInt(src: string): int { return qjs_eval_int(src); }
export function evalNumber(src: string): number { return qjs_eval_number(src); }
export function evalBool(src: string): bool { return qjs_eval_bool(src); }
export function evalString(src: string): string { return qjs_eval_string(src); }

// QuickJS -> Lumen: export a named global's value back out.
export function getInt(name: string): int { return qjs_get_int(name); }
export function getNumber(name: string): number { return qjs_get_number(name); }
export function getBool(name: string): bool { return qjs_get_bool(name); }
export function getString(name: string): string { return qjs_get_string(name); }

// "" if the last eval succeeded, else the exception message.
export function lastError(): string { return qjs_last_error(); }

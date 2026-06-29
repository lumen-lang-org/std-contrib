# std-contrib package: `quickjs`

**Status**: Draft | **Depends on**: compiler feature 023 (FFI string marshalling)

Embed a QuickJS sandbox inside a compiled Lumen program. The Lumen host stays a
single native binary; only the explicitly-evaluated script is dynamic. Values
cross the boundary in both directions: Lumen -> QuickJS (set globals) and
QuickJS -> Lumen (read globals / eval results) — the export direction.

This is a **community** package: it is plain Lumen + a small C shim linked via the
existing FFI. Nothing is baked into the toolchain. The embedded code runs
JavaScript and gets none of Lumen's static guarantees.

## Layout

```
packages/quickjs/
  qjs_host.c        # extern "C" shim over QuickJS (hides JSValue/pointers)
  quickjs.ts        # Lumen wrapper: typed extern declarations + helpers
  README.md         # how to install libquickjs and build
  SPEC.md           # this file
```

## V1 model

A single process-global QuickJS runtime + context (one VM per program). This
keeps the FFI surface scalar+string only — no opaque pointer handles needed in
V1. (A multi-VM, handle-based version is a future revision.)

## API (Lumen, `quickjs.ts`)

```ts
export function open(): void;
export function close(): void;

// Lumen -> QuickJS: define globals the script can read.
export function setInt(name: string, value: int): void;
export function setNumber(name: string, value: number): void;
export function setBool(name: string, value: bool): void;
export function setString(name: string, value: string): void;

// Evaluate a script, coercing the result to a Lumen type.
export function evalInt(src: string): int;
export function evalNumber(src: string): number;
export function evalBool(src: string): bool;
export function evalString(src: string): string;

// QuickJS -> Lumen: export a global variable's value back out.
export function getInt(name: string): int;
export function getNumber(name: string): number;
export function getBool(name: string): bool;
export function getString(name: string): string;

// "" if the last eval succeeded, else the exception message.
export function lastError(): string;
```

## C shim (`qjs_host.c`, sketch)

```c
#include <quickjs.h>
#include <string.h>

static JSRuntime *rt; static JSContext *ctx;
static char errbuf[1024];

void qjs_open(void)  { rt = JS_NewRuntime(); ctx = JS_NewContext(rt); errbuf[0]=0; }
void qjs_close(void) { JS_FreeContext(ctx); JS_FreeRuntime(rt); }

static void set(const char *name, JSValue v) {
  JSValue g = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, g, name, v);
  JS_FreeValue(ctx, g);
}
void qjs_set_int(const char *n, int v)        { set(n, JS_NewInt32(ctx, v)); }
void qjs_set_number(const char *n, double v)  { set(n, JS_NewFloat64(ctx, v)); }
void qjs_set_bool(const char *n, int v)       { set(n, JS_NewBool(ctx, v)); }
void qjs_set_string(const char *n, const char *v) { set(n, JS_NewString(ctx, v)); }

static JSValue eval(const char *src) {
  JSValue v = JS_Eval(ctx, src, strlen(src), "<lumen>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(v)) {
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    snprintf(errbuf, sizeof errbuf, "%s", s ? s : "error");
    JS_FreeCString(ctx, s); JS_FreeValue(ctx, e);
  } else errbuf[0] = 0;
  return v;
}

double qjs_eval_number(const char *src) {
  JSValue v = eval(src); double o = 0; JS_ToFloat64(ctx, &o, v);
  JS_FreeValue(ctx, v); return o;
}
// qjs_eval_int / qjs_eval_bool similar (JS_ToInt32 / JS_ToBool).

// String results use a static buffer valid until the next call; Lumen copies it
// immediately at the FFI boundary (feature 023 ownership rule).
static char strbuf[4096];
const char *qjs_eval_string(const char *src) {
  JSValue v = eval(src);
  const char *s = JS_ToCString(ctx, v);
  snprintf(strbuf, sizeof strbuf, "%s", s ? s : "");
  JS_FreeCString(ctx, s); JS_FreeValue(ctx, v);
  return strbuf;
}

// getters: read a named global and coerce (qjs -> lumen export direction).
static JSValue get(const char *name) {
  JSValue g = JS_GetGlobalObject(ctx);
  JSValue v = JS_GetPropertyStr(ctx, g, name);
  JS_FreeValue(ctx, g); return v;
}
int qjs_get_int(const char *n) { JSValue v=get(n); int o=0; JS_ToInt32(ctx,&o,v); JS_FreeValue(ctx,v); return o; }
const char *qjs_get_string(const char *n) {
  JSValue v=get(n); const char *s=JS_ToCString(ctx,v);
  snprintf(strbuf,sizeof strbuf,"%s",s?s:""); JS_FreeCString(ctx,s); JS_FreeValue(ctx,v); return strbuf;
}
const char *qjs_last_error(void) { return errbuf; }
```

## Lumen wrapper (`quickjs.ts`, sketch)

```ts
// @link ./qjs_host.o
// @link quickjs
declare function qjs_open(): void;
declare function qjs_close(): void;
declare function qjs_set_int(name: string, value: int): void;
declare function qjs_set_string(name: string, value: string): void;
declare function qjs_eval_number(src: string): number;
declare function qjs_eval_string(src: string): string;
declare function qjs_get_int(name: string): int;
declare function qjs_get_string(name: string): string;
declare function qjs_last_error(): string;

export function open(): void { qjs_open(); }
export function close(): void { qjs_close(); }
export function setInt(name: string, value: int): void { qjs_set_int(name, value); }
export function setString(name: string, value: string): void { qjs_set_string(name, value); }
export function evalNumber(src: string): number { return qjs_eval_number(src); }
export function evalString(src: string): string { return qjs_eval_string(src); }
export function getInt(name: string): int { return qjs_get_int(name); }
export function getString(name: string): string { return qjs_get_string(name); }
export function lastError(): string { return qjs_last_error(); }
```

## Usage

```ts
import { open, close, setInt, evalNumber, getString } from
  "https://lumen-lang.org/package/std-contrib/quickjs/quickjs.ts";

open();
using _ = defer(() => close());

setInt("base", 21);
const n = evalNumber("base * 2 + Math.sqrt(16)");   // 46
console.log(n);

// export a var computed inside the sandbox back to Lumen:
evalNumber("globalThis.greeting = 'hi ' + base");
console.log(getString("greeting"));                  // hi 21
```

## Build (documented in README)

```sh
cc -c qjs_host.c -o qjs_host.o -I/path/to/quickjs
lumen compile app.ts        # // @link pulls in qjs_host.o + libquickjs
```

## Out of scope (future revisions)

Multiple VMs / handle-based contexts, calling Lumen functions from JS, exporting
JS objects/arrays/functions as structured Lumen values, module loading inside the
sandbox, resource limits / interrupt handler. V1 is scalar + string values
across a single global VM.

/* qjs_host.c -- a plain-C shim over QuickJS for the Lumen `quickjs` package.
 *
 * Hides JSValue / pointer handles behind a scalar+string FFI surface so the
 * Lumen wrapper (quickjs.ts) only ever deals in int / double / bool / C string.
 *
 * V1 model: a single process-global JSRuntime + JSContext (one VM per program).
 *
 * String results live in a static buffer that is valid only until the next
 * call into this shim; Lumen copies the bytes immediately at the FFI boundary
 * (feature 023 ownership rule), so this is safe for the single-threaded V1 use.
 *
 * Built against quickjs-ng (header: quickjs.h, lib: libqjs). The QuickJS-ng and
 * Bellard-QuickJS APIs used here are identical, so this also builds against the
 * original quickjs if its headers/lib are substituted.
 */
#include <quickjs.h>
#include <string.h>
#include <stdio.h>

static JSRuntime *rt;
static JSContext *ctx;
static char errbuf[1024];
static char strbuf[4096];

void qjs_open(void) {
    rt = JS_NewRuntime();
    ctx = JS_NewContext(rt); /* includes the standard intrinsics (Math, JSON, ...) */
    errbuf[0] = 0;
}

void qjs_close(void) {
    if (ctx) { JS_FreeContext(ctx); ctx = 0; }
    if (rt)  { JS_FreeRuntime(rt);  rt = 0; }
}

/* ---- Lumen -> QuickJS: define globals the script can read --------------- */

static void set_global(const char *name, JSValue v) {
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, name, v);
    JS_FreeValue(ctx, g);
}

void qjs_set_int(const char *n, int v)             { set_global(n, JS_NewInt32(ctx, v)); }
void qjs_set_number(const char *n, double v)       { set_global(n, JS_NewFloat64(ctx, v)); }
void qjs_set_bool(const char *n, int v)            { set_global(n, JS_NewBool(ctx, v ? 1 : 0)); }
void qjs_set_string(const char *n, const char *v)  { set_global(n, JS_NewString(ctx, v ? v : "")); }

/* ---- evaluation -------------------------------------------------------- */

static JSValue eval_src(const char *src) {
    JSValue v = JS_Eval(ctx, src, strlen(src), "<lumen>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) {
        JSValue e = JS_GetException(ctx);
        const char *s = JS_ToCString(ctx, e);
        snprintf(errbuf, sizeof errbuf, "%s", s ? s : "error");
        if (s) JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
    } else {
        errbuf[0] = 0;
    }
    return v;
}

int qjs_eval_int(const char *src) {
    JSValue v = eval_src(src);
    int32_t o = 0;
    JS_ToInt32(ctx, &o, v);
    JS_FreeValue(ctx, v);
    return (int)o;
}

double qjs_eval_number(const char *src) {
    JSValue v = eval_src(src);
    double o = 0;
    JS_ToFloat64(ctx, &o, v);
    JS_FreeValue(ctx, v);
    return o;
}

int qjs_eval_bool(const char *src) {
    JSValue v = eval_src(src);
    int o = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    return o > 0 ? 1 : 0;
}

const char *qjs_eval_string(const char *src) {
    JSValue v = eval_src(src);
    const char *s = JS_ToCString(ctx, v);
    snprintf(strbuf, sizeof strbuf, "%s", s ? s : "");
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return strbuf;
}

/* ---- QuickJS -> Lumen: export a named global back out ------------------ */

static JSValue get_global(const char *name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    return v;
}

int qjs_get_int(const char *n) {
    JSValue v = get_global(n);
    int32_t o = 0;
    JS_ToInt32(ctx, &o, v);
    JS_FreeValue(ctx, v);
    return (int)o;
}

double qjs_get_number(const char *n) {
    JSValue v = get_global(n);
    double o = 0;
    JS_ToFloat64(ctx, &o, v);
    JS_FreeValue(ctx, v);
    return o;
}

int qjs_get_bool(const char *n) {
    JSValue v = get_global(n);
    int o = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    return o > 0 ? 1 : 0;
}

const char *qjs_get_string(const char *n) {
    JSValue v = get_global(n);
    const char *s = JS_ToCString(ctx, v);
    snprintf(strbuf, sizeof strbuf, "%s", s ? s : "");
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return strbuf;
}

const char *qjs_last_error(void) { return errbuf; }

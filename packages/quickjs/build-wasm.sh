#!/bin/sh
# Reproducibly build qjs-wasm.a -- the prebuilt wasm archive that quickjs.ts
# references with `// @wasm-link`. It bundles this package's shim (qjs_host.c)
# plus QuickJS-ng, compiled to wasm32-wasi and archived. Run this once per engine
# version and publish the resulting qjs-wasm.a at the @wasm-link URL; consumers
# never build anything -- they just `import` quickjs.ts and the compiler fetches
# and links this archive.
#
#   ./build-wasm.sh        # writes ./qjs-wasm.a
#
# Requires `zig` (>= 0.16) on PATH; zig's `cc`/`build-lib` is the C toolchain.
set -eu

QUICKJS_NG_REF="${QUICKJS_NG_REF:-377a25e0e646356670eef3d3f03d9c4839b23d6d}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --filter=blob:none https://github.com/quickjs-ng/quickjs.git "$work/qjs"
git -C "$work/qjs" checkout --quiet "$QUICKJS_NG_REF"

# The 4 core engine sources + this package's shim, archived into one static lib.
zig build-lib \
  "$here/qjs_host.c" \
  "$work/qjs/quickjs.c" "$work/qjs/dtoa.c" "$work/qjs/libregexp.c" "$work/qjs/libunicode.c" \
  -target wasm32-wasi -O ReleaseSmall -I"$work/qjs" -I"$here" \
  -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL -lc \
  -femit-bin="$here/qjs-wasm.a"

echo "wrote $here/qjs-wasm.a (quickjs-ng $QUICKJS_NG_REF)"

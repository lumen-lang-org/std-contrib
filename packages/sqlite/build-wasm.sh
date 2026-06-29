#!/bin/sh
# Reproducibly build sqlite-wasm.a -- the prebuilt wasm archive that sqlite.ts
# references with `// @wasm-link`. It bundles this package's shim (sqlite_shim.c)
# plus the SQLite amalgamation, compiled to wasm32-wasi and archived. Run this
# once per SQLite version and publish the resulting sqlite-wasm.a at the
# @wasm-link URL; consumers never build anything -- they just `import` sqlite.ts
# and the compiler fetches and links this archive.
#
#   ./build-wasm.sh        # writes ./sqlite-wasm.a
#
# Requires `zig` (>= 0.16) and `curl`/`unzip` on PATH.
set -eu

SQLITE_AMALGAMATION_URL="${SQLITE_AMALGAMATION_URL:-https://sqlite.org/2026/sqlite-amalgamation-3530300.zip}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "$SQLITE_AMALGAMATION_URL" -o "$work/amalg.zip"
( cd "$work" && unzip -oj amalg.zip >/dev/null )

# The single-file amalgamation + this package's shim, archived into one static
# lib. The OMIT/THREADSAFE defines keep it small and portable on wasi-libc;
# in-memory databases (":memory:") need no host filesystem.
zig build-lib \
  "$here/sqlite_shim.c" "$work/sqlite3.c" \
  -target wasm32-wasi -O ReleaseSmall -I"$work" -I"$here" \
  -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_WAL -DSQLITE_DISABLE_LFS \
  -lc -femit-bin="$here/sqlite-wasm.a"

echo "wrote $here/sqlite-wasm.a ($SQLITE_AMALGAMATION_URL)"

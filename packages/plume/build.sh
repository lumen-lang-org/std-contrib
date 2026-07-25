#!/bin/sh
# Build the libpq shim this package links against.
#   Debian, Ubuntu   apt install libpq-dev
#   macOS            brew install postgresql@17
set -e
cd "$(dirname "$0")"
if command -v pg_config >/dev/null 2>&1; then
  INCLUDE="$(pg_config --includedir)"
else
  INCLUDE="/usr/include/postgresql"
  [ -d "$INCLUDE" ] || INCLUDE="/opt/homebrew/include/postgresql@17"
fi
[ -f "$INCLUDE/libpq-fe.h" ] || { echo "libpq headers not found — install libpq-dev or postgresql"; exit 1; }
cc -c plume_shim.c -I"$INCLUDE" -o plume_shim.o
echo "built plume_shim.o against $INCLUDE"

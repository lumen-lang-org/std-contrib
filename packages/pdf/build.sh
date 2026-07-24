#!/bin/sh
# Build the Poppler shim this package links against.
#
# The FFI form (pdf_ffi.ts) needs poppler-cpp's headers and library; the
# subprocess form (pdf.ts) needs neither and works without running this.
#
#   Debian, Ubuntu   apt install libpoppler-cpp-dev
#   macOS            brew install poppler
set -e
cd "$(dirname "$0")"

INCLUDE="/usr/include/poppler/cpp"
[ -d "$INCLUDE" ] || INCLUDE="/opt/homebrew/include/poppler/cpp"
[ -d "$INCLUDE" ] || INCLUDE="/usr/local/include/poppler/cpp"
[ -d "$INCLUDE" ] || { echo "poppler-cpp headers not found — install libpoppler-cpp-dev or poppler"; exit 1; }

c++ -c poppler_shim.cpp -I"$INCLUDE" -o poppler_shim.o
echo "built poppler_shim.o against $INCLUDE"

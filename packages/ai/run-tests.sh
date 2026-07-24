#!/bin/sh
# Run every test file in the ai package. Each `*.test.ts` sits beside the module
# it covers and can also be run on its own:
#   lumen test packages/ai/rag/vector.test.ts
set -e
cd "$(dirname "$0")/../.."
total=0
fail=0
for f in $(find packages/ai -name '*.test.ts' | sort); do
  # lumen writes its test report to stderr
  out=$(lumen test "$f" 2>&1 | tail -1)
  n=$(printf '%s' "$out" | grep -oE '^[0-9]+' || true)
  [ -n "$n" ] || n=0
  case "$out" in
    *failed*) fail=$((fail + 1)) ;;
  esac
  total=$((total + n))
  printf '%-42s %s\n' "$f" "$out"
done
printf '\n%s tests passed across the package\n' "$total"
[ "$fail" -eq 0 ] || { printf '%s file(s) had failures\n' "$fail"; exit 1; }

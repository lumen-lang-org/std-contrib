#!/bin/sh
# Hammer concurrent_server.ts and check every answer against what was asked.
#
#   sh examples/concurrent_client.sh [port] [workers]
#
# Each worker writes its own record, asks for the whole collection (a large
# result set, which is what a shim with process-wide state would leave behind),
# and then asks for its own record back by id. The record it gets must be the
# one it asked for: a wrong id, a wrong name, or a 404 means two requests
# shared a result set.
PORT="${1:-19311}"
WORKERS="${2:-60}"
BASE="http://127.0.0.1:$PORT/agents"
OUT="${TMPDIR:-/tmp}/plume_conc_$$"
mkdir -p "$OUT"

: >"$OUT/failures"
: >"$OUT/ok"
export OUT PORT
seq 1 "$WORKERS" | xargs -P "$WORKERS" -I{} sh -c '
  n="$1"; port="$2"; out="$3"
  id="c$n"; name="agent-$n"; base="http://127.0.0.1:$port/agents"
  curl -s -o /dev/null -X POST -d "{\"id\":\"$id\",\"agentName\":\"$name\",\"maxSteps\":$n}" "$base"
  curl -s -o /dev/null "$base"
  body=$(curl -s -w "\n%{http_code}" "$base/$id")
  code=$(printf "%s" "$body" | tail -1)
  doc=$(printf "%s" "$body" | sed "\$d")
  if [ "$code" != "200" ]; then echo "$id: HTTP $code ${doc}" >>"$out/failures"; exit 0; fi
  case "$doc" in *"\"id\":\"$id\""*) ;; *) echo "$id: wrong record ${doc}" >>"$out/failures"; exit 0 ;; esac
  case "$doc" in *"\"agentName\":\"$name\""*) ;; *) echo "$id: wrong name ${doc}" >>"$out/failures"; exit 0 ;; esac
  echo "$id" >>"$out/ok"
' _ {} "$PORT" "$OUT"

passed=$(wc -l <"$OUT/ok" | tr -d ' ')
failed=$(wc -l <"$OUT/failures" | tr -d ' ')
echo "workers $WORKERS  correct $passed  wrong $failed"
if [ "$failed" != "0" ]; then
  echo "--- failures (first 15) ---"
  head -15 "$OUT/failures"
fi
rm -rf "$OUT"
[ "$failed" = "0" ] && [ "$passed" = "$WORKERS" ]

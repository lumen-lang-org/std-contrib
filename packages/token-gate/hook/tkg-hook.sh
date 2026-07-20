#!/usr/bin/env bash
# tkg-hook.sh — Claude Code PreToolUse hook that routes supported Bash commands
# through the `tkg` proxy so their output reaches the model already compressed.
#
# Wire it in .claude/settings.json (see settings.snippet.json in this folder).
# Requires: `tkg` on PATH (or set TKG_BIN), and `jq`.
#
# Behaviour: reads the PreToolUse event JSON on stdin, and if the command is a
# single supported invocation (no pipes, redirects, &&/||/;), rewrites it to
# `tkg <command>`. Everything else passes through untouched. Fail-open: any
# error emits no decision and Claude runs the original command.

set -euo pipefail

TKG_BIN="${TKG_BIN:-tkg}"

# Read the whole event; bail out (pass-through) if jq or the field is missing.
input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -n "$command" ] || exit 0

# Only rewrite simple, single commands — never anything with shell operators.
case "$command" in
  *"|"* | *"&&"* | *"||"* | *";"* | *">"* | *"<"* | *'`'* | *'$('* ) exit 0 ;;
esac

first="$(printf '%s' "$command" | awk '{print $1}')"
second="$(printf '%s' "$command" | awk '{print $2}')"

supported=0
case "$first" in
  ls|find|du|grep|rg|ps|tsc|eslint|ruff|mypy|pytest|jest) supported=1 ;;
  git)
    case "$second" in status|log|diff|show) supported=1 ;; esac ;;
  docker)
    case "$second" in ps|images) supported=1 ;; esac ;;
  kubectl)
    case "$second" in get) supported=1 ;; esac ;;
  cargo)
    case "$second" in build|check|clippy|test) supported=1 ;; esac ;;
  npm|go)
    case "$second" in test) supported=1 ;; esac ;;
  zig)
    case "$second" in build) supported=1 ;; esac ;;
esac

[ "$supported" -eq 1 ] || exit 0

rewritten="$TKG_BIN $command"

# Emit the updated command. Claude Code applies updatedInput for PreToolUse.
jq -cn --arg cmd "$rewritten" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: { command: $cmd }
  }
}'

# token-gate

Token-optimizing command proxy (`tkg`): run a command and compress its output
before it reaches an AI assistant's context window.

Measured against the Rust `rtk` proxy on the same machine:

| Case | bare | rtk | tkg |
|------|------|-----|-----|
| `git status` | 281 B | 38 B | 19 B (+branch line) |
| 500-line dump | 1892 B | 1892 B | 140 B |
| `git log -20` | 3878 B | 1963 B | 1902 B |
| `git diff` (3 commits) | 33268 B | 19285 B | 1549 B (diffstat) |
| overhead per call | — | ~11 ms | ~0.8 ms |

## Per-command handlers

- `git status` — branch/ahead-behind line + changes grouped by kind
  (`untracked (2): a.txt, b.txt`)
- `git log` — `shorthash subject` per commit
- `git diff` / `git show` — diffstat only, with a hint to run the plain
  command for hunks
- `ls` — names + human sizes, permission/owner columns dropped, dirs marked `/`
- `find` — paths grouped by top-level directory with counts and examples
- `du` — largest entries first, top 20
- `grep` / `rg` — max 3 matches per file, `+N more matches` marker
- `ps`, `docker ps` / `docker images`, `kubectl get` — table header + capped
  rows (`... +N more rows`)
- linters/compilers (`tsc`, `eslint`, `cargo build`/`check`/`clippy`, `ruff`,
  `mypy`) — errors and warnings only, plus a one-line verdict
- test runners (`zig build`, `cargo test`, `npm test`, `go test`, `pytest`,
  `jest`) — failures/errors/summary only, plus a one-line verdict
- everything else — ANSI-strip, blank-line drop, consecutive-duplicate
  collapse (`same  [x3]`), head+tail truncation (40-line cap)
- always propagates the wrapped command's exit status

## Savings ledger

Every call appends `rawBytes outBytes` to `~/.tkg-log`. `tkg gain` reports the
running total:

```
$ tkg gain
calls:  5
raw:    36938 bytes
out:    1984 bytes
saved:  34954 bytes (94.0%), ~8738 tokens
```

## Public functions

- `stripAnsi(s: string): string` — remove ANSI escape sequences
- `dedupe(lines: string[]): string[]` — collapse consecutive repeats with a count
- `truncate(lines: string[], maxLines: int): string[]` — head + tail with elision
- `groupGitStatus(lines: string[]): string[]` — porcelain lines grouped by kind
- `splitLines(s: string): string[]` — split, dropping blank lines
- `lsSummary(lines: string[]): string[]` — `ls -la` columns compacted away
- `compactLog(lines: string[]): string[]` — full `git log` to one line per commit
- `capGrep(lines: string[]): string[]` — per-file match cap
- `filterTestOutput(lines: string[]): string[]` — failures + summary only

## Usage

```ts
import { dedupe, truncate, splitLines } from "./token-gate.ts";

const cleaned = truncate(dedupe(splitLines(raw)), 40);
```

The CLI lives in `examples/tkg.ts` (uses `process.argv` and
`child_process.spawnSync`):

```sh
lumen compile --release-fast packages/token-gate/examples/tkg.ts
./tkg git status
./tkg zig build test
```

## Use with Claude Code

A ready PreToolUse hook ships in [`hook/`](hook):

- `hook/tkg-hook.sh` — reads the tool event on stdin and rewrites a single
  supported command to `tkg <command>`. Anything with a pipe, redirect, or
  `&&`/`||`/`;`, and any unsupported command, passes through untouched. Requires
  `tkg` on `PATH` (or `TKG_BIN`) and `jq`; fail-open on any error.
- `hook/settings.snippet.json` — drop into `.claude/settings.json`, pointing
  `command` at the absolute path of `tkg-hook.sh`.

```sh
chmod +x hook/tkg-hook.sh
# then merge hook/settings.snippet.json into .claude/settings.json
```

## Tests

```sh
lumen test packages/token-gate/token-gate.ts
```

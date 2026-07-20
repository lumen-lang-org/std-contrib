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
- `grep` / `rg` — max 3 matches per file, `+N more matches` marker
- test runners (`zig build`, `cargo test`, `npm test`, `go test`, `pytest`,
  `jest`) — failures/errors/summary only, plus a one-line verdict
- everything else — ANSI-strip, blank-line drop, consecutive-duplicate
  collapse (`same  [x3]`), head+tail truncation (40-line cap)
- always propagates the wrapped command's exit status

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

Route Bash commands through `tkg` with a PreToolUse hook in
`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "/path/to/tkg-rewrite.sh" }
        ]
      }
    ]
  }
}
```

where `tkg-rewrite.sh` prefixes supported commands (`git status`, `git log`,
`ls`, `grep`, test runners) with the `tkg` binary. Unsupported commands pass
through untouched.

## Tests

```sh
lumen test packages/token-gate/token-gate.ts
```

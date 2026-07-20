# token-gate

Token-optimizing command proxy (`tkg`): run a command and compress its output
before it reaches an AI assistant's context window. Measured on typical
output: `git status` -90%, long log dumps -93%.

## What it does

- strips ANSI color/cursor escape sequences
- deduplicates consecutive repeated lines (`same  [x3]`)
- drops blank lines
- groups `git status` porcelain output by change kind
  (`untracked (2): a.txt, b.txt`)
- truncates long output to head + tail with an elision marker (40-line cap)
- propagates the wrapped command's exit status

## Public functions

- `stripAnsi(s: string): string` — remove ANSI escape sequences
- `dedupe(lines: string[]): string[]` — collapse consecutive repeats with a count
- `truncate(lines: string[], maxLines: int): string[]` — head + tail with elision
- `groupGitStatus(lines: string[]): string[]` — porcelain lines grouped by kind
- `splitLines(s: string): string[]` — split, dropping blank lines

## Usage

```ts
import { dedupe, truncate, splitLines } from "./token-gate.ts";

const cleaned = truncate(dedupe(splitLines(raw)), 40);
```

The CLI lives in `examples/tkg.ts` (uses `process.argv` and
`child_process.spawnSync`):

```sh
lumen compile packages/token-gate/examples/tkg.ts
./tkg git status
./tkg zig build test
```

## Tests

```sh
lumen test packages/token-gate/token-gate.ts
```

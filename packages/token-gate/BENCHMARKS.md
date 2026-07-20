# token-gate benchmarks

Measured against the Rust `rtk` proxy (Rust Token Killer) on the same machine.
`tkg` is compiled with `lumen compile --release-fast`.

## Output size (bytes)

| Command | bare | rtk | tkg |
|---------|-----:|----:|----:|
| `git status` | 281 | 38 | 19 (+ branch line) |
| `git log -20` | 3878 | 1963 | 1902 |
| `git diff` (3 commits) | 33268 | 19285 | 1549 (diffstat) |
| 500-line file dump | 1892 | 1892 | 140 |
| `find src -name '*.zig'` | full list | — | grouped by dir |
| `du -s src/*` | full list | — | top 20 by size |

## Speed (20 iterations of `git status`)

| | real |
|--|-----:|
| bare `git` | 0.054 s |
| `tkg` | 0.098 s (~4.9 ms overhead/call) |
| `rtk` | 0.283 s (~13 ms overhead/call) |

## Binary

| | size |
|--|-----:|
| `rtk` | 8.5 MB |
| `tkg` | 3.9 MB |

## Savings ledger (`tkg gain`)

A five-command session (`git status`, `git log`, `ls`, `find`, `git diff`):

```
calls:  5
raw:    36938 bytes
out:    1984 bytes
saved:  34954 bytes (94.0%), ~8738 tokens
```

## Reading

- `tkg` is faster per call and compresses deeper on the commands it handles
  (its `git diff` is diffstat-only — lossy but token-lean; use plain `git diff`
  for hunks).
- `rtk` covers far more commands (100+) with per-tool rules and ships polished
  editor integrations; `tkg` handles ~15 high-frequency command families plus a
  generic dedupe/truncate fallback.
- Numbers are machine- and repo-specific; regenerate locally to compare.

# semver benchmarks

## Methodology

Measure these operations against npm `semver`:

- Parse
- Compare
- Sort
- Range evaluation with `satisfies`

For Lumen, benchmark pure native programs compiled with the current `lumen`
compiler and use `time.monotonic()` for elapsed milliseconds.

For npm comparison, use Node.js plus the published `semver` package. Node may be
invoked from a benchmark harness with `child_process.spawnSync`, but the package
implementation itself must remain pure Lumen.

Because local Lumen imports are not available in the current compiler, the
Lumen benchmark below was generated as a temporary standalone file from
`semver.ts` plus a top-level benchmark loop.

## Environment To Record

- OS and architecture: local macOS development machine
- Lumen compiler commit: `3215e3b`
- Lumen compiler build mode: `zig build -Doptimize=ReleaseFast`
- Lumen benchmark build mode: default `lumen` compile output
- Node.js version: `v23.6.0`
- npm `semver` version: latest installed on 2026-07-02
- Input corpus: fixed representative strict versions and common ranges
- Iteration count: 100,000 loop iterations per benchmark
- Operations: parse = 100,000, compare = 200,000, satisfies = 300,000

## Current Results

Times are milliseconds. Lower is better.

| Operation | Lumen best of 3 | Node/npm semver best of 3 | Result |
| --- | ---: | ---: | --- |
| Parse | 18 ms | 48.982 ms | Lumen ~2.7x faster |
| Compare | 28 ms | 105.308 ms | Lumen ~3.8x faster |
| Satisfies | 241 ms | 224.845 ms | Node/npm ~1.1x faster |

Checksums matched for every run:

- Parse: `1000000`
- Compare: `0`
- Satisfies: `300000`

The current Lumen range evaluator reparses comparator ranges on every
`satisfies` call. Range parsing/caching or a lower-allocation desugaring pass is
the obvious next optimization target.

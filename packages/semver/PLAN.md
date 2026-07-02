# @lumen-lang/semver implementation plan

## Objective

Build a complete, production-ready Semantic Versioning package for Lumen. The
package should be a pure-Lumen reference library like `markdown`: no Node.js, no
JavaScript runtime, no FFI, and no external package dependency.

The finished package should demonstrate that Lumen can implement npm-style
library logic natively with strong correctness, predictable performance, and a
JavaScript-familiar API.

## Current Lumen capability check

The implementation should target the stdlib surface currently documented at
`https://lumen-lang.org/stdlib`.

Useful stable capabilities for this package:

- String scanning: `length`, concatenation, `split`, `slice`, `substring`,
  `indexOf`, `includes`, `startsWith`, `endsWith`, `trim`, `replace`, `charAt`,
  and `charCodeAt`.
- Arrays: element access, `length`, `map`, `filter`, `reduce`, `forEach`,
  `find`, `some`, `every`, `indexOf`, `includes`, `join`, and `Array.isEmpty`.
- Collections: typed `Map<K, V>` and `Set<T>` are available, but V1 does not
  need them unless benchmark data shows repeated range parsing needs caching.
- Errors: `Error("message")`, `throw`, `try`/`catch`/`finally`, and `e.message`
  are available. Use real thrown errors for invalid versions/ranges.
- Assertions: `assert.ok` and `assert.equal` are available for small executable
  examples or helper checks. Inline package tests can still use the repository's
  existing `test`/`expect` convention.
- Time: `time.monotonic()` returns `i64` and is suitable for benchmark timing.
- Process: `process.argv()`, `process.cwd()`, platform/arch helpers, and env
  access can support benchmark scripts and diagnostics.
- Child processes: `child_process.spawnSync(command, args)` can run Node.js for
  the npm `semver` comparison benchmark.

Avoid unnecessary stdlib surfaces:

- No async, HTTP, filesystem, crypto, C FFI, events, or OS APIs are needed for
  the package implementation itself.
- No Node.js or JavaScript runtime should be used by the package. Node.js is
  only acceptable in benchmark tooling that compares against npm `semver`.

## Package shape

```
packages/semver/
  semver.ts        # source plus inline tests
  README.md        # installation, quick start, API, examples, differences
  BENCHMARKS.md    # methodology, environment, results, npm semver comparison
  PLAN.md          # this plan, removed or archived after release
```

Root catalog update:

```json
{
  "name": "semver",
  "version": "0.1.0",
  "summary": "Semantic Versioning parser, comparator, incrementer, and range evaluator.",
  "path": "packages/semver"
}
```

## Public API

V1 should expose a familiar npm-style surface while staying friendly to current
Lumen language constraints.

```ts
export interface Version {
  major: int;
  minor: int;
  patch: int;
  prerelease: string[];
  build: string[];
}

export function parse(input: string): Version;
export function valid(input: string): bool;
export function clean(input: string): string;
export function format(v: Version): string;

export function compare(a: string, b: string): int;
export function compareVersions(a: Version, b: Version): int;
export function eq(a: string, b: string): bool;
export function neq(a: string, b: string): bool;
export function gt(a: string, b: string): bool;
export function gte(a: string, b: string): bool;
export function lt(a: string, b: string): bool;
export function lte(a: string, b: string): bool;

export function sort(list: string[]): string[];
export function rsort(list: string[]): string[];

export function inc(version: string, release: string): string;

export function satisfies(version: string, range: string): bool;
```

Optional V1.1 additions, if the compiler/runtime supports the ergonomics cleanly:

```ts
export function parseRange(input: string): Range;
export function minVersion(range: string): string;
export function outside(version: string, range: string, hilo: string): bool;
```

## Data model

Use lightweight immutable-looking values at API boundaries. Internally, prefer
indexes, integer fields, and scanner state over temporary substrings.

Core structures:

```ts
interface Version {
  major: int;
  minor: int;
  patch: int;
  prerelease: string[];
  build: string[];
}

interface Comparator {
  op: string;       # "", "=", ">", ">=", "<", "<="
  version: Version;
}

interface ComparatorSet {
  items: Comparator[];
}

interface Range {
  sets: ComparatorSet[]; # OR sets split by ||
}
```

If current Lumen limitations make exported interfaces or nested arrays awkward,
ship the same behavior with internal helper functions and document the exact
public return shape supported by the compiler today.

## Error model

Expose descriptive parse failures. If typed error values are not yet ergonomic,
use stable message prefixes so callers and tests can distinguish failures.

Required error kinds:

- `InvalidVersion`
- `InvalidCharacter`
- `UnexpectedEnd`
- `InvalidRange`
- `InvalidPrerelease`
- `InvalidNumericIdentifier`

Recommended message shape:

```text
InvalidVersion: expected major.minor.patch at offset 0
InvalidCharacter: unexpected '@' at offset 3
InvalidPrerelease: empty prerelease identifier at offset 8
```

## Parsing strategy

Implement a dedicated scanner instead of relying on regular expressions.

Scanner responsibilities:

- Track `input`, `pos`, and `len`.
- Read numeric identifiers without leading zeroes, except the literal `0`.
- Read dot-separated identifier lists for prerelease and build metadata.
- Validate prerelease identifiers under SemVer rules.
- Accept optional leading `v` only in `clean`, not in strict `parse`, unless the
  package intentionally documents npm-compatible leniency.
- Avoid building temporary strings until a token is accepted.

Version grammar for strict parsing:

```text
version    = major "." minor "." patch prerelease? build?
major      = numeric_identifier
minor      = numeric_identifier
patch      = numeric_identifier
prerelease = "-" identifier ("." identifier)*
build      = "+" identifier ("." identifier)*
identifier = [0-9A-Za-z-]+
```

Range grammar for V1:

```text
range       = set ("||" set)*
set         = comparator+
comparator  = op? partial
op          = ">" | ">=" | "<" | "<=" | "="
partial     = "*" | "x" | "X" | major_part ("." minor_part ("." patch_part)?)?
major_part  = number | "x" | "X" | "*"
minor_part  = number | "x" | "X" | "*"
patch_part  = number | "x" | "X" | "*"
```

Desugar syntax before evaluation:

- `*`, `x`, `X` -> any version.
- `1.x` -> `>=1.0.0 <2.0.0`.
- `1.2.x` -> `>=1.2.0 <1.3.0`.
- `^1.2.3` -> `>=1.2.3 <2.0.0`.
- `^0.2.3` -> `>=0.2.3 <0.3.0`.
- `^0.0.3` -> `>=0.0.3 <0.0.4`.
- `~1.4.0` -> `>=1.4.0 <1.5.0`.
- `~1.4` -> `>=1.4.0 <1.5.0`.
- `>=1.0.0 <2.0.0` -> one AND comparator set.
- `^1.2 || ^2.0` -> two OR comparator sets.

## Comparison rules

Implement the SemVer 2.0.0 precedence rules exactly:

- Compare `major`, then `minor`, then `patch` numerically.
- A version without prerelease has higher precedence than one with prerelease.
- Compare prerelease identifiers left-to-right.
- Numeric prerelease identifiers compare numerically.
- Numeric identifiers have lower precedence than non-numeric identifiers.
- If all compared prerelease identifiers match, the shorter prerelease list has
  lower precedence.
- Build metadata does not affect precedence or equality.

## Increment rules

Support the common release types:

- `patch`: `1.2.3` -> `1.2.4`
- `minor`: `1.2.3` -> `1.3.0`
- `major`: `1.2.3` -> `2.0.0`
- `prerelease`: `1.2.3` -> `1.2.4-0`, `1.2.3-alpha.1` -> `1.2.3-alpha.2`

Document whether V1 supports named prerelease identifiers such as `alpha`,
`beta`, and `rc`. If not, keep the API surface small and add them as V1.1.

## Implementation phases

### Phase 0: package scaffold

- Create `packages/semver/semver.ts`.
- Create `packages/semver/README.md`.
- Add the `semver` entry to root `index.json`.
- Add a minimal import/use snippet matching the existing std-contrib style.
- Verify `lumen test packages/semver/semver.ts` runs.

Acceptance:

- Package appears in the catalog.
- Empty or minimal test suite compiles under the current released Lumen.

### Phase 1: strict version parser

- Implement scanner helpers: `peek`, `advance`, `readNumber`, `readIdentifier`,
  `readIdentifierList`, and `expect`.
- Implement `parse(input)`.
- Implement `format(version)`.
- Implement `valid(input)`.
- Add strict valid and invalid version tests.

Acceptance:

- Parses `0.0.0`, `1.2.3`, `1.2.3-alpha.1`, and
  `1.2.3-alpha.1+build.5`.
- Rejects missing fields, leading zeroes, empty identifiers, invalid
  characters, and trailing text.

### Phase 2: comparison and equality

- Implement `compareVersions(a, b)`.
- Implement `compare(a, b)`.
- Implement `eq`, `neq`, `gt`, `gte`, `lt`, and `lte`.
- Confirm build metadata is ignored for precedence.

Acceptance:

- Matches SemVer precedence examples from the official spec.
- Handles numeric vs alphanumeric prerelease identifiers correctly.

### Phase 3: sorting

- Implement `sort(list)` using `compare`.
- Implement `rsort(list)` using reverse comparison.
- Decide whether sorting mutates or returns a new array. Prefer returning a new
  array if the current array support makes that practical; otherwise document
  mutation clearly.

Acceptance:

- Sorts stable SemVer precedence examples.
- Includes prerelease and build metadata cases.

### Phase 4: incrementing

- Implement `inc(version, release)`.
- Support `patch`, `minor`, `major`, and `prerelease`.
- Validate unknown release types with a stable error.

Acceptance:

- Covers normal, zero, and prerelease versions.
- Does not preserve build metadata unless intentionally documented.

### Phase 5: range parser

- Implement range scanner for comparators, whitespace, wildcard partials, `^`,
  `~`, and `||`.
- Desugar ranges to comparator sets.
- Keep `parseRange` internal unless the public exported structure is stable.

Acceptance:

- Parses `^1.2.3`, `~1.4.0`, `>=1.0.0`, `<2.0.0`, `1.x`, `1.5.x`,
  `>=1.0.0 <2.0.0`, and `^1.2 || ^2.0`.
- Rejects malformed operators, dangling `||`, malformed partials, and invalid
  versions.

### Phase 6: range evaluation

- Implement comparator evaluation.
- Implement AND within a comparator set and OR across sets.
- Implement `satisfies(version, range)`.
- Decide prerelease range semantics and document them. Recommended npm-compatible
  default: prerelease versions only satisfy ranges that include a prerelease on
  the same major/minor/patch tuple.

Acceptance:

- `satisfies("1.5.0", "^1.2.0") == true`.
- `satisfies("2.0.0", "^1.2.0") == false`.
- Covers wildcard, tilde, caret, inequality, AND, and OR examples.

### Phase 7: npm compatibility suite

- Port representative examples from npm `semver` tests where the behavior is in
  scope.
- Keep each group readable with inline `test` blocks in `semver.ts`.
- Add comments only for compatibility quirks or intentionally different
  behavior.

Acceptance:

- High coverage across valid versions, invalid versions, comparison, sorting,
  increments, and range evaluation.
- Any difference from npm is explicitly documented in README.

### Phase 8: benchmarks

- Add benchmark methodology to `BENCHMARKS.md`.
- Benchmark Lumen native implementation against npm `semver`.
- Measure parse, compare, sort, and satisfies/range evaluation.
- Record OS, CPU, compiler version, Lumen version, Node.js version, npm semver
  version, sample sizes, warmup, and command lines.
- Use `time.monotonic()` inside Lumen benchmark programs.
- Use `child_process.spawnSync` only for benchmark harnesses that invoke Node.js
  or shell out to collect comparison data.

Acceptance:

- Benchmarks are reproducible from documented commands.
- Results include both absolute timings and relative performance.

### Phase 9: documentation and release polish

- Complete README sections:
  - Installation
  - Quick Start
  - API Reference
  - Examples
  - Range Syntax
  - Error Handling
  - Performance Results
  - Design Notes
  - Differences from npm `semver`
- Run the full package test command.
- Re-index the codebase-memory graph after implementation.

Acceptance:

- `lumen test packages/semver/semver.ts` passes.
- README examples match actual exported functions.
- `index.json` is valid JSON.

## Test matrix

Version parsing:

- `0.0.0`
- `1.2.3`
- `10.20.30`
- `1.2.3-alpha`
- `1.2.3-alpha.1`
- `1.2.3-0.3.7`
- `1.2.3-x.7.z.92`
- `1.2.3+build`
- `1.2.3+build.11.e0f985a`
- `1.2.3-alpha+build`

Invalid versions:

- ``
- `1`
- `1.2`
- `1.2.3.4`
- `01.2.3`
- `1.02.3`
- `1.2.03`
- `1.2.3-`
- `1.2.3-alpha..1`
- `1.2.3-01`
- `1.2.3+`
- `1.2.3+build..1`
- `1.2.3@`

Comparison:

- `1.0.0-alpha < 1.0.0-alpha.1`
- `1.0.0-alpha.1 < 1.0.0-alpha.beta`
- `1.0.0-alpha.beta < 1.0.0-beta`
- `1.0.0-beta < 1.0.0-beta.2`
- `1.0.0-beta.2 < 1.0.0-beta.11`
- `1.0.0-beta.11 < 1.0.0-rc.1`
- `1.0.0-rc.1 < 1.0.0`
- `1.0.0+build.1 == 1.0.0+build.2`

Ranges:

- `*`
- `1.x`
- `1.2.x`
- `^1.2.3`
- `^0.2.3`
- `^0.0.3`
- `~1.4.0`
- `>=1.0.0 <2.0.0`
- `^1.2 || ^2.0`
- prerelease inclusion and exclusion cases

## Performance guidelines

- Use scanner indexes instead of repeated split-heavy parsing in hot paths.
- Avoid converting accepted tokens until required by the return value.
- Compare numeric fields before touching prerelease arrays.
- Fast-path versions without prerelease/build metadata.
- Keep range desugaring simple and cache-free in V1; add caching only if a real
  benchmark shows repeated parsing dominates.

## Risks and decisions

- Current Lumen arrays are fixed-size slices under the hood. Resolve sort
  mutation vs copy behavior during Phase 0 with a tiny compile probe and
  document the result.
- Current Lumen interfaces/records should be verified for exported `Version` and
  internal `Range` shapes before locking the API.
- npm `semver` has a large lenient/coercion surface. V1 should be strict by
  default and document any compatibility helpers separately.
- Prerelease range semantics are easy to get subtly wrong. Lock them with tests
  before optimizing.
- Sorting mutation behavior must be documented because JavaScript developers may
  expect npm-like mutation while Lumen users may prefer value-style behavior.

## Done definition

- Pure Lumen implementation with no FFI and no JavaScript runtime dependency.
- Public API supports parsing, comparison, sorting, equality helpers,
  incrementing, and range evaluation.
- Comprehensive inline tests pass with the released `lumen`.
- README is complete and examples compile.
- Benchmarks compare against npm `semver` and document the environment.
- Root catalog includes `semver`.
- Any known npm differences are explicit and intentional.

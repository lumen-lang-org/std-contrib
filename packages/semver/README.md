# semver

A pure-Lumen Semantic Versioning library.

`semver` parses, compares, sorts, increments, and evaluates common npm-style
version ranges without Node.js, a JavaScript runtime, FFI, or external
dependencies.

## Use

```ts
import { parse, compare, satisfies } from "https://lumen-lang.org/package/std-contrib/semver/semver.ts";

let v = parse("1.2.3-alpha.1+build.5");
console.log(v.major); // 1

console.log(compare("1.0.0", "2.0.0") < 0);
console.log(satisfies("1.5.0", "^1.2.0"));
```

Run the package tests:

```sh
lumen test packages/semver/semver.ts
```

## API

| API | Meaning |
| --- | --- |
| `parse(input: string): Version` | Parse a strict SemVer version or throw an error |
| `valid(input: string): bool` | Return whether `input` is a strict valid SemVer version |
| `clean(input: string): string` | Trim whitespace, strip a leading `v`/`V`, and return canonical form |
| `format(v: Version): string` | Convert a parsed version back to a string |
| `compare(a: string, b: string): int` | Return `-1`, `0`, or `1` by SemVer precedence |
| `compareVersions(a: Version, b: Version): int` | Compare already parsed versions |
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | Convenience comparison helpers |
| `sort(list: string[]): string[]` | Return versions in ascending SemVer order |
| `rsort(list: string[]): string[]` | Return versions in descending SemVer order |
| `inc(version: string, release: string): string` | Increment by `patch`, `minor`, `major`, or `prerelease` |
| `satisfies(version: string, range: string): bool` | Evaluate a version against a range |

`Version` has this shape:

```ts
interface Version {
  major: int;
  minor: int;
  patch: int;
  prerelease: string[];
  build: string[];
}
```

## Ranges

Supported V1 range syntax:

- `*`, `x`, `X`
- `1.x`
- `1.2.x`
- exact versions such as `1.2.3`
- `>`, `>=`, `<`, `<=`, `=`
- caret ranges such as `^1.2.3`, `^0.2.3`, `^0.0.3`, `^1.2`
- tilde ranges such as `~1.4.0`, `~1.4`
- AND ranges with spaces: `>=1.0.0 <2.0.0`
- OR ranges with `||`: `^1.2 || ^2.0`

## Design notes

The parser is scanner-based rather than regex-based. Numeric identifiers are
validated explicitly so strict `parse` rejects leading zeroes, missing fields,
empty prerelease/build identifiers, invalid characters, and trailing input.

Build metadata does not affect comparison or equality, matching SemVer 2.0.0.

`sort` and `rsort` return new arrays. Current Lumen arrays do not support
element assignment, so sorting is implemented as a non-mutating selection pass
that constructs the result through a string round-trip.

## Differences from npm semver

V1 is intentionally strict by default. It does not attempt npm's full coercion
or loose parsing surface. Use `clean` for the small compatibility convenience of
trimming whitespace and stripping a leading `v`.

Prerelease range behavior is conservative in V1 and covered by the package
tests; additional npm edge-case compatibility can be added as follow-up tests.

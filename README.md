# Lumen std-contrib

A curated set of standard and community packages for the
[Lumen](https://lumen-lang.org) language. Every package is plain Lumen, is
statically typed, and ships with tests.

> Status: early seed. While the package manager and multi-symbol imports are
> still being designed, packages are consumed by copying the source or via a
> local import, and each package keeps its tests inline. The layout below is
> stable and forward-compatible.

## Layout

```
packages/
  <name>/
    <name>.ts        # the package source (+ inline `test` blocks for now)
    README.md        # what it does and how to use it
index.json           # machine-readable catalog (name, version, summary, path)
CONTRIBUTING.md      # how to add a package
```

`index.json` is the catalog. As the ecosystem grows, the source can move to
per-package repositories and this catalog becomes a thin index that points at
them — so nothing here locks the project into a single source monorepo.

## Packages

| Package | Summary |
|---------|---------|
| [`args`](packages/args) | Command-line flag and option parsing |
| [`mathx`](packages/mathx) | Integer math helpers — gcd, lcm, ipow, isPrime, clampInt |
| [`geo`](packages/geo) | 2D point helpers — distanceSq, manhattan |
| [`quickjs`](packages/quickjs) | Embed a QuickJS JavaScript sandbox via FFI (community, C shim) |
| [`sqlite`](packages/sqlite) | Typed SQLite access via FFI (community, C shim) |
| [`markdown`](packages/markdown) | Pure-Lumen Markdown -> HTML renderer |
| [`semver`](packages/semver) | Semantic Versioning parser, comparator, incrementer, and range evaluator |
| [`dotenv`](packages/dotenv) | .env parser for key/value config strings |
| [`toml`](packages/toml) | Practical TOML parser/stringifier for sections, dotted keys, typed values, and simple arrays |
| [`csv`](packages/csv) | CSV parser/stringifier with quoted fields, CRLF, row helpers, and flat arrays |
| [`ai`](packages/ai) | Typed AI helpers for OpenAI-compatible chat APIs |

## Using a package

Import a package's default function straight from its URL -- it is fetched over
HTTPS and inlined at compile time, no install step:

```ts
import greet from "https://lumen-lang.org/package/std-contrib/hello/hello.ts";

console.log(greet("world"));
```

`lumen-lang.org/package/std-contrib/<name>/<file>.ts` redirects here; the raw
GitHub URL works too. Then build as usual:

```sh
lumen compile app.ts && ./app
```

Run a package's own tests:

```sh
lumen test packages/mathx/mathx.ts
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: one package per directory,
typed, tested, current-language features only, and add an entry to `index.json`.

# dotenv

A small `.env` parser written entirely in Lumen.

This package is intentionally pure: it parses strings only. It does not read
files and does not mutate the process environment.

## Use

```ts
import { get, has, parse } from "https://lumen-lang.org/package/std-contrib/dotenv/dotenv.ts";

let src = "PORT=3000\nAPP_MODE=production\n";
let port = get(src, "PORT", "8080");
let hasMode = has(src, "APP_MODE");
let entries = parse(src); // ["PORT=3000", "APP_MODE=production"]
```

## API

| API | Meaning |
| --- | --- |
| `parse(src: string): string[]` | Parse `.env` text into `KEY=value` entries |
| `get(src: string, key: string, fallback: string): string` | Return the last value for `key`, or `fallback` |
| `has(src: string, key: string): bool` | Return whether `key` exists |

## Supported syntax

- `KEY=value`
- surrounding whitespace around keys and values
- blank lines
- full-line comments beginning with `#`
- unquoted inline comments when `#` is preceded by whitespace
- single-quoted values
- double-quoted values
- double-quoted escapes: `\n`, `\r`, `\t`, `\"`, `\\`
- optional `export KEY=value`

## V1 choices

Duplicate keys are allowed. `get` returns the last value, matching common dotenv
behavior.

Malformed lines are ignored in V1 rather than throwing, which keeps the package
small and convenient for CLI-style config. A strict parser can be added later if
callers need diagnostics.

Test:

```sh
lumen test packages/dotenv/dotenv.ts
```

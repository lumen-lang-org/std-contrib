# toml

A practical TOML config reader written entirely in Lumen.

V1 is intentionally focused on common read-only config use cases. It does not
read files, mutate process state, or attempt the whole TOML 1.0 surface.

## Use

```ts
import { getString, getInt, getBool, getArray, stringify } from "https://lumen-lang.org/package/std-contrib/toml/toml.ts";

let src = "[package]\nname = \"demo\"\nversion = 1\n";

let name = getString(src, "package.name", "");
let version = getInt(src, "package.version", 0);

let out = stringify(["package.name=demo", "package.version=1"]);
```

## API

| API | Meaning |
| --- | --- |
| `parse(src: string): string[]` | Parse into normalized `path=value` entries |
| `keys(src: string): string[]` | Return normalized keys in document order |
| `has(src: string, key: string): bool` | Return whether `key` exists |
| `get(src, key, fallback): string` | Return the last raw value for `key` |
| `getString(src, key, fallback): string` | Return a string value |
| `getInt(src, key, fallback): int` | Return an integer value |
| `getBool(src, key, fallback): bool` | Return a boolean value |
| `getArray(src, key): string[]` | Return simple array items as strings |
| `stringify(entries: string[]): string` | Serialize normalized `path=value` entries |

The npm TOML ecosystem usually exposes `parse` and `stringify` over JavaScript
objects. Lumen does not yet have the same dynamic object shape, so this package
uses normalized `path=value` entries as the stable interchange format for now.

## Supported V1 syntax

- comments beginning with `#` outside quotes
- bare keys and dotted keys
- tables like `[package]`
- nested tables like `[database.primary]`
- strings with `"basic"` and `'literal'` quotes
- integers, including `_` separators and negative values
- booleans: `true`, `false`
- simple arrays: `["a", "b"]`, `[1, 2]`
- duplicate keys, with `get*` returning the last value
- serialization from normalized entries with strings, ints, bools, and arrays

## Out of scope for V1

- arrays of tables
- inline tables
- date/time values
- floats
- multiline strings
- quoted keys
- strict diagnostics for every malformed line
- full object-style serialization

Test:

```sh
lumen test packages/toml/toml.ts
```

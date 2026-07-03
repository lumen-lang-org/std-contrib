# csv

A CSV parser and stringifier written entirely in Lumen.

V1 uses a flat `string[]` representation plus row/column helpers. This keeps the
API usable before nested records and richer table structures are standardized.

## Use

```ts
import { parse, get, rowCount, colCount, stringify } from "https://lumen-lang.org/package/std-contrib/csv/csv.ts";

let src = "name,age\nAda,36\n";

let fields = parse(src);
let rows = rowCount(src);
let cols = colCount(src, 0);
let name = get(src, 1, 0, "");

let out = stringify(["name", "note", "Ada, Lovelace", "said \"hello\""], 2);
let byHeader = getByHeader(src, 1, "name", "");
```

## API

| API | Meaning |
| --- | --- |
| `parse(src: string): string[]` | Parse all fields into row-major order |
| `rowCount(src: string): int` | Count rows |
| `colCount(src: string, row: int): int` | Count columns in a row |
| `get(src, row, col, fallback): string` | Return one field or `fallback` |
| `headerIndex(src, name): int` | Return the column index for a header row |
| `getByHeader(src, row, header, fallback): string` | Return one field using row 0 as headers |
| `stringify(fields: string[], columns: int): string` | Serialize row-major fields |
| `parseDelimited(src, delimiter): string[]` | Parse with a custom one-character delimiter |
| `getDelimited(src, row, col, fallback, delimiter): string` | Read with a custom delimiter |
| `stringifyDelimited(fields, columns, delimiter): string` | Serialize with a custom delimiter |

## npm inspiration

This package is inspired by the shape of common npm CSV libraries:

- `csv-parse` and the broader `csv` project split parsing and stringifying into
  focused APIs.
- Papa Parse exposes `parse` and `unparse`; this package uses `parse` and
  `stringify` with Lumen-friendly flat arrays.
- fast-csv supports delimited-value parsing/formatting beyond only commas, so
  V1 includes one-character delimiter helpers.

Streaming, callback APIs, workers, object records, and transform hooks are left
out until Lumen has the surrounding runtime and data-shape support.

## Supported V1 syntax

- comma delimiter
- quoted fields
- escaped quotes as `""`
- LF and CRLF line endings
- newlines inside quoted fields
- empty fields
- trailing newline
- stringification with required quoting
- one-character custom delimiters
- header lookup helpers

## Out of scope for V1

- multi-character delimiters
- object records
- streaming
- comments
- automatic type casting
- automatic delimiter detection

Test:

```sh
lumen test packages/csv/csv.ts
```

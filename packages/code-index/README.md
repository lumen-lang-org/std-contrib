# code-index

Compact codebase symbol index (`cidx`) for AI navigation — the aider-repomap /
ctags idea in pure Lumen. An assistant reads one map line or queries one
symbol instead of grepping a whole tree.

Measured on the Lumen compiler source (1.4 MB, 28k lines of Zig): the full map
is 10.5 KB — **139x smaller** — and `cidx find exprType` answers in ~11 ms
with exact `file:line` hits.

## Commands

```sh
cidx map <dir>            # one line per file: `path: sym:line, sym:line, ...`
cidx find <symbol> [dir]  # where a symbol is defined: `path:line name`
cidx outline <file>       # one file's symbols
```

Exact matches win; prefix matches are the fallback. Hits cap at 20 with a
`+N more` marker.

## Languages

Pattern-based top-level declaration scan (no parser dependency):

- TypeScript / JavaScript / Lumen — `function`, `class`, `interface`, `enum`,
  `type`, with `export` / `export default` / `async` prefixes
- Zig — `pub fn`, `pub const`, `pub var`
- Python — top-level `def` / `async def` / `class`
- Rust — `pub fn` / `pub struct` / `pub enum` / `pub trait`
- Go — `func`, methods with receivers, `type`

Skipped directories: `.git`, `node_modules`, `.zig-cache`, `zig-out`,
`target`, `dist`, `.venv`, `__pycache__`, `vendor`, `build`.

## Public functions

- `langOf(path: string): string` — language key by extension ("" = not indexed)
- `symbolOnLine(line: string, lang: string): string` — declared symbol or ""
- `outlineSource(src: string, lang: string): string[]` — `name:line` entries
- `formatMapLine(path: string, syms: string[]): string` — compact map line
- `findSymbol(paths, outlines, query): string[]` — exact-then-prefix lookup
- `identAt(s: string, i: int): string` — identifier scan helper
- `skipDir(name: string): bool` — index-worthiness of a directory

## Usage

```ts
import { outlineSource, langOf } from "./code-index.ts";

const syms = outlineSource(fs.readFileSync("src/app.ts"), "ts");
```

The CLI lives in `examples/cidx.ts` (uses `fs.readdirSync`, `fs.statSync`,
`fs.readFileSync`, `process.argv`):

```sh
lumen compile --release-fast packages/code-index/examples/cidx.ts
./cidx map src/
./cidx find exprType src/
```

Pairs with [`token-gate`](../token-gate): `cidx` answers "where is X" in one
50-token call; `tkg` compresses everything else.

## Tests

```sh
lumen test packages/code-index/code-index.ts
```

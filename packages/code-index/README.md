# code-index

Compact codebase symbol index (`cidx`) for AI navigation — the aider-repomap /
ctags idea in pure Lumen. An assistant reads one map line or queries one
symbol instead of grepping a whole tree.

Measured on the Lumen compiler source (1.4 MB, 28k lines of Zig): the full map
is 10.5 KB — **139x smaller** — and `cidx find exprType` answers in ~11 ms
with exact `file:line` hits.

## Commands

```sh
cidx map <dir> [--rank]   # one line per file: `path: sym:line, sym:line, ...`
                          # --rank: flat symbol list sorted by call count
cidx find <symbol> [dir]  # where a symbol is defined: `path:line name`
cidx refs <symbol> [dir]  # who calls it: `path:line: <source line>`
cidx outline <file>       # one file's symbols, including class members
```

`find` matches a full name (`Stack.push`) or its unqualified tail (`push`);
exact wins, prefix is the fallback. `refs` lists call sites only (the
definition line is excluded). `map --rank` orders symbols by how often they are
called across the tree — a cheap importance signal (aider's PageRank cousin).
Output caps: find 20, refs/rank 40, with a `+N more` marker.

On the Lumen compiler source, `map --rank` surfaces the load-bearing symbols:
`fail` (715 calls), `emitExpr` (480), `exprType` (300).

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
- `symbolOnLine(line: string, lang: string): string` — top-level declared symbol or ""
- `classMemberOnLine(line: string, lang: string): string` — TS class member or ""
- `outlineSource(src: string, lang: string): string[]` — top-level `name:line` entries
- `outlineDeep(src: string, lang: string): string[]` — top-level + `Class.member:line`
- `refLinesInSource(src, name, defLine): int[]` — call-site line numbers
- `countRefs(srcs: string[], name: string): int` — whole-corpus call count
- `formatMapLine(path: string, syms: string[]): string` — compact map line
- `findSymbol(paths, outlines, query): string[]` — exact-then-prefix, tail-aware
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

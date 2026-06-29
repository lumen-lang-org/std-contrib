# sqlite

A typed wrapper over [SQLite](https://sqlite.org) reached through the C FFI.
Open a database, run statements, and read back integer and text results — from
a compiled native Lumen program, no ORM and no runtime.

This is a **community FFI package**: it links a native library, so (like
`quickjs`) it is built locally rather than fetched purely by URL.

## Dependency

```sh
brew install sqlite
```

Expected at the default Homebrew prefix `/opt/homebrew/opt/sqlite` (headers in
`include/`, library in `lib/`). On a system SQLite, change the `// @link` path in
`sqlite.ts` (or use `// @link sqlite3` to let the linker resolve `-lsqlite3`).

## How it works

SQLite's C API uses out-pointers (`sqlite3_open` takes a `sqlite3**`, etc.),
which the scalar-and-string FFI cannot express directly. `sqlite_shim.c` hides
the connection handle behind a global and exposes a flat, FFI-friendly surface;
`sqlite.ts` declares those externals and re-exports a typed API.

| API | Meaning |
| --- | --- |
| `open(path)` | open a database (`":memory:"` for in-memory); rc |
| `exec(sql)` | run a statement with no result rows; rc |
| `queryInt(sql)` | first column of the first row, as `int` |
| `queryText(sql)` | first column of the first row, as `string` |
| `errorMessage()` | most recent error message |
| `close()` | close the connection; rc |

## Use

The typed wrapper is imported by URL; only the C shim is built locally. Download the shim once, then build:

```sh
curl -fsSL https://lumen-lang.org/package/std-contrib/sqlite/sqlite_shim.c -o sqlite_shim.c
cc -c sqlite_shim.c -I/opt/homebrew/opt/sqlite/include -o sqlite_shim.o
lumen compile app.ts && ./app
```

```ts
import { open, exec, queryInt, queryText, close } from "https://lumen-lang.org/package/std-contrib/sqlite/sqlite.ts";

open(":memory:");
exec("CREATE TABLE books (title TEXT, year INT)");
exec("INSERT INTO books VALUES ('Crafting Interpreters', 2021)");
console.log(queryInt("SELECT COUNT(*) FROM books"));   // 1
console.log(queryText("SELECT title FROM books"));      // Crafting Interpreters
close();
```

## Wasm target (embedded, no install)

On the wasm target there is no native linking, so the `cc`/`brew`/`@link` steps
above do not apply. The package ships `sqlite-wasm.a` — the shim plus the SQLite
amalgamation, prebuilt to `wasm32-wasi` — and declares it in `sqlite.ts`:

```ts
// @wasm-link https://github.com/lumen-lang-org/std-contrib/releases/download/wasm-engines-v1/sqlite-wasm.a#sha256=42c8e34f…
```

`lumen compile --wasm app.ts` fetches that archive (once, cached) and links it
in, so you get a single self-contained `.wasm` whose only imports are WASI — no
install, nothing to copy. Use `":memory:"` databases (no host filesystem needed).

`sqlite-wasm.a` is a **prebuilt artifact, built once per SQLite version** (not
committed to this repo) — regenerate it reproducibly with
[`build-wasm.sh`](build-wasm.sh), publish it as a **GitHub Release asset**, and
pin it in the `@wasm-link` URL with `#sha256=<hash>`. Consumers never run it; they
just `import` the package.

## Notes

`queryInt`/`queryText` return the first column of the first row — enough for
aggregates and single-value lookups. Multi-row iteration is a future addition.
The shim manages one global connection.

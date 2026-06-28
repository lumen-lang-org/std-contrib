# std-contrib package: `sqlite`

**Status**: Draft | **Depends on**: FFI string marshalling (compiler feature 023)

Embed SQLite in a compiled Lumen program via the C FFI. A small `sqlite_shim.c`
flattens SQLite's out-pointer API into scalar/string functions; `sqlite.ts`
declares them and exports a typed API. Single global connection in V1.

## API
`open(path: string): int`, `exec(sql: string): int`,
`queryInt(sql: string): int`, `queryText(sql: string): string`,
`errorMessage(): string`, `close(): int`.

## Linking
`// @link ./sqlite_shim.o`, `// @link <libsqlite3 path or sqlite3>`, `// @link c`.
Built locally (links a native library; not fetched purely by URL).

## Out of scope (future)
Multi-row iteration / result-set cursors, prepared statements with bound
parameters, multiple connections, blob columns, transactions API.

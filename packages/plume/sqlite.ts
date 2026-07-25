// The SQLite driver: libsqlite3 through the C FFI.
//
//   apt install libsqlite3-dev   # Debian, Ubuntu
//   brew install sqlite          # macOS
//   sh packages/plume/build.sh
//
// @link ./sqlite_shim.o
// @link sqlite3
// @link c
declare function sq_connect(path: string): int;
declare function sq_connected(): int;
declare function sq_exec(sql: string): int;
declare function sq_query0(sql: string): int;
declare function sq_query1(sql: string, a: string): int;
declare function sq_rows(): int;
declare function sq_value(row: int, col: int): string;
declare function sq_error(): string;
declare function sq_version(): string;
declare function sq_close(): void;

import { Db } from "./driver.ts";

// `target` is a file path, or ":memory:" for a database that lives as long as
// the process.
export function sqlite(): Db {
  let d: Db = {
    connect: (target: string) => { return sq_connect(target) == 0; },
    connected: () => { return sq_connected() == 1; },
    close: () => { sq_close(); },
    exec: (sql: string) => { return sq_exec(sql) == 0; },
    query: (sql: string, a: string) => { return sq_query1(sql, a) >= 0; },
    queryNoArgs: (sql: string) => { return sq_query0(sql) >= 0; },
    rows: () => { return sq_rows(); },
    value: (row: int, col: int) => { return sq_value(row, col); },
    lastError: () => { return sq_error(); },
    name: "sqlite",
    // Numbered, not bare `?`: a document is read field by field, so the one
    // bound parameter appears several times in a statement, and SQLite counts
    // each bare `?` as a parameter of its own.
    placeholder: "?1",
    // SQLite cannot tell an upsert clause from a join condition after an
    // INSERT ... SELECT without this; found by running it, not by reading a
    // manual.
    upsertNeedsWhereTrue: true,
    rowToJson: "json_object",
    jsonAgg: "json_group_array",
    docStyle: "pairs",
    identQuote: "\"",
    jsonNeedsUnquote: false,
    upsertStyle: "on-conflict",
    readStyle: "extract",
    textType: "text",
    intType: "integer",
    floatType: "real",
    timestampType: "text",
    nowExpr: "CURRENT_TIMESTAMP",
  };
  return d;
}

export function sqliteVersion(): string {
  return sq_version();
}

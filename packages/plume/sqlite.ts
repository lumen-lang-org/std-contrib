// The SQLite driver: libsqlite3 through the C FFI.
//
//   apt install libsqlite3-dev   # Debian, Ubuntu
//   brew install sqlite          # macOS
//   sh packages/plume/build.sh
//
// @link ./sqlite_shim.o
// @link sqlite3
// @link c
declare function sq_acquire(): int;
declare function sq_open(handle: int, path: string): int;
declare function sq_connected(handle: int): int;
declare function sq_exec(handle: int, sql: string): int;
declare function sq_bind(handle: int, i: int, value: string): int;
declare function sq_query(handle: int, sql: string, argc: int): int;
declare function sq_rows(handle: int): int;
declare function sq_value(handle: int, row: int, col: int): string;
declare function sq_error(handle: int): string;
declare function sq_version(): string;
declare function sq_fail(handle: int, message: string): void;
declare function sq_release(handle: int): void;

import { Db, DbConfig, targetValue } from "./driver.ts";

// SQLite takes a path, not a list, so nothing here needs quoting and a name
// carrying a space arrives whole. `options` is the escape hatch, for a `file:`
// URI with its own query string.
function sqTarget(config: DbConfig): string {
  let fileName = config.filename ?? "";
  if (fileName != "") { return fileName; }
  return config.options ?? "";
}

// A config naming no file is refused rather than attempted: sqlite3_open of an
// empty path succeeds and gives back a private temporary database, so the
// writes of a mistyped config would go somewhere and then vanish.
function sqConnect(handle: int, config: DbConfig): bool {
  let target = sqTarget(config);
  if (target == "") {
    sq_fail(handle, "the configuration names neither a filename nor options");
    return false;
  }
  return sq_open(handle, target) == 0;
}

// Bind every value, then execute. The FFI passes one string per call, so an
// argument list is sent a value at a time and the count tells the shim how
// many of them the statement is to use.
function sqRun(handle: int, sql: string, args: string[]): bool {
  let i: int = 0;
  while (i < args.length) {
    if (sq_bind(handle, i, args[i]) != 0) { return false; }
    i = i + 1;
  }
  return sq_query(handle, sql, args.length) >= 0;
}

// A `Db` for one slot of the shim's connection table. The handle is captured
// when the record is built, which is right: a `Db` is a connection, not a
// thing that might later have one.
function sqliteOn(handle: int): Db {
  let d: Db = {
    connect: (config: DbConfig) => { return sqConnect(handle, config); },
    connected: () => { return sq_connected(handle) == 1; },
    close: () => { sq_release(handle); },
    exec: (sql: string) => { return sq_exec(handle, sql) == 0; },
    query: (sql: string, args: string[]) => { return sqRun(handle, sql, args); },
    rows: () => { return sq_rows(handle); },
    value: (row: int, col: int) => { return sq_value(handle, row, col); },
    lastError: () => { return sq_error(handle); },
    name: "sqlite",
    placeholder: "?",
    numberedPlaceholders: false,
    // SQLite cannot tell an upsert clause from a join condition after an
    // INSERT ... SELECT without this; found by running it, not by reading a
    // manual.
    upsertNeedsWhereTrue: true,
    rowToJson: "json_object",
    jsonAgg: "json_group_array",
    canAddForeignKey: false,
    emptyJsonArray: "'[]'",
    nestedJsonWrap: true,
    docStyle: "pairs",
    identQuote: "\"",
    backslashEscapes: false,
    jsonNeedsUnquote: false,
    upsertStyle: "on-conflict",
    readStyle: "extract",
    // The shortest spelling that reads back as the same double: 15 digits
    // where they suffice, 17 where they do not — so 0.2 stays "0.2" and
    // 1234567890.123456 keeps every digit. SQLite's own rendering stops at 15
    // and silently drops the rest.
    floatJson: "json(CASE WHEN CAST(printf('%!.15g',{c}) AS REAL) = {c} THEN printf('%!.15g',{c})"
      + " WHEN CAST(printf('%!.16g',{c}) AS REAL) = {c} THEN printf('%!.16g',{c})"
      + " ELSE printf('%!.17g',{c}) END)",
    // 0 and 1 in the column; true and false in the document, which is what
    // the record declares and what JSON.parse will accept.
    boolJson: "json(CASE WHEN {c} THEN 'true' ELSE 'false' END)",
    textType: "text",
    intType: "integer",
    floatType: "real",
    timestampType: "text",
    nowExpr: "CURRENT_TIMESTAMP",
  };
  return d;
}

// The process-wide connection, slot 0. `connectDatabase` opens it; a program
// that only ever wants one database wants this.
export function sqlite(): Db {
  return sqliteOn(0);
}

// A connection of its own, opened straight away. A `{ filename: ":memory:" }`
// opened this way is the slot's own database, not shared with any other
// handle.
//
//   let local: DbConfig = { filename: "/tmp/app.db" };
//   let database = sqliteConnection(local);
export function sqliteConnection(config: DbConfig): Db {
  let handle = sq_acquire();
  if (handle >= 0) { sqConnect(handle, config); }
  return sqliteOn(handle);
}

export function sqliteVersion(): string {
  return sq_version();
}

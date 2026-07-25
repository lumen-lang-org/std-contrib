// The PostgreSQL driver: libpq through the C FFI.
//
//   apt install libpq-dev        # Debian, Ubuntu
//   brew install postgresql@17   # macOS
//   sh packages/plume/build.sh
//
// @link ./plume_shim.o
// @link pq
// @link c
declare function pl_connect(conninfo: string): int;
declare function pl_connected(): int;
declare function pl_exec(sql: string): int;
declare function pl_query0(sql: string): int;
declare function pl_query1(sql: string, a: string): int;
declare function pl_rows(): int;
declare function pl_value(row: int, col: int): string;
declare function pl_error(): string;
declare function pl_close(): void;
declare function pl_version(): string;

import { Db } from "./driver.ts";

// `target` is a libpq conninfo string:
//   "host=127.0.0.1 port=5432 user=lumen password=lumen dbname=lumenvec"
export function postgres(): Db {
  let d: Db = {
    connect: (target: string) => { return pl_connect(target) == 0; },
    connected: () => { return pl_connected() == 1; },
    close: () => { pl_close(); },
    exec: (sql: string) => { return pl_exec(sql) == 0; },
    query: (sql: string, a: string) => { return pl_query1(sql, a) >= 0; },
    queryNoArgs: (sql: string) => { return pl_query0(sql) >= 0; },
    rows: () => { return pl_rows(); },
    value: (row: int, col: int) => { return pl_value(row, col); },
    lastError: () => { return pl_error(); },
    name: "postgres",
    placeholder: "$1",
    upsertNeedsWhereTrue: false,
    rowToJson: "row_to_json",
    jsonAgg: "json_agg",
    docStyle: "row",
    identQuote: "\"",
    jsonNeedsUnquote: false,
    upsertStyle: "on-conflict",
    readStyle: "record",
    textType: "text",
    intType: "int",
    floatType: "float8",
    timestampType: "timestamptz",
    nowExpr: "now()",
  };
  return d;
}

// The server's version banner, for a connection smoke test.
export function postgresVersion(): string {
  return pl_version();
}

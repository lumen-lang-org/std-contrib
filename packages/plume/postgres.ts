// The PostgreSQL driver: libpq through the C FFI.
//
//   apt install libpq-dev        # Debian, Ubuntu
//   brew install postgresql@17   # macOS
//   sh packages/plume/build.sh
//
// @link ./plume_shim.o
// @link pq
// @link c
declare function pl_acquire(): int;
declare function pl_open(handle: int, conninfo: string): int;
declare function pl_connected(handle: int): int;
declare function pl_exec(handle: int, sql: string): int;
declare function pl_bind(handle: int, i: int, value: string): int;
declare function pl_query(handle: int, sql: string, argc: int): int;
declare function pl_rows(handle: int): int;
declare function pl_value(handle: int, row: int, col: int): string;
declare function pl_error(handle: int): string;
declare function pl_fail(handle: int, message: string): void;
declare function pl_release(handle: int): void;
declare function pl_version(handle: int): string;

import { Db, DbConfig, targetValue } from "./driver.ts";

// A libpq conninfo string from the config. Every value is quoted, since one
// carrying a space would otherwise end early and the rest of the list would be
// read as further keys.
function pgTarget(config: DbConfig): string {
  let out = "";
  let hostName = config.host ?? "";
  if (hostName != "") { out = out + " host=" + targetValue(hostName); }
  let portNumber = config.port ?? 0;
  if (portNumber > 0) { out = out + " port=" + targetValue(`${portNumber}`); }
  let userName = config.user ?? "";
  if (userName != "") { out = out + " user=" + targetValue(userName); }
  let secret = config.password ?? "";
  if (secret != "") { out = out + " password=" + targetValue(secret); }
  let dbName = config.database ?? "";
  if (dbName != "") { out = out + " dbname=" + targetValue(dbName); }
  let extra = config.options ?? "";
  if (extra != "") { out = out + " " + extra; }
  return out.trim();
}

// A config naming nothing to reach is refused rather than attempted: libpq
// would otherwise fall back on a local socket and its own environment, and
// connect somewhere the caller never asked for. The message carries no part of
// the config, so a password cannot reach a log through a diagnostic.
function pgConnect(handle: int, config: DbConfig): bool {
  let hostName = config.host ?? "";
  let extra = config.options ?? "";
  if (hostName == "" && extra == "") {
    pl_fail(handle, "the configuration names neither a host nor options");
    return false;
  }
  return pl_open(handle, pgTarget(config)) == 0;
}

// Bind every value, then execute. The FFI passes one string per call, so an
// argument list is sent a value at a time and the count tells the shim how
// many of them the statement is to use.
function pgRun(handle: int, sql: string, args: string[]): bool {
  let i: int = 0;
  while (i < args.length) {
    if (pl_bind(handle, i, args[i]) != 0) { return false; }
    i = i + 1;
  }
  return pl_query(handle, sql, args.length) >= 0;
}

// A `Db` for one slot of the shim's connection table. The handle is captured
// when the record is built, which is right: a `Db` is a connection, not a
// thing that might later have one.
function postgresOn(handle: int): Db {
  let d: Db = {
    connect: (config: DbConfig) => { return pgConnect(handle, config); },
    connected: () => { return pl_connected(handle) == 1; },
    close: () => { pl_release(handle); },
    exec: (sql: string) => { return pl_exec(handle, sql) == 0; },
    query: (sql: string, args: string[]) => { return pgRun(handle, sql, args); },
    rows: () => { return pl_rows(handle); },
    value: (row: int, col: int) => { return pl_value(handle, row, col); },
    lastError: () => { return pl_error(handle); },
    name: "postgres",
    placeholder: "$1",
    numberedPlaceholders: true,
    upsertNeedsWhereTrue: false,
    rowToJson: "row_to_json",
    jsonAgg: "json_agg",
    canAddForeignKey: true,
    emptyJsonArray: "'[]'::json",
    nestedJsonWrap: false,
    docStyle: "row",
    identQuote: "\"",
    backslashEscapes: false,
    jsonNeedsUnquote: false,
    upsertStyle: "on-conflict",
    readStyle: "record",
    floatJson: "",
    // PostgreSQL has a real boolean, and row_to_json writes it as one.
    boolJson: "",
    textType: "text",
    intType: "int",
    floatType: "float8",
    timestampType: "timestamptz",
    nowExpr: "now()",
  };
  return d;
}

// The process-wide connection, slot 0. `connectDatabase` opens it; a program
// that only ever wants one database wants this.
export function postgres(): Db {
  return postgresOn(0);
}

// A connection of its own, opened straight away, for a pool or for a
// transaction a caller means to hold. `connected()` is false when no slot was
// free or the connection failed; `lastError()` says which.
//
//   let config: DbConfig = { host: "127.0.0.1", database: "lumenvec", user: "lumen" };
//   let database = postgresConnection(config);
export function postgresConnection(config: DbConfig): Db {
  let handle = pl_acquire();
  if (handle >= 0) { pgConnect(handle, config); }
  return postgresOn(handle);
}

// The server's version banner, for a connection smoke test.
export function postgresVersion(): string {
  return pl_version(0);
}

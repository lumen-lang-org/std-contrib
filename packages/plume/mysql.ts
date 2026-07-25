// The MySQL and MariaDB driver: libmysqlclient or libmariadb through the C FFI.
//
//   apt install libmariadb-dev   # Debian, Ubuntu — works for both
//   brew install mariadb         # macOS
//   sh packages/plume/build.sh
//
// @link ./mysql_shim.o
// @link mariadb
// @link c
declare function my_acquire(): int;
declare function my_open(handle: int, target: string): int;
declare function my_connected(handle: int): int;
declare function my_exec(handle: int, sql: string): int;
declare function my_bind(handle: int, i: int, value: string): int;
declare function my_query(handle: int, sql: string, argc: int): int;
declare function my_rows(handle: int): int;
declare function my_value(handle: int, row: int, col: int): string;
declare function my_error(handle: int): string;
declare function my_version(handle: int): string;
declare function my_fail(handle: int, message: string): void;
declare function my_release(handle: int): void;

import { Db, DbConfig, targetValue } from "./driver.ts";

// The same key=value list the other drivers take, rather than MySQL's own DSN,
// so a config is rendered the same way whichever driver reads it. Every value
// is quoted, since one carrying a space would otherwise end early and the rest
// of the list would be read as further keys.
function myTarget(config: DbConfig): string {
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

// A config naming nothing to reach is refused rather than attempted: the
// driver defaults the host, so an empty config would connect to whatever runs
// on this machine. The message carries no part of the config, so a password
// cannot reach a log through a diagnostic.
function myConnect(handle: int, config: DbConfig): bool {
  let hostName = config.host ?? "";
  let extra = config.options ?? "";
  if (hostName == "" && extra == "") {
    my_fail(handle, "the configuration names neither a host nor options");
    return false;
  }
  return my_open(handle, myTarget(config)) == 0;
}

// Bind every value, then execute. The FFI passes one string per call, so an
// argument list is sent a value at a time and the count tells the shim how
// many of them the statement is to use.
function myRun(handle: int, sql: string, args: string[]): bool {
  let i: int = 0;
  while (i < args.length) {
    if (my_bind(handle, i, args[i]) != 0) { return false; }
    i = i + 1;
  }
  return my_query(handle, sql, args.length) >= 0;
}

// A `Db` for one slot of the shim's connection table. The handle is captured
// when the record is built, which is right: a `Db` is a connection, not a
// thing that might later have one.
function mysqlOn(handle: int): Db {
  let d: Db = {
    connect: (config: DbConfig) => { return myConnect(handle, config); },
    connected: () => { return my_connected(handle) == 1; },
    close: () => { my_release(handle); },
    exec: (sql: string) => { return my_exec(handle, sql) == 0; },
    query: (sql: string, args: string[]) => { return myRun(handle, sql, args); },
    rows: () => { return my_rows(handle); },
    value: (row: int, col: int) => { return my_value(handle, row, col); },
    lastError: () => { return my_error(handle); },
    name: "mysql",
    placeholder: "?",
    numberedPlaceholders: false,
    upsertNeedsWhereTrue: false,
    rowToJson: "JSON_OBJECT",
    jsonAgg: "JSON_ARRAYAGG",
    canAddForeignKey: true,
    emptyJsonArray: "JSON_ARRAY()",
    nestedJsonWrap: false,
    docStyle: "pairs",
    identQuote: "`",
    readStyle: "json-table",
    // JSON_EXTRACT returns a JSON value, so a string comes back with its
    // quotes still on and has to be unquoted before it reaches a text column.
    backslashEscapes: true,
    jsonNeedsUnquote: true,
    upsertStyle: "on-duplicate-key",
    floatJson: "",
    textType: "varchar(255)",
    intType: "int",
    floatType: "double",
    timestampType: "timestamp",
    nowExpr: "CURRENT_TIMESTAMP",
  };
  return d;
}

// The process-wide connection, slot 0. `connectDatabase` opens it; a program
// that only ever wants one database wants this.
export function mysql(): Db {
  return mysqlOn(0);
}

// A connection of its own, opened straight away, for a pool or for a
// transaction a caller means to hold.
//
//   let config: DbConfig = { host: "127.0.0.1", port: 3306, database: "app", user: "root" };
//   let database = mysqlConnection(config);
export function mysqlConnection(config: DbConfig): Db {
  let handle = my_acquire();
  if (handle >= 0) { myConnect(handle, config); }
  return mysqlOn(handle);
}

export function mysqlVersion(): string {
  return my_version(0);
}

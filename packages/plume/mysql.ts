// The MySQL and MariaDB driver: libmysqlclient or libmariadb through the C FFI.
//
//   apt install libmariadb-dev   # Debian, Ubuntu — works for both
//   brew install mariadb         # macOS
//   sh packages/plume/build.sh
//
// @link ./mysql_shim.o
// @link mariadb
// @link c
declare function my_connect(target: string): int;
declare function my_connected(): int;
declare function my_exec(sql: string): int;
declare function my_query0(sql: string): int;
declare function my_query1(sql: string, a: string): int;
declare function my_rows(): int;
declare function my_value(row: int, col: int): string;
declare function my_error(): string;
declare function my_version(): string;
declare function my_close(): void;

import { Db } from "./driver.ts";

// `target` is the same key=value list the other drivers take, rather than
// MySQL's own DSN, so a connection string is portable across drivers:
//   "host=127.0.0.1 port=3306 user=root password=lumen dbname=lumentest"
export function mysql(): Db {
  let d: Db = {
    connect: (target: string) => { return my_connect(target) == 0; },
    connected: () => { return my_connected() == 1; },
    close: () => { my_close(); },
    exec: (sql: string) => { return my_exec(sql) == 0; },
    query: (sql: string, a: string) => { return my_query1(sql, a) >= 0; },
    queryNoArgs: (sql: string) => { return my_query0(sql) >= 0; },
    rows: () => { return my_rows(); },
    value: (row: int, col: int) => { return my_value(row, col); },
    lastError: () => { return my_error(); },
    name: "mysql",
    // Bare `?`, and the driver binds the same value to every one of them —
    // MySQL has no numbered parameters, so repetition is handled underneath
    // rather than in the SQL.
    placeholder: "?",
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

export function mysqlVersion(): string {
  return my_version();
}

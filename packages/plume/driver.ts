// A database, as plume needs one: six functions to talk to it, and the handful
// of places SQL dialects disagree.
//
// The core carries no FFI and links nothing. A driver module does both, so a
// program that uses SQLite does not need libpq installed, and one that uses
// PostgreSQL does not need libsqlite3. That is the whole reason this type
// exists rather than a provider string.
//
// A driver's functions capture nothing and call the FFI declarations in their
// own module by name, which is what a closure here may do.

export type Db = {
  // --- talking to it -----------------------------------------------------
  // `connect` takes whatever the driver's library takes: a libpq conninfo
  // string, a file path, a host/user/password triple encoded as the driver
  // documents.
  connect: (target: string) => bool,
  connected: () => bool,
  close: () => void,
  // Run a statement, returning false on failure.
  exec: (sql: string) => bool,
  // Run a query holding its rows, with up to one bound parameter — every
  // statement plume builds needs at most one, because a document goes in
  // whole rather than field by field.
  query: (sql: string, a: string) => bool,
  queryNoArgs: (sql: string) => bool,
  rows: () => int,
  value: (row: int, col: int) => string,
  lastError: () => string,

  // --- where dialects differ ---------------------------------------------
  // The name shown in a diagnostic.
  name: string,
  // `$1` for PostgreSQL, `?` for SQLite and MySQL.
  placeholder: string,
  // Whether an INSERT ... SELECT needs `WHERE true` before `ON CONFLICT`.
  // SQLite's parser cannot otherwise tell the upsert clause from a join
  // condition; found by trying it, not by reading a manual.
  upsertNeedsWhereTrue: bool,
  // How a row becomes JSON, and how many rows become a JSON array.
  rowToJson: string,
  jsonAgg: string,
  // Whether rowToJson takes a whole row ("row", PostgreSQL's row_to_json) or
  // alternating keys and columns ("pairs", the json_object of SQLite and
  // MySQL). This is separate from readStyle because a driver can read one way
  // and write the other.
  docStyle: string,
  // What quotes an identifier: `"` everywhere except MySQL, which wants a
  // backtick unless the server runs in ANSI_QUOTES mode.
  identQuote: string,
  // Which shape the driver reads a document with: "record" for PostgreSQL's
  // json_to_record, "extract" for SQLite's json_each plus json_extract,
  // "json-table" for MySQL's JSON_TABLE.
  readStyle: string,
  // Whether pulling a scalar out of a JSON document leaves it quoted. MySQL's
  // JSON_EXTRACT does and needs JSON_UNQUOTE around it; SQLite's does not.
  jsonNeedsUnquote: bool,
  // How the database spells an upsert: "on-conflict" for the standard
  // PostgreSQL and SQLite form, "on-duplicate-key" for MySQL's.
  upsertStyle: string,
  // Type names for the portable set, since `float8` is not `REAL` is not
  // `DOUBLE`.
  textType: string,
  intType: string,
  floatType: string,
  // A moment in time, and the expression for "now" — the migration log needs
  // both, and no two drivers spell them alike.
  timestampType: string,
  nowExpr: string,
};

// A driver that is not connected to anything, so a mapping can be validated
// and SQL inspected without a database. Every call fails; nothing raises.
export function noDatabase(): Db {
  let d: Db = {
    connect: (target: string) => { return false; },
    connected: () => { return false; },
    close: () => { },
    exec: (sql: string) => { return false; },
    query: (sql: string, a: string) => { return false; },
    queryNoArgs: (sql: string) => { return false; },
    rows: () => { return 0; },
    value: (row: int, col: int) => { return ""; },
    lastError: () => { return "no database driver is connected"; },
    name: "none",
    placeholder: "$1",
    upsertNeedsWhereTrue: false,
    rowToJson: "row_to_json",
    jsonAgg: "json_agg",
    docStyle: "row",
    identQuote: "\"",
    readStyle: "record",
    jsonNeedsUnquote: false,
    upsertStyle: "on-conflict",
    textType: "text",
    intType: "int",
    floatType: "float8",
    timestampType: "timestamptz",
    nowExpr: "now()",
  };
  return d;
}

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

// What a connection is asked for. A record with optional fields rather than a
// string: a `host=... user=...` list is untyped, spelled differently by every
// library, and a typo in it is a runtime failure rather than a compile error.
// The names are node-postgres's, verbatim, so a config reads the same here as
// in the ecosystem they came from.
//
// A caller writes only the fields that matter:
//
//   let config: DbConfig = { host: "127.0.0.1", database: "app", user: "lumen" };
//   let local: DbConfig = { filename: "/tmp/app.db" };
//
// Rendering a config into whatever a library takes is the driver's own
// business; nothing outside one should build a target string.
export type DbConfig = {
  host?: string,
  // Absent means the driver's default: 5432 for PostgreSQL, 3306 for MySQL.
  port?: int,
  user?: string,
  password?: string,
  database?: string,
  // SQLite, which has a file rather than a server. ":memory:" for a database
  // that lives as long as the process.
  filename?: string,
  // Anything a driver's library takes that the fields above do not cover —
  // sslmode, a socket path, a libpq service name — appended verbatim. Also the
  // escape hatch: a config carrying only options is a raw target, which is how
  // an exotic DSN or a service file entry gets through.
  options?: string,
};

// One value of a `key=value` target list, always quoted.
//
// Always, not only when it needs it: a password carrying a space would
// otherwise end its value early and the rest of the list would be read as
// further keys, so a program would connect somewhere other than where it said
// and find out at the first query. Quoting and escaping is the same convention
// libpq documents, and the MySQL shim's parser follows it.
//
// For driver authors. A program that uses plume never calls this.
export function targetValue(text: string): string {
  return "'" + text.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
}

export type Db = {
  // --- talking to it -----------------------------------------------------
  // `connect` renders the config the way its own library wants it. It fails
  // rather than guessing when the config names nothing to connect to.
  connect: (config: DbConfig) => bool,
  connected: () => bool,
  close: () => void,
  // Run a statement, returning false on failure.
  exec: (sql: string) => bool,
  // Run a query holding its rows. The driver binds each argument in turn and
  // then executes, so a value never reaches the statement as text. An empty
  // array is a query with no parameters, which is why there is no second
  // no-argument form.
  query: (sql: string, args: string[]) => bool,
  rows: () => int,
  value: (row: int, col: int) => string,
  lastError: () => string,

  // --- where dialects differ ---------------------------------------------
  // The name shown in a diagnostic.
  name: string,
  // The marker for the first bound parameter: `$1` for PostgreSQL, `?` for
  // SQLite and MySQL.
  placeholder: string,
  // Whether the marker carries the parameter's number. PostgreSQL's does, so
  // the second parameter is `$2`; the others take their `?` in order and every
  // one is spelled the same. `placeholderAt` reads this.
  numberedPlaceholders: bool,
  // Whether an INSERT ... SELECT needs `WHERE true` before `ON CONFLICT`.
  // SQLite's parser cannot otherwise tell the upsert clause from a join
  // condition; found by trying it, not by reading a manual.
  upsertNeedsWhereTrue: bool,
  // How a row becomes JSON, and how many rows become a JSON array.
  rowToJson: string,
  jsonAgg: string,
  // Whether a constraint can be added to a table that already exists. SQLite
  // cannot: a foreign key has to be part of the CREATE TABLE.
  canAddForeignKey: bool,
  // An empty array of the kind jsonAgg produces, for a relation that matched
  // nothing. A JSON column will not take a text '[]' on MySQL.
  emptyJsonArray: string,
  // Whether a subquery's JSON has to be named as JSON before it can nest
  // inside a document. SQLite would otherwise embed it as a string.
  nestedJsonWrap: bool,
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
  // Whether the database treats a backslash inside a string literal as an
  // escape character. MySQL does, by default and unlike the SQL standard, so
  // doubling the quote is not enough to make a literal safe there.
  backslashEscapes: bool,
  // Whether pulling a scalar out of a JSON document leaves it quoted. MySQL's
  // JSON_EXTRACT does and needs JSON_UNQUOTE around it; SQLite's does not.
  jsonNeedsUnquote: bool,
  // How the database spells an upsert: "on-conflict" for the standard
  // PostgreSQL and SQLite form, "on-duplicate-key" for MySQL's.
  upsertStyle: string,
  // How a float column is written into a document, as an expression with
  // `{c}` standing for the column. SQLite renders a REAL as text with 15
  // significant digits, which silently loses the last two of a double, so it
  // needs the value formatted itself. Empty on a driver that gets this right.
  floatJson: string,
  // How a bool column is written into a document, as an expression with `{c}`
  // for the column. SQLite and MySQL have no boolean type — both store 0 and
  // 1 — so a document would carry a number where the record declares a bool,
  // and JSON.parse would refuse it. Empty on a driver with a real boolean.
  boolJson: string,
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
    connect: (config: DbConfig) => { return false; },
    connected: () => { return false; },
    close: () => { },
    exec: (sql: string) => { return false; },
    query: (sql: string, args: string[]) => { return false; },
    rows: () => { return 0; },
    value: (row: int, col: int) => { return ""; },
    lastError: () => { return "no database driver is connected"; },
    name: "none",
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
    readStyle: "record",
    backslashEscapes: false,
    jsonNeedsUnquote: false,
    upsertStyle: "on-conflict",
    floatJson: "",
    boolJson: "",
    textType: "text",
    intType: "int",
    floatType: "float8",
    timestampType: "timestamptz",
    nowExpr: "now()",
  };
  return d;
}

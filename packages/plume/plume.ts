// plume -- a typed data-mapper over PostgreSQL, through the C FFI.
//
// Java's Panache reads @Entity and @Column by reflection at runtime. There is
// no reflection here, and no annotations — so a mapping is declared outright,
// and two compile-time mappers do the rest of the work:
//
//   JSON.parse<T>  maps JSON to a record, checked by the compiler
//   SQL aliases    map columns to JSON keys, checked by the database
//
// A row therefore reaches a record without a line of field-copying code, and
// nothing is inferred from a name: every field states its column and its SQL
// type. A mapping that disagrees with the table fails at the first query with
// the database's own message, not silently.
//
// Dependencies:
//   apt install postgresql-17 libpq-dev   # Debian, Ubuntu
//   brew install postgresql@17            # macOS
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
declare function pl_query2(sql: string, a: string, b: string): int;
declare function pl_query3(sql: string, a: string, b: string, c: string): int;
declare function pl_query4(sql: string, a: string, b: string, c: string, d: string): int;
declare function pl_query5(sql: string, a: string, b: string, c: string, d: string, e: string): int;
declare function pl_rows(): int;
declare function pl_cols(): int;
declare function pl_value(row: int, col: int): string;
declare function pl_error(): string;
declare function pl_version(): string;
declare function pl_close(): void;

// One field of a mapping: the record's field name, the table's column name,
// and the column's SQL type. Nothing here is derived from anything else.
export type DbField = {
  field: string,
  column: string,
  sqlType: string,
};

// A mapping between a record type and a table. `idField` and `idColumn` name
// the key used by find, persist and delete.
export type DbRepository = {
  table: string,
  idField: string,
  idColumn: string,
  fields: DbField[],
};

// The outcome of a call that changes something, or of one that reads nothing.
export type DbResult = {
  ok: bool,
  rows: int,
  error: string,
};

export function field(name: string, column: string, sqlType: string): DbField {
  let f: DbField = { field: name, column: column, sqlType: sqlType };
  return f;
}

export function repository(table: string, idField: string, idColumn: string, fields: DbField[]): DbRepository {
  let r: DbRepository = { table: table, idField: idField, idColumn: idColumn, fields: fields };
  return r;
}

function dbOk(rows: int): DbResult {
  let r: DbResult = { ok: true, rows: rows, error: "" };
  return r;
}

function dbErr(message: string): DbResult {
  let r: DbResult = { ok: false, rows: 0, error: message };
  return r;
}

function lastError(fallback: string): string {
  let e = pl_error();
  if (e == "") { return fallback; }
  return e;
}

// An identifier that may be interpolated into SQL. Table, column and type
// names cannot be bound as parameters — SQL has no placeholder for them — so
// they are checked instead of trusted. Types allow spaces and parentheses so
// `timestamp with time zone` and `numeric(10,2)` pass.
export function safeIdentifier(name: string): bool {
  if (name.length == 0 || name.length > 63) { return false; }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let isLower = c >= 97 && c <= 122;
    let isUpper = c >= 65 && c <= 90;
    let isDigit = c >= 48 && c <= 57;
    let isUnderscore = c == 95;
    if (!(isLower || isUpper || isDigit || isUnderscore)) { return false; }
    if (i == 0 && isDigit) { return false; }
    i = i + 1;
  }
  return true;
}

export function safeSqlType(name: string): bool {
  if (name.length == 0 || name.length > 63) { return false; }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let isLower = c >= 97 && c <= 122;
    let isUpper = c >= 65 && c <= 90;
    let isDigit = c >= 48 && c <= 57;
    let isOk = c == 95 || c == 32 || c == 40 || c == 41 || c == 44;
    if (!(isLower || isUpper || isDigit || isOk)) { return false; }
    i = i + 1;
  }
  return true;
}

// Every name in a mapping, checked once so a query can interpolate freely.
export function repositoryValid(repo: DbRepository): bool {
  if (!safeIdentifier(repo.table) || !safeIdentifier(repo.idColumn) || !safeIdentifier(repo.idField)) { return false; }
  if (repo.fields.length == 0) { return false; }
  let sawId: bool = false;
  let i: int = 0;
  while (i < repo.fields.length) {
    let f = repo.fields[i];
    if (!safeIdentifier(f.field) || !safeIdentifier(f.column) || !safeSqlType(f.sqlType)) { return false; }
    if (f.field == repo.idField) { sawId = true; }
    i = i + 1;
  }
  return sawId;
}

// --- clause building ------------------------------------------------------------

// `col AS "field", ...` — the read mapping, applied by the database.
export function selectList(repo: DbRepository): string {
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    if (i > 0) { out = out + ", "; }
    out = out + repo.fields[i].column + " AS \"" + repo.fields[i].field + "\"";
    i = i + 1;
  }
  return out;
}

// `"field" sqltype, ...` — the column definition json_to_record needs to read
// the incoming document.
function recordDefinition(repo: DbRepository): string {
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    if (i > 0) { out = out + ", "; }
    out = out + "\"" + repo.fields[i].field + "\" " + repo.fields[i].sqlType;
    i = i + 1;
  }
  return out;
}

function columnList(repo: DbRepository): string {
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    if (i > 0) { out = out + ", "; }
    out = out + repo.fields[i].column;
    i = i + 1;
  }
  return out;
}

function fieldList(repo: DbRepository): string {
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    if (i > 0) { out = out + ", "; }
    out = out + "\"" + repo.fields[i].field + "\"";
    i = i + 1;
  }
  return out;
}

// `col = EXCLUDED.col, ...` for every column but the key.
function updateSet(repo: DbRepository): string {
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    let col = repo.fields[i].column;
    if (col != repo.idColumn) {
      if (out != "") { out = out + ", "; }
      out = out + col + " = EXCLUDED." + col;
    }
    i = i + 1;
  }
  return out;
}

// --- connection ---------------------------------------------------------------------

export function connectDatabase(conninfo: string): DbResult {
  if (pl_connect(conninfo) != 0) {
    return dbErr(lastError("could not connect"));
  }
  return dbOk(0);
}

export function databaseConnected(): bool {
  return pl_connected() == 1;
}

export function closeDatabase(): void {
  pl_close();
}

export function databaseVersion(): int {
  return parseInt(pl_version()) ?? 0;
}

// Run a statement that returns no rows — DDL, or SQL this package does not
// build for you.
export function execute(sql: string): DbResult {
  if (pl_exec(sql) != 0) {
    return dbErr(lastError("statement failed"));
  }
  return dbOk(0);
}

// --- schema ----------------------------------------------------------------------------

// Create the table the mapping describes, if it is absent. The key column is
// the primary key; every other column is NOT NULL, since a record's field
// cannot be absent.
export function createTable(repo: DbRepository): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  let cols = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    let f = repo.fields[i];
    if (i > 0) { cols = cols + ", "; }
    cols = cols + f.column + " " + f.sqlType;
    if (f.column == repo.idColumn) {
      cols = cols + " PRIMARY KEY";
    } else {
      cols = cols + " NOT NULL";
    }
    i = i + 1;
  }
  return execute("CREATE TABLE IF NOT EXISTS " + repo.table + " (" + cols + ")");
}

export function dropTable(repo: DbRepository): DbResult {
  if (!safeIdentifier(repo.table)) { return dbErr("unsafe table name"); }
  return execute("DROP TABLE IF EXISTS " + repo.table);
}

// --- writing ------------------------------------------------------------------------------

// Insert or replace one record, given its JSON. The document's keys are the
// mapping's field names; the database reads them with json_to_record under the
// declared types and writes them to the declared columns.
export function persist(repo: DbRepository, json: string): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (json == "") { return dbErr("refusing to persist an empty document"); }
  let sql = "INSERT INTO " + repo.table + " (" + columnList(repo) + ") "
    + "SELECT " + fieldList(repo) + " FROM json_to_record($1::json) AS x(" + recordDefinition(repo) + ")";
  let updates = updateSet(repo);
  if (updates != "") {
    sql = sql + " ON CONFLICT (" + repo.idColumn + ") DO UPDATE SET " + updates;
  } else {
    sql = sql + " ON CONFLICT (" + repo.idColumn + ") DO NOTHING";
  }
  if (pl_query1(sql, json) < 0) {
    return dbErr(lastError("could not persist into " + repo.table));
  }
  return dbOk(1);
}

// Insert or replace many, in one statement: the document is a JSON array, read
// with json_to_recordset.
export function persistMany(repo: DbRepository, jsonArray: string): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (jsonArray == "" || jsonArray == "[]") { return dbOk(0); }
  let sql = "INSERT INTO " + repo.table + " (" + columnList(repo) + ") "
    + "SELECT " + fieldList(repo) + " FROM json_to_recordset($1::json) AS x(" + recordDefinition(repo) + ")";
  let updates = updateSet(repo);
  if (updates != "") {
    sql = sql + " ON CONFLICT (" + repo.idColumn + ") DO UPDATE SET " + updates;
  } else {
    sql = sql + " ON CONFLICT (" + repo.idColumn + ") DO NOTHING";
  }
  if (pl_query1(sql, jsonArray) < 0) {
    return dbErr(lastError("could not persist into " + repo.table));
  }
  return dbOk(1);
}

export function deleteById(repo: DbRepository, id: string): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (pl_query1("DELETE FROM " + repo.table + " WHERE " + repo.idColumn + " = $1", id) < 0) {
    return dbErr(lastError("could not delete from " + repo.table));
  }
  return dbOk(1);
}

export function deleteWhere(repo: DbRepository, where: string, a: string): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (pl_query1("DELETE FROM " + repo.table + " WHERE " + where, a) < 0) {
    return dbErr(lastError("could not delete from " + repo.table));
  }
  return dbOk(1);
}

// --- reading --------------------------------------------------------------------------------

// One record as JSON, or "" when absent. Hand the result to JSON.parse<T>: the
// keys are the mapping's field names, so the compiler checks the shape.
export function findById(repo: DbRepository, id: string): string {
  if (!repositoryValid(repo)) { return ""; }
  let sql = "SELECT row_to_json(r) FROM (SELECT " + selectList(repo)
    + " FROM " + repo.table + " WHERE " + repo.idColumn + " = $1) r";
  if (pl_query1(sql, id) < 0) { return ""; }
  if (pl_rows() == 0) { return ""; }
  return pl_value(0, 0);
}

// The same, projected: `columns` is a select list you write, so a DTO is a
// query rather than a generated mapper. Aliases rename — `max_steps AS
// "maxSteps"` is what MapStruct spells with an annotation.
export function findProjected(repo: DbRepository, columns: string, id: string): string {
  if (!safeIdentifier(repo.table) || !safeIdentifier(repo.idColumn)) { return ""; }
  let sql = "SELECT row_to_json(r) FROM (SELECT " + columns
    + " FROM " + repo.table + " WHERE " + repo.idColumn + " = $1) r";
  if (pl_query1(sql, id) < 0) { return ""; }
  if (pl_rows() == 0) { return ""; }
  return pl_value(0, 0);
}

function rowsAsArray(): string {
  if (pl_rows() == 0) { return "[]"; }
  return pl_value(0, 0);
}

// Every record as a JSON array. `where` is a fragment with $1 for its
// parameter, or "" for all rows.
export function listWhere(repo: DbRepository, where: string, a: string): string {
  if (!repositoryValid(repo)) { return "[]"; }
  let inner = "SELECT " + selectList(repo) + " FROM " + repo.table;
  if (where != "") { inner = inner + " WHERE " + where; }
  let sql = "SELECT coalesce(json_agg(r), '[]'::json) FROM (" + inner + ") r";
  if (where == "") {
    if (pl_query0(sql) < 0) { return "[]"; }
  } else {
    if (pl_query1(sql, a) < 0) { return "[]"; }
  }
  return rowsAsArray();
}

// A projected list, for DTOs.
export function listProjected(repo: DbRepository, columns: string, where: string, a: string): string {
  if (!safeIdentifier(repo.table)) { return "[]"; }
  let inner = "SELECT " + columns + " FROM " + repo.table;
  if (where != "") { inner = inner + " WHERE " + where; }
  let sql = "SELECT coalesce(json_agg(r), '[]'::json) FROM (" + inner + ") r";
  if (where == "") {
    if (pl_query0(sql) < 0) { return "[]"; }
  } else {
    if (pl_query1(sql, a) < 0) { return "[]"; }
  }
  return rowsAsArray();
}

// A page, ordered by a column you name.
export function pageWhere(repo: DbRepository, where: string, a: string, orderBy: string, limit: int, offset: int): string {
  if (!repositoryValid(repo) || !safeIdentifier(orderBy)) { return "[]"; }
  let inner = "SELECT " + selectList(repo) + " FROM " + repo.table;
  if (where != "") { inner = inner + " WHERE " + where; }
  inner = inner + " ORDER BY " + orderBy + " LIMIT " + `${limit}` + " OFFSET " + `${offset}`;
  let sql = "SELECT coalesce(json_agg(r), '[]'::json) FROM (" + inner + ") r";
  if (where == "") {
    if (pl_query0(sql) < 0) { return "[]"; }
  } else {
    if (pl_query1(sql, a) < 0) { return "[]"; }
  }
  return rowsAsArray();
}

export function countWhere(repo: DbRepository, where: string, a: string): int {
  if (!safeIdentifier(repo.table)) { return -1; }
  let sql = "SELECT count(*) FROM " + repo.table;
  if (where != "") { sql = sql + " WHERE " + where; }
  if (where == "") {
    if (pl_query0(sql) < 0) { return -1; }
  } else {
    if (pl_query1(sql, a) < 0) { return -1; }
  }
  if (pl_rows() == 0) { return 0; }
  return parseInt(pl_value(0, 0)) ?? 0;
}

export function existsById(repo: DbRepository, id: string): bool {
  if (!repositoryValid(repo)) { return false; }
  if (pl_query1("SELECT 1 FROM " + repo.table + " WHERE " + repo.idColumn + " = $1", id) < 0) {
    return false;
  }
  return pl_rows() > 0;
}

// --- transactions --------------------------------------------------------------------------------

// Explicit, not a block that takes a closure: a closure here cannot call a
// function it was handed, so `withTransaction(body)` cannot be written.
export function beginTransaction(): DbResult {
  return execute("BEGIN");
}

export function commitTransaction(): DbResult {
  return execute("COMMIT");
}

export function rollbackTransaction(): DbResult {
  return execute("ROLLBACK");
}

// --- migrations -----------------------------------------------------------------------------------

// Applied in order and recorded, so a second run is a no-op. Flyway's idea
// without its machinery: a migration is a name and a statement.
export function migrate(names: string[], statements: string[]): DbResult {
  if (names.length != statements.length) {
    return dbErr("every migration needs a name: " + `${names.length}` + " names for " + `${statements.length}` + " statements");
  }
  let created = execute("CREATE TABLE IF NOT EXISTS plume_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  if (!created.ok) { return created; }

  let applied: int = 0;
  let i: int = 0;
  while (i < names.length) {
    if (pl_query1("SELECT 1 FROM plume_migrations WHERE name = $1", names[i]) < 0) {
      return dbErr(lastError("could not read the migration log"));
    }
    if (pl_rows() == 0) {
      let ran = execute(statements[i]);
      if (!ran.ok) {
        return dbErr("migration \"" + names[i] + "\" failed: " + ran.error);
      }
      if (pl_query1("INSERT INTO plume_migrations (name) VALUES ($1)", names[i]) < 0) {
        return dbErr(lastError("applied \"" + names[i] + "\" but could not record it"));
      }
      applied = applied + 1;
    }
    i = i + 1;
  }
  return dbOk(applied);
}

export function migrationApplied(name: string): bool {
  if (pl_query1("SELECT 1 FROM plume_migrations WHERE name = $1", name) < 0) { return false; }
  return pl_rows() > 0;
}

// --- mapping in memory ---------------------------------------------------------------------------------

// Narrow a JSON object to the named keys, for turning an entity into a DTO
// without a round trip. `JSON.parse<T>` rejects a document carrying fields the
// target does not declare, so a narrowing step is required; the database does
// this with a projection, and this does it here.
export function pickFields(json: string, keys: string[]): string {
  let out = "{";
  let written: int = 0;
  let i: int = 0;
  while (i < keys.length) {
    let piece = jsonMember(json, keys[i]);
    if (piece != "") {
      if (written > 0) { out = out + ","; }
      out = out + "\"" + keys[i] + "\":" + piece;
      written = written + 1;
    }
    i = i + 1;
  }
  return out + "}";
}

// The raw JSON text of one top-level member's value, or "" when absent.
// Strings are skipped whole and nesting is counted, so a brace inside a value
// does not end it early.
export function jsonMember(json: string, key: string): string {
  let marker = "\"" + key + "\":";
  let at = findJsonMember(json, marker);
  if (at < 0) { return ""; }
  let i = at;
  while (i < json.length && json.charAt(i) == " ") { i = i + 1; }
  let start = i;
  let depth: int = 0;
  let inString: bool = false;
  let escaped: bool = false;
  while (i < json.length) {
    let c = json.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c == "\\") {
        escaped = true;
      } else if (c == "\"") {
        inString = false;
        if (depth == 0) { return json.slice(start, i + 1); }
      }
    } else {
      if (c == "\"") { inString = true; }
      else if (c == "{" || c == "[") { depth = depth + 1; }
      else if (c == "}" || c == "]") {
        if (depth == 0) { return json.slice(start, i); }
        depth = depth - 1;
        if (depth == 0) { return json.slice(start, i + 1); }
      }
      else if (c == "," && depth == 0) { return json.slice(start, i); }
    }
    i = i + 1;
  }
  return "";
}

// The index just past a top-level `"key":`, skipping matches inside strings
// and nested objects.
function findJsonMember(json: string, marker: string): int {
  let depth: int = 0;
  let inString: bool = false;
  let escaped: bool = false;
  let i: int = 0;
  while (i < json.length) {
    let c = json.charAt(i);
    if (inString) {
      if (escaped) { escaped = false; }
      else if (c == "\\") { escaped = true; }
      else if (c == "\"") { inString = false; }
      i = i + 1;
      continue;
    }
    if (c == "\"") {
      if (depth == 1 && i + marker.length <= json.length) {
        if (json.slice(i, i + marker.length) == marker) { return i + marker.length; }
      }
      inString = true;
      i = i + 1;
      continue;
    }
    if (c == "{" || c == "[") { depth = depth + 1; }
    if (c == "}" || c == "]") { depth = depth - 1; }
    i = i + 1;
  }
  return -1;
}

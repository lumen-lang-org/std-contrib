// plume -- a typed data-mapper, over any database a driver speaks.
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
// This file carries no FFI and links nothing: a `Db` from ./postgres.ts or
// ./sqlite.ts supplies both the connection and the handful of places the
// dialects disagree, so a SQLite program never needs libpq installed.
//
import { Db, DbConfig } from "./driver.ts";

// One field of a mapping: the record's field name, the table's column name,
// and the column's SQL type. Nothing here is derived from anything else.
export type DbField = {
  field: string,
  column: string,
  sqlType: string,
};

// A related row, or rows, fetched with the record that points at them.
//
// Not a join: each relation is a correlated subquery producing its own JSON,
// which every one of these databases can nest inside the parent document. A
// join would flatten the two into one row set and leave the caller to
// regroup, and one-to-many would repeat the parent once per child.
//
// `columns` is a select list over the other table, written the way a
// projection is, so `team_name AS "teamName"` names the key.
export type DbRelation = {
  field: string,
  // "one" for a single nested object, "many" for an array of them.
  kind: string,
  table: string,
  localColumn: string,
  foreignColumn: string,
  columns: string,
};

// A mapping between a record type and a table. `idField` and `idColumn` name
// the key used by find, persist and delete.
export type DbRepository = {
  table: string,
  idField: string,
  idColumn: string,
  fields: DbField[],
  relations: DbRelation[],
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
  let none: DbRelation[] = [];
  let r: DbRepository = { table: table, idField: idField, idColumn: idColumn, fields: fields, relations: none };
  return r;
}

// The same, carrying relations. A mapping with none behaves exactly as it did
// before relations existed — the reads below add nothing to the statement.
export function repositoryWith(table: string, idField: string, idColumn: string, fields: DbField[], relations: DbRelation[]): DbRepository {
  let r: DbRepository = { table: table, idField: idField, idColumn: idColumn, fields: fields, relations: relations };
  return r;
}

export function hasOne(fieldName: string, table: string, localColumn: string, foreignColumn: string, columns: string): DbRelation {
  let r: DbRelation = { field: fieldName, kind: "one", table: table, localColumn: localColumn, foreignColumn: foreignColumn, columns: columns };
  return r;
}

export function hasMany(fieldName: string, table: string, localColumn: string, foreignColumn: string, columns: string): DbRelation {
  let r: DbRelation = { field: fieldName, kind: "many", table: table, localColumn: localColumn, foreignColumn: foreignColumn, columns: columns };
  return r;
}

// A relation's names are interpolated into SQL like a mapping's are, and its
// column list is read the same way a projection is.
export function relationValid(rel: DbRelation): bool {
  if (!safeIdentifier(rel.field) || !safeIdentifier(rel.table)) { return false; }
  if (!safeIdentifier(rel.localColumn) || !safeIdentifier(rel.foreignColumn)) { return false; }
  if (rel.kind != "one" && rel.kind != "many") { return false; }
  return projectionValid(rel.columns);
}

function dbOk(rows: int): DbResult {
  let r: DbResult = { ok: true, rows: rows, error: "" };
  return r;
}

function dbErr(message: string): DbResult {
  let r: DbResult = { ok: false, rows: 0, error: message };
  return r;
}

function lastError(db: Db, fallback: string): string {
  let e = db.lastError();
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

// The marker for the nth bound parameter, counting from 1, in the driver's own
// spelling. A where clause with two values is written
// `a = placeholderAt(db, 1) + " AND b > " + placeholderAt(db, 2)` and runs
// unchanged on all three, which a literal `$1` or `?` would not.
export function placeholderAt(db: Db, n: int): string {
  if (!db.numberedPlaceholders) { return db.placeholder; }
  return "$" + `${n}`;
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

function fieldList(db: Db, repo: DbRepository): string {
  let q = db.identQuote;
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    if (i > 0) { out = out + ", "; }
    out = out + q + repo.fields[i].field + q;
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

// A relation as one column of the parent's select list: a correlated subquery
// producing its own JSON, which every driver can nest inside the parent
// document. Empty when the relation is malformed, so the caller refuses.
function relationColumn(db: Db, repo: DbRepository, rel: DbRelation): string {
  if (!relationValid(rel)) { return ""; }
  let link = rel.table + "." + rel.foreignColumn + " = " + repo.table + "." + rel.localColumn;
  if (db.docStyle == "pairs") {
    let pairs = pairsFromColumns(rel.columns);
    if (pairs == "") { return ""; }
    let inner = "";
    if (rel.kind == "one") {
      inner = "SELECT " + db.rowToJson + "(" + pairs + ") FROM " + rel.table + " WHERE " + link;
    } else {
      inner = "SELECT coalesce(" + db.jsonAgg + "(" + db.rowToJson + "(" + pairs + ")), "
        + db.emptyJsonArray + ") FROM " + rel.table + " WHERE " + link;
    }
    // SQLite would embed the subquery's result as a string without this;
    // MySQL already knows it is JSON and says so by needing nothing.
    if (db.nestedJsonWrap) { return "json((" + inner + "))"; }
    return "(" + inner + ")";
  }
  if (rel.kind == "one") {
    return "(SELECT " + db.rowToJson + "(rel) FROM (SELECT " + rel.columns
      + " FROM " + rel.table + " WHERE " + link + ") rel)";
  }
  return "(SELECT coalesce(" + db.jsonAgg + "(rel), " + db.emptyJsonArray + ") FROM (SELECT "
    + rel.columns + " FROM " + rel.table + " WHERE " + link + ") rel)";
}

// The parent's own columns followed by one column per relation. Used by the
// row-style drivers, where the document is built from a subquery's columns.
function selectListWithRelations(db: Db, repo: DbRepository): string {
  let out = selectList(repo);
  let i: int = 0;
  while (i < repo.relations.length) {
    let col = relationColumn(db, repo, repo.relations[i]);
    if (col == "") { return ""; }
    out = out + ", " + col + " AS \"" + repo.relations[i].field + "\"";
    i = i + 1;
  }
  return out;
}

// One row as a document, from the mapping's own columns.
function oneSql(db: Db, repo: DbRepository, where: string): string {
  if (db.docStyle == "pairs") {
    let doc = rowJson(db, repo);
    if (doc == "") { return ""; }
    return "SELECT " + doc + " FROM " + repo.table + " WHERE " + where;
  }
  let cols = selectListWithRelations(db, repo);
  if (cols == "") { return ""; }
  return "SELECT " + db.rowToJson + "(r) FROM (SELECT " + cols
    + " FROM " + repo.table + " WHERE " + where + ") r";
}

// One row as a document, from a select list the caller wrote. SQLite's
// json_object wants key/value pairs and cannot take a row, so the projection
// goes through a named subquery either way and SQLite re-wraps it with
// json_object over `*` — which it spells as a correlated select.
function projectedSql(db: Db, repo: DbRepository, columns: string, where: string): string {
  if (db.docStyle == "pairs") {
    let pairs = pairsFromColumns(columns);
    if (pairs == "") { return ""; }
    return "SELECT " + db.rowToJson + "(" + pairs + ") FROM " + repo.table
      + " WHERE " + where;
  }
  return "SELECT " + db.rowToJson + "(r) FROM (SELECT " + columns
    + " FROM " + repo.table + " WHERE " + where + ") r";
}

// Turn a select list into json_object pairs, so `a, b AS "c"` becomes
// `'a', a, 'c', b`. An alias names the key; without one the expression's own
// text does, which is what row_to_json would have used too.
// Split a select list on its top-level commas. Splitting on every comma
// breaks `coalesce(a, b) AS x` into two nonsense pieces, which is not a
// hostile input — it is ordinary SQL, and on a pairs-style driver it produced
// a document with the key "coalesce(agent_name" while PostgreSQL returned the
// right answer for the identical call.
export function splitTopLevel(columns: string): string[] {
  let out: string[] = [];
  let depth: int = 0;
  let inSingle = false;
  let inDouble = false;
  let start: int = 0;
  let i: int = 0;
  while (i < columns.length) {
    let c = columns.charCodeAt(i);
    if (inSingle) {
      if (c == 39) { inSingle = false; }
    } else if (inDouble) {
      if (c == 34) { inDouble = false; }
    } else if (c == 39) {
      inSingle = true;
    } else if (c == 34) {
      inDouble = true;
    } else if (c == 40) {
      depth = depth + 1;
    } else if (c == 41) {
      depth = depth - 1;
    } else if (c == 44 && depth == 0) {
      out.push(columns.substring(start, i));
      start = i + 1;
    }
    i = i + 1;
  }
  out.push(columns.substring(start, columns.length));
  // An unbalanced expression is refused rather than guessed at.
  if (depth != 0 || inSingle || inDouble) {
    let empty: string[] = [];
    return empty;
  }
  return out;
}

// Where the top-level ` AS ` of one select-list entry begins, or -1. Looked
// for outside quotes and outside parentheses, so the `as` in
// `cast(x as text)` is not mistaken for one.
export function asIndexOf(part: string): int {
  let depth: int = 0;
  let inSingle = false;
  let inDouble = false;
  let i: int = 0;
  while (i + 4 <= part.length) {
    let c = part.charCodeAt(i);
    if (inSingle) {
      if (c == 39) { inSingle = false; }
    } else if (inDouble) {
      if (c == 34) { inDouble = false; }
    } else if (c == 39) {
      inSingle = true;
    } else if (c == 34) {
      inDouble = true;
    } else if (c == 40) {
      depth = depth + 1;
    } else if (c == 41) {
      depth = depth - 1;
    } else if (depth == 0) {
      if (part.substring(i, i + 4).toLowerCase() == " as ") { return i; }
    }
    i = i + 1;
  }
  return -1;
}

// The alias of one entry, or an empty string when it has none.
export function aliasOf(part: string): string {
  let at = asIndexOf(part);
  if (at < 0) { return ""; }
  return part.substring(at + 4, part.length).trim();
}

// The expression of one entry: everything before its alias.
export function exprOf(part: string): string {
  let at = asIndexOf(part);
  if (at < 0) { return part.trim(); }
  return part.substring(0, at).trim();
}

// A JSON key taken from a select-list alias. It is written into the statement
// between single quotes, so it must be a plain name: a key carrying a quote
// would end the literal, and the projection is refused rather than repaired.
export function keyFromAlias(alias: string): string {
  let name = alias;
  if (name.length >= 2 && name.startsWith("\"") && name.endsWith("\"")) {
    name = name.substring(1, name.length - 1);
  }
  if (!safeIdentifier(name)) { return ""; }
  return name;
}

// Whether a select list can be read the same way by every driver.
//
// A pairs-style driver builds the document's keys itself, so an alias has to
// be a plain name there. PostgreSQL would accept any quoted identifier, but a
// projection that works in development and is refused in production has not
// made anything portable — so the stricter rule is the rule everywhere.
export function projectionValid(columns: string): bool {
  return pairsFromColumns(columns) != "";
}

// Turn a select list into json_object pairs, so `a, b AS "c"` becomes
// `'a', a, 'c', b`. An alias names the key; without one the expression must be
// a plain column, since its own text becomes the key.
//
// Returns an empty string when the list cannot be read that way — an alias
// that is not a plain name, an unaliased expression, an unbalanced quote. The
// caller refuses the query rather than sending something it has guessed at.
export function pairsFromColumns(columns: string): string {
  let parts = splitTopLevel(columns);
  if (parts.length == 0) { return ""; }
  let out = "";
  let i: int = 0;
  while (i < parts.length) {
    let part = parts[i].trim();
    if (part != "") {
      let expr = exprOf(part);
      let alias = aliasOf(part);
      let key = "";
      if (alias == "") {
        // No alias: the expression itself names the key, so it has to be a
        // plain column.
        if (!safeIdentifier(part)) { return ""; }
        key = part;
        expr = part;
      } else {
        key = keyFromAlias(alias);
        if (key == "" || expr == "") { return ""; }
      }
      if (out != "") { out = out + ", "; }
      out = out + "'" + key + "', " + expr;
    }
    i = i + 1;
  }
  return out;
}

// A list of documents. PostgreSQL aggregates whole rows of an aliased
// subquery; SQLite aggregates a json_object built per row.
// Every matching record as one document per row.
//
// Not aggregated in SQL. MySQL's JSON_ARRAYAGG does not preserve the order of
// what it aggregates — a subquery's ORDER BY is honoured for which rows come
// back and ignored for the order they sit in — so a page could contain the
// right records in the wrong order, and did. Selecting a document per row and
// assembling the array here is the one shape all three databases order the
// same way, and it costs a join in Lumen instead of one in the database.
function listSql(db: Db, repo: DbRepository, where: string, tail: string): string {
  if (db.docStyle == "pairs") {
    let doc = rowJson(db, repo);
    if (doc == "") { return ""; }
    let sql = "SELECT " + doc + " FROM " + repo.table;
    if (where != "") { sql = sql + " WHERE " + where; }
    return sql + tail;
  }
  let cols = selectListWithRelations(db, repo);
  if (cols == "") { return ""; }
  let inner = "SELECT " + cols + " FROM " + repo.table;
  if (where != "") { inner = inner + " WHERE " + where; }
  return "SELECT " + db.rowToJson + "(" + repo.table + ") FROM (" + inner + tail + ") " + repo.table;
}

// A column as it goes into a document. Only a float needs anything: SQLite
// renders a REAL to text at 15 significant digits, so a double carrying more
// comes back changed, and a mapper that quietly alters a number is worse than
// one that refuses.
function jsonValue(db: Db, f: DbField): string {
  if (db.floatJson != "" && dialectType(db, f.sqlType) == db.floatType) {
    return db.floatJson.replaceAll("{c}", f.column);
  }
  return f.column;
}

// A row as a document. PostgreSQL wraps a subquery with row_to_json and takes
// its keys from the aliases; SQLite names each key beside its column, since
// json_object takes pairs rather than a row.
function rowJson(db: Db, repo: DbRepository): string {
  if (db.docStyle == "pairs") {
    let pairs = "";
    let i: int = 0;
    while (i < repo.fields.length) {
      if (i > 0) { pairs = pairs + ", "; }
      pairs = pairs + "'" + repo.fields[i].field + "', " + jsonValue(db, repo.fields[i]);
      i = i + 1;
    }
    let r: int = 0;
    while (r < repo.relations.length) {
      let col = relationColumn(db, repo, repo.relations[r]);
      if (col == "") { return ""; }
      pairs = pairs + ", '" + repo.relations[r].field + "', " + col;
      r = r + 1;
    }
    return db.rowToJson + "(" + pairs + ")";
  }
  return db.rowToJson + "(r)";
}

// The FROM a document query needs: PostgreSQL reads from an aliased subquery,
// SQLite straight from the table.
function jsonFrom(db: Db, repo: DbRepository): string {
  if (db.readStyle == "extract") { return " FROM " + repo.table; }
  return " FROM (SELECT " + selectList(repo) + " FROM " + repo.table;
}

// How a driver reads one document. PostgreSQL declares the shape once with
// json_to_record; SQLite pulls each field out with json_extract, which needs
// no declaration but repeats the path per column.
function readOne(db: Db, repo: DbRepository): string {
  if (db.readStyle == "extract") {
    let picks = "";
    let i: int = 0;
    while (i < repo.fields.length) {
      if (i > 0) { picks = picks + ", "; }
      picks = picks + jsonPick(db, "plume_doc.doc", repo.fields[i]);
      i = i + 1;
    }
    // The document is named once and every field read from that name. An
    // unnumbered `?` is a parameter of its own wherever it appears, so
    // repeating the marker would ask for one bound copy of the document per
    // field — which is what the numbered `?1` was working around.
    return "SELECT " + picks + " FROM (SELECT " + db.placeholder + " AS doc) AS plume_doc";
  }
  if (db.readStyle == "json-table") {
    // JSON_TABLE declares the shape like json_to_record does, but reads from
    // the document rather than being applied to it, so a single object is
    // walked as a one-element array.
    return "SELECT " + fieldList(db, repo) + " FROM JSON_TABLE(" + db.placeholder
      + ", '$' COLUMNS (" + jsonTableColumns(db, repo) + ")) AS x";
  }
  return "SELECT " + fieldList(db, repo) + " FROM json_to_record(" + db.placeholder + "::json) AS x(" + recordDefinition(repo) + ")";
}

// The same for an array of documents. SQLite walks it with json_each, whose
// `value` is each element.
function readMany(db: Db, repo: DbRepository): string {
  if (db.readStyle == "extract") {
    let picks = "";
    let i: int = 0;
    while (i < repo.fields.length) {
      if (i > 0) { picks = picks + ", "; }
      picks = picks + jsonPick(db, "value", repo.fields[i]);
      i = i + 1;
    }
    return "SELECT " + picks + " FROM json_each(" + db.placeholder + ")";
  }
  if (db.readStyle == "json-table") {
    return "SELECT " + fieldList(db, repo) + " FROM JSON_TABLE(" + db.placeholder
      + ", '$[*]' COLUMNS (" + jsonTableColumns(db, repo) + ")) AS x";
  }
  return "SELECT " + fieldList(db, repo) + " FROM json_to_recordset(" + db.placeholder + "::json) AS x(" + recordDefinition(repo) + ")";
}

function upsertClause(db: Db, repo: DbRepository): string {
  if (db.upsertStyle == "on-duplicate-key") {
    // MySQL names no conflict target: the clause fires for whichever unique
    // key was violated. A mapping with only a key column has nothing to set,
    // so it re-sets the key to itself, which is MySQL's own no-op idiom.
    let sets = updateSetMysql(repo);
    if (sets == "") { sets = repo.idColumn + " = " + repo.idColumn; }
    return " ON DUPLICATE KEY UPDATE " + sets;
  }
  // SQLite cannot tell an upsert clause from a join condition after an
  // INSERT ... SELECT; `WHERE true` settles it.
  let head = "";
  if (db.upsertNeedsWhereTrue) { head = " WHERE true"; }
  let updates = updateSet(repo);
  if (updates == "") {
    return head + " ON CONFLICT (" + repo.idColumn + ") DO NOTHING";
  }
  return head + " ON CONFLICT (" + repo.idColumn + ") DO UPDATE SET " + updates;
}

// MySQL's form of the same thing. `VALUES(col)` is deprecated in 8.0.20 but
// still the only spelling MariaDB and older MySQL both accept.
function updateSetMysql(repo: DbRepository): string {
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    let col = repo.fields[i].column;
    if (col != repo.idColumn) {
      if (out != "") { out = out + ", "; }
      out = out + col + " = VALUES(" + col + ")";
    }
    i = i + 1;
  }
  return out;
}

// One field pulled out of a JSON document held in `source`.
function jsonPick(db: Db, source: string, f: DbField): string {
  let pick = "json_extract(" + source + ", '$." + f.field + "')";
  if (db.jsonNeedsUnquote) { return "JSON_UNQUOTE(" + pick + ")"; }
  return pick;
}

// JSON_TABLE's column declarations: a name, a type, and the path to read.
function jsonTableColumns(db: Db, repo: DbRepository): string {
  let out = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    if (i > 0) { out = out + ", "; }
    out = out + "`" + repo.fields[i].field + "` " + dialectType(db, repo.fields[i].sqlType)
      + " PATH '$." + repo.fields[i].field + "'";
    i = i + 1;
  }
  return out;
}

// --- connection ---------------------------------------------------------------------

// The config is a plain record — `{ host: "127.0.0.1", database: "app" }`, or
// `{ filename: "/tmp/app.db" }` for SQLite — and each driver renders it into
// whatever its own library takes.
export function connectDatabase(db: Db, config: DbConfig): DbResult {
  if (!db.connect(config)) {
    return dbErr(lastError(db, "could not connect through the " + db.name + " driver"));
  }
  return dbOk(0);
}

export function databaseConnected(db: Db): bool {
  return db.connected();
}

export function closeDatabase(db: Db): void {
  db.close();
}

// Run a statement that returns no rows — DDL, or SQL this package does not
// build for you.
export function execute(db: Db, sql: string): DbResult {
  if (!db.exec(sql)) {
    return dbErr(lastError(db, "statement failed"));
  }
  return dbOk(0);
}

// --- schema ----------------------------------------------------------------------------

// Create the table the mapping describes, if it is absent. The key column is
// the primary key; every other column is NOT NULL, since a record's field
// cannot be absent.
// A mapping states portable type names; each driver spells them its own way.
// A name the portable set does not cover passes through untouched, so a
// column can still be declared in the database's own vocabulary.
export function dialectType(db: Db, sqlType: string): string {
  if (sqlType == "text") { return db.textType; }
  if (sqlType == "int") { return db.intType; }
  if (sqlType == "float8") { return db.floatType; }
  return sqlType;
}

// The CREATE TABLE statement for a mapping, as text. `createTable` runs this;
// a migration can hold it instead, so the schema a program expects and the
// schema a migration builds come from one declaration.
export function createTableSql(db: Db, repo: DbRepository): string {
  if (!repositoryValid(repo)) { return ""; }
  let cols = "";
  let i: int = 0;
  while (i < repo.fields.length) {
    let f = repo.fields[i];
    if (i > 0) { cols = cols + ", "; }
    cols = cols + f.column + " " + dialectType(db, f.sqlType);
    if (f.column == repo.idColumn) {
      cols = cols + " PRIMARY KEY";
    } else {
      cols = cols + " NOT NULL";
    }
    i = i + 1;
  }
  return "CREATE TABLE IF NOT EXISTS " + repo.table + " (" + cols + ")";
}

// The same, with a REFERENCES clause for every to-one relation.
//
// SQLite cannot add a constraint to a table that exists, so this is the only
// way to get foreign keys there — and the referenced tables must already
// exist when it runs. On PostgreSQL and MySQL `foreignKeys` is the gentler
// route, since it does not constrain creation order.
export function createTableSqlWithKeys(db: Db, repo: DbRepository): string {
  let base = createTableSql(db, repo);
  if (base == "") { return ""; }
  let refs = "";
  let i: int = 0;
  while (i < repo.relations.length) {
    let rel = repo.relations[i];
    // A to-many's column lives on the other table, so its constraint belongs
    // to that table's own mapping, not to this one.
    if (rel.kind == "one") {
      if (!relationValid(rel)) { return ""; }
      refs = refs + ", FOREIGN KEY (" + rel.localColumn + ") REFERENCES "
        + rel.table + " (" + rel.foreignColumn + ")";
    }
    i = i + 1;
  }
  if (refs == "") { return base; }
  return base.substring(0, base.length - 1) + refs + ")";
}

// One ALTER statement per to-one relation, for a migration.
//
// A relation already says which column points at which column of which table,
// which is a foreign key written out. plume does not add the constraint
// itself: a schema change belongs in a migration, where it is recorded and
// checksummed like every other one.
//
// Empty on a database that cannot add a constraint after creation — SQLite —
// where `createTableSqlWithKeys` is the route instead.
export function foreignKeys(db: Db, repo: DbRepository): string[] {
  let out: string[] = [];
  if (!db.canAddForeignKey || !repositoryValid(repo)) { return out; }
  let i: int = 0;
  while (i < repo.relations.length) {
    let rel = repo.relations[i];
    if (rel.kind == "one" && relationValid(rel)) {
      out.push("ALTER TABLE " + repo.table + " ADD CONSTRAINT "
        + foreignKeyName(repo, rel) + " FOREIGN KEY (" + rel.localColumn
        + ") REFERENCES " + rel.table + " (" + rel.foreignColumn + ")");
    }
    i = i + 1;
  }
  return out;
}

// The constraint's name, derived so that re-running a migration against a
// database that already has it fails on the name rather than adding a second.
export function foreignKeyName(repo: DbRepository, rel: DbRelation): string {
  return "fk_" + repo.table + "_" + rel.localColumn;
}

export function createTable(db: Db, repo: DbRepository): DbResult {
  let sql = createTableSql(db, repo);
  if (sql == "") { return dbErr("invalid mapping for " + repo.table); }
  return execute(db, sql);
}

export function dropTable(db: Db, repo: DbRepository): DbResult {
  if (!safeIdentifier(repo.table)) { return dbErr("unsafe table name"); }
  return execute(db, "DROP TABLE IF EXISTS " + repo.table);
}

// --- writing ------------------------------------------------------------------------------

// Insert or replace one record, given its JSON. The document's keys are the
// mapping's field names; the database reads them with json_to_record under the
// declared types and writes them to the declared columns.
export function persist(db: Db, repo: DbRepository, json: string): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (json == "") { return dbErr("refusing to persist an empty document"); }
  let sql = "INSERT INTO " + repo.table + " (" + columnList(repo) + ") "
    + readOne(db, repo) + upsertClause(db, repo);
  if (!db.query(sql, [json])) {
    return dbErr(lastError(db, "could not persist into " + repo.table));
  }
  return dbOk(1);
}

// Insert or replace many, in one statement: the document is a JSON array, read
// with json_to_recordset.
export function persistMany(db: Db, repo: DbRepository, jsonArray: string): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (jsonArray == "" || jsonArray == "[]") { return dbOk(0); }
  let sql = "INSERT INTO " + repo.table + " (" + columnList(repo) + ") "
    + readMany(db, repo) + upsertClause(db, repo);
  if (!db.query(sql, [jsonArray])) {
    return dbErr(lastError(db, "could not persist into " + repo.table));
  }
  return dbOk(1);
}

export function deleteById(db: Db, repo: DbRepository, id: string): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (!db.query("DELETE FROM " + repo.table + " WHERE " + repo.idColumn + " = " + db.placeholder, [id])) {
    return dbErr(lastError(db, "could not delete from " + repo.table));
  }
  return dbOk(1);
}

export function deleteWhere(db: Db, repo: DbRepository, where: string, args: string[]): DbResult {
  if (!repositoryValid(repo)) { return dbErr("invalid mapping for " + repo.table); }
  if (!db.query("DELETE FROM " + repo.table + " WHERE " + where, args)) {
    return dbErr(lastError(db, "could not delete from " + repo.table));
  }
  return dbOk(1);
}

// --- reading --------------------------------------------------------------------------------

// One record as JSON, or "" when absent. Hand the result to JSON.parse<T>: the
// keys are the mapping's field names, so the compiler checks the shape.
export function findById(db: Db, repo: DbRepository, id: string): string {
  if (!repositoryValid(repo)) { return ""; }
  let sql = oneSql(db, repo, repo.idColumn + " = " + db.placeholder);
  if (sql == "") { return ""; }
  if (!db.query(sql, [id])) { return ""; }
  if (db.rows() == 0) { return ""; }
  return db.value(0, 0);
}

// The same, projected: `columns` is a select list you write, so a DTO is a
// query rather than a generated mapper. Aliases rename — `max_steps AS
// "maxSteps"` is what MapStruct spells with an annotation.
export function findProjected(db: Db, repo: DbRepository, columns: string, id: string): string {
  if (!safeIdentifier(repo.table) || !safeIdentifier(repo.idColumn)) { return ""; }
  if (!projectionValid(columns)) { return ""; }
  let sql = projectedSql(db, repo, columns, repo.idColumn + " = " + db.placeholder);
  if (sql == "") { return ""; }
  if (!db.query(sql, [id])) { return ""; }
  if (db.rows() == 0) { return ""; }
  return db.value(0, 0);
}

// The rows of a document-per-row query as one JSON array, in the order the
// database returned them.
function rowsAsArray(db: Db): string {
  let count = db.rows();
  if (count == 0) { return "[]"; }
  let out = "[";
  let i: int = 0;
  while (i < count) {
    if (i > 0) { out = out + ","; }
    out = out + db.value(i, 0);
    i = i + 1;
  }
  return out + "]";
}

// Every record as a JSON array. `where` is a fragment carrying one marker per
// value in `args`, or "" with no args for all rows.
export function listWhere(db: Db, repo: DbRepository, where: string, args: string[]): string {
  if (!repositoryValid(repo)) { return "[]"; }
  let sql = listSql(db, repo, where, "");
  if (sql == "") { return "[]"; }
  if (!db.query(sql, args)) { return "[]"; }
  return rowsAsArray(db);
}

// A projected list, for DTOs.
export function listProjected(db: Db, repo: DbRepository, columns: string, where: string, args: string[]): string {
  if (!safeIdentifier(repo.table)) { return "[]"; }
  if (!projectionValid(columns)) { return "[]"; }
  let sql = "";
  if (db.docStyle == "pairs") {
    // The caller's aliases name the keys; the expressions stay as written.
    let pairs = pairsFromColumns(columns);
    if (pairs == "") { return "[]"; }
    sql = "SELECT coalesce(" + db.jsonAgg + "(" + db.rowToJson + "("
      + pairs + ")), '[]') FROM " + repo.table;
    if (where != "") { sql = sql + " WHERE " + where; }
  } else {
    let inner = "SELECT " + columns + " FROM " + repo.table;
    if (where != "") { inner = inner + " WHERE " + where; }
    sql = "SELECT coalesce(" + db.jsonAgg + "(r), '[]'::json) FROM (" + inner + ") r";
  }
  if (!db.query(sql, args)) { return "[]"; }
  return rowsAsArray(db);
}

// --- ordering ----------------------------------------------------------------
//
// A sort key is a column and a direction, and a list of them is an ORDER BY.
// `asc` and `desc` are what every SQL builder calls these, so they are what
// these are called.
//
//   listOrdered(db, agents, "", [], [desc("max_steps"), asc("agent_name")])
//
// A column name cannot be bound as a parameter — SQL has no placeholder for
// one — so it is checked rather than trusted, and a key that is not a plain
// name refuses the whole query.

export type DbOrder = {
  column: string,
  descending: bool,
};

export function asc(column: string): DbOrder {
  let o: DbOrder = { column: column, descending: false };
  return o;
}

export function desc(column: string): DbOrder {
  let o: DbOrder = { column: column, descending: true };
  return o;
}

// `ORDER BY a DESC, b`, or an empty string when there is nothing to order by.
// Returns "!" for a key that is not a plain identifier, which the callers
// treat as a refusal — distinguishing "no ordering asked for" from "an
// ordering I will not send".
export function orderClause(keys: DbOrder[]): string {
  if (keys.length == 0) { return ""; }
  let out = "";
  let i: int = 0;
  while (i < keys.length) {
    if (!safeIdentifier(keys[i].column)) { return "!"; }
    if (i > 0) { out = out + ", "; }
    out = out + keys[i].column;
    if (keys[i].descending) { out = out + " DESC"; }
    i = i + 1;
  }
  return " ORDER BY " + out;
}

// A list in an order you name. `listWhere` is this with no keys.
export function listOrdered(db: Db, repo: DbRepository, where: string, args: string[], keys: DbOrder[]): string {
  if (!repositoryValid(repo)) { return "[]"; }
  let order = orderClause(keys);
  if (order == "!") { return "[]"; }
  let sql = listSql(db, repo, where, order);
  if (sql == "") { return "[]"; }
  if (!db.query(sql, args)) { return "[]"; }
  return rowsAsArray(db);
}

// A page in an order you name, over several keys rather than one column.
export function pageOrdered(db: Db, repo: DbRepository, where: string, args: string[], keys: DbOrder[], limit: int, offset: int): string {
  if (!repositoryValid(repo)) { return "[]"; }
  let order = orderClause(keys);
  if (order == "!") { return "[]"; }
  // A page without an order is a page in whatever order the database felt
  // like, which is not a page at all — two requests can overlap or skip rows.
  if (order == "") { return "[]"; }
  let sql = listSql(db, repo, where, order + " LIMIT " + `${limit}` + " OFFSET " + `${offset}`);
  if (sql == "") { return "[]"; }
  if (!db.query(sql, args)) { return "[]"; }
  return rowsAsArray(db);
}

// A page, ordered by a column you name.
export function pageWhere(db: Db, repo: DbRepository, where: string, args: string[], orderBy: string, limit: int, offset: int): string {
  if (!repositoryValid(repo) || !safeIdentifier(orderBy)) { return "[]"; }
  let sql = listSql(db, repo, where, " ORDER BY " + orderBy + " LIMIT " + `${limit}` + " OFFSET " + `${offset}`);
  if (sql == "") { return "[]"; }
  if (!db.query(sql, args)) { return "[]"; }
  return rowsAsArray(db);
}

export function countWhere(db: Db, repo: DbRepository, where: string, args: string[]): int {
  if (!safeIdentifier(repo.table)) { return -1; }
  let sql = "SELECT count(*) FROM " + repo.table;
  if (where != "") { sql = sql + " WHERE " + where; }
  if (!db.query(sql, args)) { return -1; }
  if (db.rows() == 0) { return 0; }
  return parseInt(db.value(0, 0)) ?? 0;
}

export function existsById(db: Db, repo: DbRepository, id: string): bool {
  if (!repositoryValid(repo)) { return false; }
  if (!db.query("SELECT 1 FROM " + repo.table + " WHERE " + repo.idColumn + " = " + db.placeholder, [id])) {
    return false;
  }
  return db.rows() > 0;
}

// --- transactions --------------------------------------------------------------------------------

// Explicit, not a block that takes a closure: a closure here cannot call a
// function it was handed, so `withTransaction(body)` cannot be written.
export function beginTransaction(db: Db): DbResult {
  return execute(db, "BEGIN");
}

export function commitTransaction(db: Db): DbResult {
  return execute(db, "COMMIT");
}

export function rollbackTransaction(db: Db): DbResult {
  return execute(db, "ROLLBACK");
}

// --- migrations -----------------------------------------------------------------------------------

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

// pgvector -- a persistent vector store, on PostgreSQL with the pgvector
// extension, reached through the C FFI.
//
// The `ai` package's built-in store is a slice held in memory: it is rebuilt on
// every start, so a service re-embeds its whole corpus each time it boots and
// pays a provider for text that has not changed. This one keeps the vectors in
// a table, so an index survives a restart and grows a document at a time.
//
// It also searches properly. The in-memory store scans every vector on every
// query; pgvector answers with an index, and the distance operators run in the
// database rather than in the program.
//
// Every value crossing into SQL is sent as a bound parameter, never pasted into
// statement text, so a document that contains a quote is data rather than
// syntax.
//
// Dependencies:
//   apt install postgresql-17 postgresql-17-pgvector libpq-dev   # Debian, Ubuntu
//   brew install postgresql@17 pgvector                          # macOS
//   sh packages/pgvector/build.sh
//
// @link ./pgvector_shim.o
// @link pq
// @link c
declare function pgv_connect(conninfo: string): int;
declare function pgv_connected(): int;
declare function pgv_exec(sql: string): int;
declare function pgv_query0(sql: string): int;
declare function pgv_query1(sql: string, a: string): int;
declare function pgv_query2(sql: string, a: string, b: string): int;
declare function pgv_query3(sql: string, a: string, b: string, c: string): int;
declare function pgv_query4(sql: string, a: string, b: string, c: string, d: string): int;
declare function pgv_query5(sql: string, a: string, b: string, c: string, d: string, e: string): int;
declare function pgv_rows(): int;
declare function pgv_cols(): int;
declare function pgv_value(row: int, col: int): string;
declare function pgv_error(): string;
declare function pgv_version(): string;
declare function pgv_close(): void;

// A stored chunk and how far it sits from the query. `distance` is what the
// database returned, so smaller is nearer; `score` is the cosine similarity
// that reads the familiar way, larger being better.
export type PgHit = {
  id: string,
  text: string,
  source: string,
  metadata: string,
  distance: number,
  score: number,
};

// The outcome of a call that changes something. `ok` false puts the database's
// own message in `error` rather than a message this package invented.
export type PgResult = {
  ok: bool,
  rows: int,
  error: string,
};

function pgOk(rows: int): PgResult {
  let r: PgResult = { ok: true, rows: rows, error: "" };
  return r;
}

function pgErr(message: string): PgResult {
  let r: PgResult = { ok: false, rows: 0, error: message };
  return r;
}

function lastError(fallback: string): string {
  let e = pgv_error();
  if (e == "") { return fallback; }
  return e;
}

// --- connection --------------------------------------------------------------

// Connect with a libpq conninfo string:
//   "host=127.0.0.1 port=5432 user=lumen password=lumen dbname=lumenvec"
export function pgConnect(conninfo: string): PgResult {
  if (pgv_connect(conninfo) != 0) {
    return pgErr(lastError("could not connect"));
  }
  return pgOk(0);
}

export function pgConnected(): bool {
  return pgv_connected() == 1;
}

export function pgClose(): void {
  pgv_close();
}

// The server's version as libpq reports it (110000 is 11.0, 170007 is 17.7).
export function pgServerVersion(): int {
  return parseInt(pgv_version()) ?? 0;
}

// --- schema ------------------------------------------------------------------

// Create the extension and the table if they are absent.
//
// `dims` must match the embedding model: mistral-embed is 1024,
// text-embedding-3-small is 1536. pgvector fixes the width at the column, so a
// table built for one model cannot hold another's vectors — which is a feature,
// since mixing them silently would make every distance meaningless.
export function pgCreateStore(table: string, dims: int): PgResult {
  if (pgv_exec("CREATE EXTENSION IF NOT EXISTS vector") != 0) {
    return pgErr(lastError("could not create the vector extension"));
  }
  // The table name cannot be a bound parameter — SQL has no placeholder for an
  // identifier — so it is checked rather than trusted.
  if (!pgSafeIdentifier(table)) {
    return pgErr("unsafe table name: " + table);
  }
  let sql = "CREATE TABLE IF NOT EXISTS " + table + " ("
    + "id text PRIMARY KEY, "
    + "text text NOT NULL, "
    + "source text NOT NULL DEFAULT '', "
    + "metadata text NOT NULL DEFAULT '', "
    + "embedding vector(" + `${dims}` + ") NOT NULL)";
  if (pgv_exec(sql) != 0) {
    return pgErr(lastError("could not create the table"));
  }
  return pgOk(0);
}

// Letters, digits and underscores only, not starting with a digit. Enough for a
// table name and small enough to reason about.
export function pgSafeIdentifier(name: string): bool {
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

// Build an ivfflat index for cosine distance. Worth doing once a table holds
// enough rows that a scan is slow; below a few thousand, a scan is faster than
// an index and this can be skipped.
export function pgCreateIndex(table: string, lists: int): PgResult {
  if (!pgSafeIdentifier(table)) { return pgErr("unsafe table name: " + table); }
  let sql = "CREATE INDEX IF NOT EXISTS " + table + "_embedding_idx ON " + table
    + " USING ivfflat (embedding vector_cosine_ops) WITH (lists = " + `${lists}` + ")";
  if (pgv_exec(sql) != 0) {
    return pgErr(lastError("could not create the index"));
  }
  return pgOk(0);
}

export function pgDropStore(table: string): PgResult {
  if (!pgSafeIdentifier(table)) { return pgErr("unsafe table name: " + table); }
  if (pgv_exec("DROP TABLE IF EXISTS " + table) != 0) {
    return pgErr(lastError("could not drop the table"));
  }
  return pgOk(0);
}

// --- vectors ------------------------------------------------------------------

// pgvector's text form: "[0.1,0.2,0.3]".
export function pgVectorLiteral(v: number[]): string {
  let out = "[";
  let i: int = 0;
  while (i < v.length) {
    if (i > 0) { out = out + ","; }
    out = out + `${v[i]}`;
    i = i + 1;
  }
  return out + "]";
}

// Read pgvector's text form back into numbers.
export function pgParseVector(s: string): number[] {
  let out: number[] = [];
  let body = s.trim();
  if (body.length < 2) { return out; }
  body = body.slice(1, body.length - 1);
  if (body.trim().length == 0) { return out; }
  let parts = body.split(",");
  let i: int = 0;
  while (i < parts.length) {
    out = [...out, parseFloat(parts[i].trim()) ?? 0.0];
    i = i + 1;
  }
  return out;
}

// --- writing -------------------------------------------------------------------

// Insert or replace one chunk. Re-inserting the same id updates it, so
// re-indexing a changed document does not leave the old copy behind.
export function pgUpsert(table: string, id: string, text: string, source: string, metadata: string, embedding: number[]): PgResult {
  if (!pgSafeIdentifier(table)) { return pgErr("unsafe table name: " + table); }
  if (embedding.length == 0) { return pgErr("refusing to store an empty embedding for " + id); }
  let sql = "INSERT INTO " + table + " (id, text, source, metadata, embedding) VALUES ($1, $2, $3, $4, $5) "
    + "ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, source = EXCLUDED.source, "
    + "metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding";
  if (pgv_query5(sql, id, text, source, metadata, pgVectorLiteral(embedding)) < 0) {
    return pgErr(lastError("could not store " + id));
  }
  return pgOk(1);
}

export function pgDeleteById(table: string, id: string): PgResult {
  if (!pgSafeIdentifier(table)) { return pgErr("unsafe table name: " + table); }
  if (pgv_query1("DELETE FROM " + table + " WHERE id = $1", id) < 0) {
    return pgErr(lastError("could not delete " + id));
  }
  return pgOk(1);
}

export function pgDeleteBySource(table: string, source: string): PgResult {
  if (!pgSafeIdentifier(table)) { return pgErr("unsafe table name: " + table); }
  if (pgv_query1("DELETE FROM " + table + " WHERE source = $1", source) < 0) {
    return pgErr(lastError("could not delete documents from " + source));
  }
  return pgOk(1);
}

// How many chunks the table holds.
export function pgCount(table: string): int {
  if (!pgSafeIdentifier(table)) { return -1; }
  if (pgv_query0("SELECT count(*) FROM " + table) < 0) { return -1; }
  if (pgv_rows() == 0) { return 0; }
  return parseInt(pgv_value(0, 0)) ?? 0;
}

// Whether a chunk with this id is already stored — the check that lets an
// indexer skip re-embedding text it has seen.
export function pgHas(table: string, id: string): bool {
  if (!pgSafeIdentifier(table)) { return false; }
  if (pgv_query1("SELECT 1 FROM " + table + " WHERE id = $1", id) < 0) { return false; }
  return pgv_rows() > 0;
}

// --- searching -------------------------------------------------------------------

function readHits(): PgHit[] {
  let out: PgHit[] = [];
  let n = pgv_rows();
  let i: int = 0;
  while (i < n) {
    let d = parseFloat(pgv_value(i, 4)) ?? 0.0;
    let hit: PgHit = {
      id: pgv_value(i, 0),
      text: pgv_value(i, 1),
      source: pgv_value(i, 2),
      metadata: pgv_value(i, 3),
      distance: d,
      // pgvector's `<=>` is cosine distance, which is 1 - similarity.
      score: 1.0 - d,
    };
    out = [...out, hit];
    i = i + 1;
  }
  return out;
}

// The `k` nearest chunks to a query vector, by cosine distance.
export function pgSearch(table: string, query: number[], k: int): PgHit[] {
  let none: PgHit[] = [];
  if (!pgSafeIdentifier(table)) { return none; }
  if (query.length == 0 || k <= 0) { return none; }
  let sql = "SELECT id, text, source, metadata, embedding <=> $1 AS distance FROM " + table
    + " ORDER BY embedding <=> $1 LIMIT " + `${k}`;
  if (pgv_query1(sql, pgVectorLiteral(query)) < 0) { return none; }
  return readHits();
}

// The same search, restricted to one source document.
export function pgSearchInSource(table: string, query: number[], source: string, k: int): PgHit[] {
  let none: PgHit[] = [];
  if (!pgSafeIdentifier(table)) { return none; }
  if (query.length == 0 || k <= 0) { return none; }
  let sql = "SELECT id, text, source, metadata, embedding <=> $1 AS distance FROM " + table
    + " WHERE source = $2 ORDER BY embedding <=> $1 LIMIT " + `${k}`;
  if (pgv_query2(sql, pgVectorLiteral(query), source) < 0) { return none; }
  return readHits();
}

// Nearest chunks no further than `maxDistance`. Use this when "nothing matched"
// must be an answer: a plain top-k always returns k rows, however unrelated
// they are.
export function pgSearchWithin(table: string, query: number[], k: int, maxDistance: number): PgHit[] {
  let none: PgHit[] = [];
  if (!pgSafeIdentifier(table)) { return none; }
  if (query.length == 0 || k <= 0) { return none; }
  let sql = "SELECT id, text, source, metadata, embedding <=> $1 AS distance FROM " + table
    + " WHERE embedding <=> $1 <= " + `${maxDistance}` + " ORDER BY embedding <=> $1 LIMIT " + `${k}`;
  if (pgv_query1(sql, pgVectorLiteral(query)) < 0) { return none; }
  return readHits();
}

// One stored chunk by id, or a hit with an empty id when it is absent.
export function pgGet(table: string, id: string): PgHit {
  let miss: PgHit = { id: "", text: "", source: "", metadata: "", distance: 0.0, score: 0.0 };
  if (!pgSafeIdentifier(table)) { return miss; }
  if (pgv_query1("SELECT id, text, source, metadata, 0.0 FROM " + table + " WHERE id = $1", id) < 0) {
    return miss;
  }
  let hits = readHits();
  if (hits.length == 0) { return miss; }
  return hits[0];
}

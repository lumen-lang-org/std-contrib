// Retrieval: the documents an agent may draw on, and finding the ones a
// question is about.
//
//   indexDocument(db, embedModel, "d1", "agents", "Plume maps records to tables.", key);
//   let found = retrieve(db, embedModel, "How do I map a record?", 3, key);
//
// PostgreSQL only. Similarity search here is pgvector's `<=>` operator, and
// SQLite and MySQL have no vector type — an agent can run anywhere, but it can
// only retrieve against Postgres.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, field, repository, execute, executeWith, placeholderAt, safeIdentifier } from "../plume/plume.ts";
import { ModelRow } from "./schema.ts";
import { Embedding, embedText } from "./provider.ts";

// A chunk of text an agent can be given. `source` groups chunks that came from
// one place, so a corpus can be replaced without touching the rest.
export type DocumentRow = {
  id: string,
  source: string,
  body: string,
};

export type Retrieved = {
  id: string,
  source: string,
  body: string,
  // Cosine distance: 0 is identical, 2 is opposite. Returned so a caller can
  // decide what is too far rather than trusting the ranking blindly.
  distance: number,
};

export type Retrieval = {
  ok: bool,
  found: Retrieved[],
  error: string,
};

export function documentsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("source", "source", "text"),
    field("body", "body", "text"),
  ];
  return repository("documents", "id", "id", fs);
}

// The table, with a vector column of the width the embedding model produces.
// The width is fixed at creation, so a corpus embedded by one model cannot be
// searched by another — which is a property of the vectors, not a limitation
// here, and is worth failing on rather than silently mixing.
export function createDocuments(db: Db, dimensions: int): string {
  if (dimensions <= 0) { return "an embedding width is required"; }
  let made = execute(db, "CREATE TABLE IF NOT EXISTS documents ("
    + "id " + db.textType + " PRIMARY KEY, "
    + "source " + db.textType + " NOT NULL, "
    + "body " + db.textType + " NOT NULL, "
    + "embedding vector(" + `${dimensions}` + "))");
  if (!made.ok) { return made.error; }
  return "";
}

// Embed a chunk and store it. Replaces the row if the id is already there, so
// re-indexing a corpus is idempotent.
export function indexDocument(db: Db, model: ModelRow, id: string, source: string, body: string, apiKey: string): string {
  if (!safeIdentifier(id)) { return "a document id must be a plain name"; }
  let vector = embedText(model, body, apiKey);
  if (!vector.ok) { return vector.error; }
  executeWith(db, "DELETE FROM documents WHERE id = " + placeholderAt(db, 1), [id]);
  let written = executeWith(db,
    "INSERT INTO documents (id, source, body, embedding) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", "
    + placeholderAt(db, 3) + ", " + placeholderAt(db, 4) + ")",
    [id, source, body, vector.vector]);
  if (!written.ok) { return written.error; }
  return "";
}

// The `k` chunks closest to a question.
//
// The vector is bound, not interpolated: it comes from a provider's reply and
// is data like any other. `k` is checked rather than bound because a LIMIT
// cannot take a parameter on every driver.
export function retrieve(db: Db, model: ModelRow, question: string, k: int, apiKey: string): Retrieval {
  let none: Retrieved[] = [];
  if (k <= 0 || k > 100) {
    let bad: Retrieval = { ok: false, found: none, error: "k must be between 1 and 100" };
    return bad;
  }
  let vector = embedText(model, question, apiKey);
  if (!vector.ok) {
    let failed: Retrieval = { ok: false, found: none, error: vector.error };
    return failed;
  }
  // Numbered, not repeated: on PostgreSQL `$1` twice declares one parameter,
  // and binding two to it is an error rather than a convenience.
  let sql = "SELECT id, source, body, (embedding <=> " + placeholderAt(db, 1) + ") AS distance"
    + " FROM documents ORDER BY embedding <=> " + placeholderAt(db, 2) + " LIMIT " + `${k}`;
  if (!db.query(sql, [vector.vector, vector.vector])) {
    let refused: Retrieval = { ok: false, found: none, error: "the search was refused: " + db.lastError() };
    return refused;
  }
  let found: Retrieved[] = [];
  let i: int = 0;
  while (i < db.rows()) {
    let r: Retrieved = {
      id: db.value(i, 0),
      source: db.value(i, 1),
      body: db.value(i, 2),
      distance: parseFloat(db.value(i, 3)) ?? 2.0,
    };
    found.push(r);
    i = i + 1;
  }
  let out: Retrieval = { ok: true, found: found, error: "" };
  return out;
}

// Retrieved chunks as text to put in front of a question. Each is labelled
// with where it came from, so a model can attribute and a reader can check.
export function asContext(found: Retrieved[]): string {
  if (found.length == 0) { return ""; }
  let out = "Use only the following context. If it does not answer the question, say so.\n";
  let i: int = 0;
  while (i < found.length) {
    out = out + "\n[" + found[i].source + "/" + found[i].id + "]\n" + found[i].body + "\n";
    i = i + 1;
  }
  return out;
}

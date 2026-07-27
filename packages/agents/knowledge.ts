// Retrieval: the documents an agent may draw on, and finding the ones a
// question is about.
//
//   indexDocument(db, embedModel, { id: "d1", source: "agents", scope: "/specs",
//                                    body: "Plume maps records to tables." }, key);
//   let found = retrieve(db, embedModel, "How do I map a record?", 3, key);
//
// PostgreSQL only. Similarity search here is pgvector's `<=>` operator, and
// SQLite and MySQL have no vector type — an agent can run anywhere, but it can
// only retrieve against Postgres.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, field, repository, execute, executeWith, findById, placeholderAt, safeIdentifier, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { ModelRow, modelsMapping } from "./schema.ts";
import { Embedding, embedText } from "./provider.ts";

// A chunk of text an agent can be given. `source` groups chunks that came from
// one place, so a corpus can be replaced without touching the rest.
//
// `modelId` records which embedding model produced the vector. Two models'
// vectors are not comparable even at the same width, and a search that mixed
// them would return confident nonsense rather than an error.
export type DocumentRow = {
  id: string,
  // Where this chunk came from — a filename, a URL, a ticket. Provenance, so a
  // reader can check an answer.
  source: string,
  // The folder it lives in, as a path: "/specs/plume". What an agent is
  // granted, and therefore what decides who may read it.
  scope: string,
  body: string,
  modelId: string,
};

// The embedding model a corpus was built with, read from its own row.
//
// Refuses a chat model: a provider offers both and they answer different
// endpoints, so pointing a corpus at the wrong one should fail here rather
// than at the provider.
export function embeddingModel(db: Db, modelId: string): ModelRow {
  let absent: ModelRow = { id: "", label: "", apiName: "", provider: "", kind: "", dimensions: 0, baseUrl: "", enabled: false };
  let document = findById(db, modelsMapping(), modelId);
  if (document == "") { return absent; }
  let model: ModelRow = JSON.parse<ModelRow>(document);
  if (model.kind != "embedding") { return absent; }
  return model;
}

export type Retrieved = {
  id: string,
  source: string,
  // Which folder it came from, so a wrong answer can be traced to the shelf it
  // was taken off.
  scope: string,
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
    field("scope", "scope", "text"),
    field("body", "body", "text"),
  ];
  return repository("documents", "id", "id", fs);
}

// The table, with a vector column of the width the embedding model produces.
// The width is fixed at creation, so a corpus embedded by one model cannot be
// searched by another — which is a property of the vectors, not a limitation
// here, and is worth failing on rather than silently mixing.
export function createDocuments(db: Db, model: ModelRow): string {
  if (model.id == "") { return "no embedding model"; }
  if (model.dimensions <= 0) {
    return model.label + " does not say how wide its vectors are";
  }
  let dimensions = model.dimensions;
  let made = execute(db, "CREATE TABLE IF NOT EXISTS documents ("
    + "id " + db.textType + " PRIMARY KEY, "
    + "source " + db.textType + " NOT NULL, "
    + "scope " + db.textType + " NOT NULL, "
    + "body " + db.textType + " NOT NULL, "
    + "model_id " + db.textType + " NOT NULL, "
    + "embedding vector(" + `${dimensions}` + "))");
  if (!made.ok) { return made.error; }
  return "";
}

// Embed a chunk and store it. Replaces the row if the id is already there, so
// re-indexing a corpus is idempotent.
// One document to index.
//
// `id` and `source` were adjacent strings, both plain names, and at the only
// non-example call site one is derived from the other — so the two read as
// interchangeable. Swapped, every chunk of a document gets the same id, each
// one deleting and rewriting the last, and a ten-chunk document indexes as a
// single row. Both pass safeIdentifier, the insert succeeds, and retrieval
// just quietly returns one passage.
export type DocumentChunk = {
  id: string,
  source: string,
  scope: string,
  body: string,
};

export function indexDocument(db: Db, model: ModelRow, chunk: DocumentChunk, apiKey: string): string {
  let id = chunk.id;
  let source = chunk.source;
  let scope = chunk.scope;
  let body = chunk.body;
  if (!safeIdentifier(id)) { return "a document id must be a plain name"; }
  if (model.kind != "embedding") { return model.label + " is not an embedding model"; }
  let vector = embedText(model, body, apiKey);
  if (!vector.ok) { return vector.error; }
  // What the model said it produces and what it produced must agree, or the
  // column is the wrong width and the insert fails with a wire error instead
  // of this sentence.
  if (vector.dimensions != model.dimensions) {
    return model.label + " says " + `${model.dimensions}` + " dimensions and returned " + `${vector.dimensions}`;
  }
  executeWith(db, "DELETE FROM documents WHERE id = " + placeholderAt(db, 1), [id]);
  let written = executeWith(db,
    "INSERT INTO documents (id, source, scope, body, model_id, embedding) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", "
    + placeholderAt(db, 3) + ", " + placeholderAt(db, 4) + ", "
    + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ")",
    [id, source, normalScope(scope), body, model.id, vector.vector]);
  if (!written.ok) { return written.error; }
  return "";
}

// --- scopes ------------------------------------------------------------------------

// A path in the one form everything else compares against: a leading slash,
// no trailing one, "/" for the root.
//
// Normalised once at the edge rather than everywhere it is read. Two spellings
// of the same folder are the kind of difference that silently grants nothing.
export function normalScope(scope: string): string {
  let out = scope.trim();
  while (out.endsWith("/")) { out = out.slice(0, out.length - 1); }
  if (out == "") { return "/"; }
  if (!out.startsWith("/")) { out = "/" + out; }
  return out;
}

// Whether a granted scope covers a document's.
//
// On segment boundaries, not on characters: "/foo" covers "/foo" and
// "/foo/bar" and must not cover "/foobar". A plain string prefix would leak
// every folder whose name merely starts the same way, which is the whole thing
// scopes exist to prevent.
export function scopeCovers(granted: string, path: string): bool {
  let g = normalScope(granted);
  let p = normalScope(path);
  if (g == "/") { return true; }
  if (p == g) { return true; }
  return p.startsWith(g + "/");
}

// The SQL for "in any of these scopes", and the values it binds.
//
// Two parameters per scope — the exact path and the path plus "/%" — rather
// than a LIKE built by concatenation in SQL, because `||` is not spelled the
// same on every driver and a scope is user input either way.
export function scopeClause(db: Db, scopes: string[], from: int): string {
  if (scopes.length == 0) { return ""; }
  let out = "(";
  let i: int = 0;
  while (i < scopes.length) {
    if (i > 0) { out = out + " OR "; }
    out = out + "scope = " + placeholderAt(db, from + i * 2)
      + " OR scope LIKE " + placeholderAt(db, from + i * 2 + 1);
    i = i + 1;
  }
  return out + ")";
}

export function scopeArgs(scopes: string[]): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < scopes.length) {
    let s = normalScope(scopes[i]);
    out.push(s);
    if (s == "/") { out.push("/%"); } else { out.push(s + "/%"); }
    i = i + 1;
  }
  return out;
}

// The `k` chunks closest to a question.
//
// The vector is bound, not interpolated: it comes from a provider's reply and
// is data like any other. `k` is checked rather than bound because a LIMIT
// cannot take a parameter on every driver.
export function retrieve(db: Db, model: ModelRow, scopes: string[], question: string, k: int, apiKey: string): Retrieval {
  let none: string[] = [];
  return retrieveExcluding(db, model, scopes, none, question, k, apiKey);
}

// The same search, skipping chunks a caller already holds.
//
// In the query rather than filtered after: dropping duplicates from the top k
// silently shrinks k, and a thread on its third question about one topic would
// retrieve nothing new without being told why.
export function retrieveExcluding(db: Db, model: ModelRow, scopes: string[], excludeIds: string[], question: string, k: int, apiKey: string): Retrieval {
  let none: Retrieved[] = [];
  if (k <= 0 || k > 100) {
    let bad: Retrieval = { ok: false, found: none, error: "k must be between 1 and 100" };
    return bad;
  }
  if (model.kind != "embedding") {
    let wrong: Retrieval = { ok: false, found: none, error: model.label + " is not an embedding model" };
    return wrong;
  }
  // No scopes is not "everything". An agent that has been granted nothing can
  // read nothing, and the alternative — treating an empty list as a wildcard —
  // makes revoking access the most dangerous edit in the system.
  if (scopes.length == 0) {
    let ungranted: Retrieval = { ok: false, found: none, error: "no scopes granted, so nothing is readable" };
    return ungranted;
  }
  let vector = embedText(model, question, apiKey);
  if (!vector.ok) {
    let failed: Retrieval = { ok: false, found: none, error: vector.error };
    return failed;
  }
  // Numbered, not repeated: on PostgreSQL `$1` twice declares one parameter,
  // and binding two to it is an error rather than a convenience.
  // Only chunks this model embedded. Another model's vectors sit in the same
  // column at the same width and are not comparable; leaving them in would
  // return confident nonsense.
  //
  // And only chunks in a scope this caller was granted. Without that clause a
  // second agent sharing an embedding model reads the first one's documents,
  // which is not a ranking problem but a disclosure.
  let where = scopeClause(db, scopes, 3);
  // The exclusions bind after the scopes; the ordering vector binds last.
  let at = 3 + scopes.length * 2;
  let notIn = "";
  if (excludeIds.length > 0) {
    notIn = " AND id NOT IN (";
    let x: int = 0;
    while (x < excludeIds.length) {
      if (x > 0) { notIn = notIn + ", "; }
      notIn = notIn + placeholderAt(db, at + x);
      x = x + 1;
    }
    notIn = notIn + ")";
    at = at + excludeIds.length;
  }
  let sql = "SELECT id, source, scope, body, (embedding <=> " + placeholderAt(db, 1) + ") AS distance"
    + " FROM documents WHERE model_id = " + placeholderAt(db, 2)
    + " AND " + where + notIn
    + " ORDER BY embedding <=> " + placeholderAt(db, at) + " LIMIT " + `${k}`;
  let args: string[] = [vector.vector, model.id];
  let bound = scopeArgs(scopes);
  let b: int = 0;
  while (b < bound.length) { args.push(bound[b]); b = b + 1; }
  let e: int = 0;
  while (e < excludeIds.length) { args.push(excludeIds[e]); e = e + 1; }
  args.push(vector.vector);
  if (!db.query(sql, args)) {
    let refused: Retrieval = { ok: false, found: none, error: "the search was refused: " + db.lastError() };
    return refused;
  }
  let found: Retrieved[] = [];
  let i: int = 0;
  while (i < db.rows()) {
    let r: Retrieved = {
      id: db.value(i, 0),
      source: db.value(i, 1),
      scope: db.value(i, 2),
      body: db.value(i, 3),
      distance: parseFloat(db.value(i, 4)) ?? 2.0,
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

// --- uploading a document -------------------------------------------------------------

// How large a chunk may get before it is split. Retrieval returns whole chunks,
// so this is the size of the smallest thing an answer can cite: too large and a
// passage buries its point, too small and it loses the context that made it
// mean anything.
const CHUNK_CHARS: int = 1000;

export type Upload = {
  ok: bool,
  chunks: int,
  error: string,
};

// A document split into chunks on paragraph boundaries.
//
// Paragraphs because a paragraph is the smallest unit that still reads as
// itself; a fixed-width cut lands mid-sentence and retrieves half a thought.
// A paragraph longer than the cap is split by size, because refusing it would
// mean a document with one long section cannot be uploaded at all.
export function splitIntoChunks(body: string, maxChars: int): string[] {
  let out: string[] = [];
  let current = "";
  let rest = body;

  while (rest.length > 0) {
    let at = rest.indexOf("\n\n");
    let para = rest;
    if (at >= 0) { para = rest.slice(0, at); rest = rest.slice(at + 2, rest.length); }
    else { rest = ""; }
    if (para.trim() == "") { continue; }

    // A paragraph that will not fit on its own is cut by size.
    while (para.length > maxChars) {
      if (current != "") { out.push(current); current = ""; }
      out.push(para.slice(0, maxChars));
      para = para.slice(maxChars, para.length);
    }
    if (current == "") { current = para; }
    else if (current.length + para.length + 2 <= maxChars) { current = current + "\n\n" + para; }
    else { out.push(current); current = para; }
  }
  if (current.trim() != "") { out.push(current); }
  return out;
}

// Store a document: split it, embed each chunk, and file them all under one
// scope and source.
//
// Every chunk of a source is removed first. An edited document that left its
// old chunks behind would keep answering with text nobody can find any more,
// which is worse than not having it — the reader checks the source, finds it
// says something else, and cannot explain the answer.
export function uploadDocument(db: Db, model: ModelRow, source: string, scope: string, body: string, apiKey: string): Upload {
  if (source == "") {
    let unnamed: Upload = { ok: false, chunks: 0, error: "a document needs a source to be filed under" };
    return unnamed;
  }
  if (body.trim() == "") {
    let empty: Upload = { ok: false, chunks: 0, error: "an empty document has nothing to retrieve" };
    return empty;
  }
  if (!safeIdentifier(source)) {
    // Chunk ids are built from the source, and an id must be a plain name.
    let odd: Upload = { ok: false, chunks: 0, error: "a source must be a plain name: letters, digits, _ and -" };
    return odd;
  }

  executeWith(db, "DELETE FROM documents WHERE source = " + placeholderAt(db, 1), [source]);

  let chunks = splitIntoChunks(body, CHUNK_CHARS);
  let written: int = 0;
  let i: int = 0;
  while (i < chunks.length) {
    let part: DocumentChunk = { id: source + "_" + `${i}`, source: source, scope: scope, body: chunks[i] };
    let problem = indexDocument(db, model, part, apiKey);
    if (problem != "") {
      // Partial on purpose: what was stored is real and retrievable, and the
      // count says how far it got. Rolling back would lose work over a
      // provider hiccup on chunk nine of ten.
      let failed: Upload = { ok: false, chunks: written, error: "chunk " + `${i}` + ": " + problem };
      return failed;
    }
    written = written + 1;
    i = i + 1;
  }
  let out: Upload = { ok: true, chunks: written, error: "" };
  return out;
}

// --- the scope tree -------------------------------------------------------------------

// One folder: how many chunks sit directly in it, and how many in it and
// everything under it.
//
// Both, because the two answer different questions. "I granted /specs and got
// nothing" is answered by `total`; "this folder looks empty" is answered by the
// difference between them.
export type ScopeNode = {
  path: string,
  documents: int,
  total: int,
};

// Every scope that has documents, with counts, deepest paths included.
//
// A flat list rather than a nested structure: the nesting is implied by the
// paths, a caller that wants a tree can build one, and a list survives being
// turned into JSON without a recursive type the language would have to declare.
// One source in a folder: its chunk count and total size. What a person
// managing a corpus thinks in — the chunking is the index's business.
export type SourceListing = {
  source: string,
  scope: string,
  chunks: int,
  bytes: int,
};

export function listSources(db: Db, scope: string): SourceListing[] {
  let out: SourceListing[] = [];
  let where = normalScope(scope);
  let sql = "SELECT source, MIN(scope), COUNT(*), SUM(LENGTH(body)) FROM documents"
    + " WHERE scope = " + db.placeholder + " GROUP BY source ORDER BY source";
  if (!db.query(sql, [where])) { return out; }
  let i: int = 0;
  while (i < db.rows()) {
    let row: SourceListing = {
      source: db.value(i, 0),
      scope: db.value(i, 1),
      chunks: parseInt(db.value(i, 2)) ?? 0,
      bytes: parseInt(db.value(i, 3)) ?? 0,
    };
    out.push(row);
    i = i + 1;
  }
  return out;
}

export function scopeCounts(db: Db, prefix: string): ScopeNode[] {
  let out: ScopeNode[] = [];
  let sql = "SELECT scope, COUNT(*) FROM documents GROUP BY scope ORDER BY scope";
  if (!db.query(sql, [])) { return out; }

  let paths: string[] = [];
  let counts: int[] = [];
  let i: int = 0;
  while (i < db.rows()) {
    paths.push(db.value(i, 0));
    counts.push(parseInt(db.value(i, 1)) ?? 0);
    i = i + 1;
  }

  // Totals include descendants, so every folder is compared with every other
  // one. A corpus has tens of folders, not thousands.
  let p: int = 0;
  while (p < paths.length) {
    if (prefix == "" || scopeCovers(prefix, paths[p])) {
      let total: int = 0;
      let q: int = 0;
      while (q < paths.length) {
        if (scopeCovers(paths[p], paths[q])) { total = total + counts[q]; }
        q = q + 1;
      }
      let node: ScopeNode = { path: paths[p], documents: counts[p], total: total };
      out.push(node);
    }
    p = p + 1;
  }
  return out;
}

// --- an agent's knowledge ---------------------------------------------------------------

// What an agent may read, and how it reads it.
//
// A separate table rather than columns on `agents`, because an agent that does
// not retrieve has no row here at all — and because adding four columns to a
// table every test constructs would make retrieval everybody's problem.
export type AgentRetrievalRow = {
  agentId: string,
  // Which model embedded the documents this agent reads. One per agent:
  // vectors from two models are not comparable, so an agent whose scopes span
  // both would be ranking noise.
  embeddingModelId: string,
  topK: int,
  // Cosine distance past which a passage is not worth showing. 2 is the
  // maximum, so a large value means "keep whatever ranked".
  maxDistance: number,
  enabled: bool,
};

export function agentRetrievalMapping(): DbRepository {
  let fs: DbField[] = [
    field("agentId", "agent_id", "text"),
    field("embeddingModelId", "embedding_model_id", "text"),
    field("topK", "top_k", "int"),
    field("maxDistance", "max_distance", "float8"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("agent_retrieval", "agentId", "agent_id", fs);
}

// The tables. Appended to the same plan as everything else.
export function knowledgePlan(db: Db): Migration[] {
  let plan: Migration[] = [
    // A link table holds two keys and no entity, so it is written by hand like
    // the others.
    migration("16", "agent scopes",
      "CREATE TABLE IF NOT EXISTS agent_scopes ("
      + "agent_id " + db.textType + " NOT NULL, "
      + "scope " + db.textType + " NOT NULL)"),
    migration("17", "agent retrieval", createTableSql(db, agentRetrievalMapping())),
    migration("18", "scopes by agent",
      "CREATE INDEX IF NOT EXISTS scopes_by_agent ON agent_scopes (agent_id)"),
  ];
  return plan;
}

// The scopes an agent has been granted, normalised.
export function agentScopes(db: Db, agentId: string): string[] {
  let out: string[] = [];
  if (!db.query("SELECT scope FROM agent_scopes WHERE agent_id = " + placeholderAt(db, 1)
                + " ORDER BY scope", [agentId])) {
    return out;
  }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(normalScope(db.value(i, 0)));
    i = i + 1;
  }
  return out;
}

// Grant a scope. Idempotent: granting twice is not an error and does not
// duplicate the row, because a grant is a fact rather than an event.
export function grantScope(db: Db, agentId: string, scope: string): string {
  let path = normalScope(scope);
  let already = agentScopes(db, agentId);
  let i: int = 0;
  while (i < already.length) {
    if (already[i] == path) { return ""; }
    i = i + 1;
  }
  let written = executeWith(db, "INSERT INTO agent_scopes (agent_id, scope) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ")", [agentId, path]);
  if (!written.ok) { return written.error; }
  return "";
}

export function revokeScope(db: Db, agentId: string, scope: string): string {
  let removed = executeWith(db, "DELETE FROM agent_scopes WHERE agent_id = " + placeholderAt(db, 1)
    + " AND scope = " + placeholderAt(db, 2), [agentId, normalScope(scope)]);
  if (!removed.ok) { return removed.error; }
  return "";
}

// How an agent retrieves, or a row saying it does not.
export function retrievalFor(db: Db, agentId: string): AgentRetrievalRow {
  let off: AgentRetrievalRow = {
    agentId: agentId, embeddingModelId: "", topK: 0, maxDistance: 0.0, enabled: false,
  };
  let document = findById(db, agentRetrievalMapping(), agentId);
  if (document == "") { return off; }
  return JSON.parse<AgentRetrievalRow>(document);
}

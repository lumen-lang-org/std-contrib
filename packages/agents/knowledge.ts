import { Db } from "../plume/driver.ts";
import { DbRepository, execute, executeWith, findById, placeholderAt, safeIdentifier, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { ModelRow, modelsMapping } from "./schema.ts";
import { Embedding, Embeddings, embedText, embedTexts } from "./provider.ts";
import { documentRepository } from "./routes/knowledge/documents/entities/document.entity.ts";
import { agentRetrievalRepository } from "./routes/authoring/agents/entities/agent-retrieval.entity.ts";

export type DocumentRow = {
  id: string,
  source: string,
  scope: string,
  body: string,
  modelId: string,
};

export function embeddingModel(db: Db, modelId: string): ModelRow {
  let absent: ModelRow = {
    id: "",
    label: "",
    apiName: "",
    provider: "",
    kind: "",
    dimensions: 0,
    baseUrl: "",
    enabled: false,
    contextTokens: 0,
  };
  let document = findById(db, modelsMapping(), modelId);
  if (document == "") {
    return absent;
  }
  let model: ModelRow = JSON.parse<ModelRow>(document);
  if (model.kind != "embedding") {
    return absent;
  }
  return model;
}

export type Retrieved = {
  id: string,
  source: string,
  scope: string,
  body: string,
  distance: number,
};

export type Retrieval = {
  ok: bool,
  found: Retrieved[],
  error: string,
};

export function documentsMapping(): DbRepository {
  return documentRepository();
}

export function createDocuments(db: Db, model: ModelRow): string {
  if (model.id == "") {
    return "no embedding model";
  }
  if (model.dimensions <= 0) {
    return model.label + " does not say how wide its vectors are";
  }
  let dimensions = model.dimensions;
  let ext = execute(db, "CREATE EXTENSION IF NOT EXISTS vector");
  if (!ext.ok) {
    return ext.error;
  }
  let made = execute(db, "CREATE TABLE IF NOT EXISTS documents ("
    + "id " + db.textType + " PRIMARY KEY, "
    + "source " + db.textType + " NOT NULL, "
    + "scope " + db.textType + " NOT NULL, "
    + "body " + db.textType + " NOT NULL, "
    + "model_id " + db.textType + " NOT NULL, "
    + "embedding vector(" + `${dimensions}` + "))");
  if (!made.ok) {
    return made.error;
  }
  return "";
}

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
  if (!safeIdentifier(id)) {
    return "a document id must be a plain name";
  }
  if (model.kind != "embedding") {
    return model.label + " is not an embedding model";
  }
  let vector = embedText(model, body, apiKey);
  if (!vector.ok) {
    return vector.error;
  }
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
  if (!written.ok) {
    return written.error;
  }
  return "";
}

/** What a document may be filed under.
 *
 *  Deliberately NOT safeIdentifier, which guards SQL identifiers and refuses a
 *  hyphen. A source is never spelled into a statement — every use of it here is
 *  a bound parameter — so the rule it needs is the one the tool already applies
 *  and the one every error message here promises: letters, digits, _ and -.
 *
 *  They used to disagree. add_document accepted "release-notes", answered that
 *  it was queued and searchable in a minute, and the indexer then threw it away
 *  against a stricter rule, so the document was promised and never arrived. */
export function plainSource(source: string): bool {
  if (source == "" || source.length > 48) {
    return false;
  }
  let i: int = 0;
  while (i < source.length) {
    let c = source.charCodeAt(i);
    let letter = (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
    let ok = letter || (c >= 48 && c <= 57) || c == 45 || c == 95;
    if (!ok) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function normalScope(scope: string): string {
  let out = scope.trim();
  while (out.endsWith("/")) {
    out = out.slice(0, out.length - 1);
  }
  if (out == "") {
    return "/";
  }
  if (!out.startsWith("/")) {
    out = "/" + out;
  }
  return out;
}

const SCOPE_ESCAPE = "!";

export function likeLiteral(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (ch == SCOPE_ESCAPE || ch == "%" || ch == "_") {
      out = out + SCOPE_ESCAPE;
    }
    out = out + ch;
    i = i + 1;
  }
  return out;
}

export function scopeClause(db: Db, scopes: string[], from: int): string {
  if (scopes.length == 0) {
    return "";
  }
  let out = "(";
  let i: int = 0;
  while (i < scopes.length) {
    if (i > 0) {
      out = out + " OR ";
    }
    out = out + "scope = " + placeholderAt(db, from + i * 2)
      + " OR scope LIKE " + placeholderAt(db, from + i * 2 + 1)
      + " ESCAPE '" + SCOPE_ESCAPE + "'";
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
    if (s == "/") {
      out.push("/%");
    } else {
      out.push(likeLiteral(s) + "/%");
    }
    i = i + 1;
  }
  return out;
}

export function retrieve(db: Db, model: ModelRow, scopes: string[], question: string, k: int, apiKey: string): Retrieval {
  let none: string[] = [];
  return retrieveExcluding(db, model, scopes, none, question, k, apiKey);
}

export function retrieveExcluding(db: Db, model: ModelRow, scopes: string[], excludeIds: string[], question: string, k: int, apiKey: string): Retrieval {
  let none: Retrieved[] = [];
  if (k <= 0 || k > 100) {
    let bad: Retrieval = { ok: false, found: none, error: "k must be between 1 and 100" };
    return bad;
  }
  if (model.kind != "embedding") {
    let wrong: Retrieval = {
      ok: false,
      found: none,
      error: model.label + " is not an embedding model",
    };
    return wrong;
  }
  if (scopes.length == 0) {
    let ungranted: Retrieval = {
      ok: false,
      found: none,
      error: "no scopes granted, so nothing is readable",
    };
    return ungranted;
  }
  let vector = embedText(model, question, apiKey);
  if (!vector.ok) {
    let failed: Retrieval = { ok: false, found: none, error: vector.error };
    return failed;
  }
  let where = scopeClause(db, scopes, 3);
  let at = 3 + scopes.length * 2;
  let notIn = "";
  if (excludeIds.length > 0) {
    notIn = " AND id NOT IN (";
    let x: int = 0;
    while (x < excludeIds.length) {
      if (x > 0) {
        notIn = notIn + ", ";
      }
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
  while (b < bound.length) {
    args.push(bound[b]);
    b = b + 1;
  }
  let e: int = 0;
  while (e < excludeIds.length) {
    args.push(excludeIds[e]);
    e = e + 1;
  }
  args.push(vector.vector);
  if (!db.query(sql, args)) {
    let refused: Retrieval = {
      ok: false,
      found: none,
      error: "the search was refused: " + db.lastError(),
    };
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

function fnv1a(text: string): string {
  let hash: int = 5381;
  let i: int = 0;
  while (i < text.length) {
    let m = hash & 0x01ffffff;
    hash = (m << 5) + m + text.charCodeAt(i);
    i = i + 1;
  }
  let digits = "0123456789abcdef";
  let out = "";
  let d: int = 0;
  let held = hash;
  while (d < 8) {
    out = digits.charAt(held & 15) + out;
    held = held >> 4;
    d = d + 1;
  }
  return out;
}

export function asContext(found: Retrieved[]): string {
  if (found.length == 0) {
    return "";
  }
  let out = "Passages retrieved from the knowledge base for this question. "
    + "When you answer from the corpus, answer from these and say so when they do not cover it "
    + "— never attribute to the corpus what is not in them. They are retrieved by resemblance "
    + "to the question, so they may be beside the point: judge, and when the task calls for "
    + "your tools or skills, use them regardless of what was retrieved.\n";
  let i: int = 0;
  while (i < found.length) {
    out = out + "\n[" + found[i].source + "/" + found[i].id + "]\n" + found[i].body + "\n";
    i = i + 1;
  }
  return out;
}

const CHUNK_CHARS: int = 1000;

/* How many chunks ride in one embedding request. Not a rate limit: the server
 * batches internally, and this only keeps one request's body bounded so a
 * thousand-chunk document does not become a single enormous POST. */
const EMBED_BATCH: int = 32;

export type Upload = {
  ok: bool,
  chunks: int,
  error: string,
};

export function splitIntoChunks(body: string, maxChars: int): string[] {
  let out: string[] = [];
  let current = "";
  let rest = body;

  while (rest.length > 0) {
    let at = rest.indexOf("\n\n");
    let para = rest;
    if (at >= 0) {
      para = rest.slice(0, at);
      rest = rest.slice(at + 2, rest.length);
    }
    else {
      rest = "";
    }
    if (para.trim() == "") {
      continue;
    }

    while (para.length > maxChars) {
      if (current != "") {
        out.push(current);
        current = "";
      }
      out.push(para.slice(0, maxChars));
      para = para.slice(maxChars, para.length);
    }
    if (current == "") {
      current = para;
    }
    else if (current.length + para.length + 2 <= maxChars) {
      current = current + "\n\n" + para;
    }
    else {
      out.push(current);
      current = para;
    }
  }
  if (current.trim() != "") {
    out.push(current);
  }
  return out;
}

export function uploadDocument(db: Db, model: ModelRow, source: string, scope: string, body: string, apiKey: string): Upload {
  if (source == "") {
    let unnamed: Upload = {
      ok: false,
      chunks: 0,
      error: "a document needs a source to be filed under",
    };
    return unnamed;
  }
  if (body.trim() == "") {
    let empty: Upload = {
      ok: false,
      chunks: 0,
      error: "an empty document has nothing to retrieve",
    };
    return empty;
  }
  if (!plainSource(source)) {
    let odd: Upload = {
      ok: false,
      chunks: 0,
      error: "a source must be a plain name: letters, digits, _ and -",
    };
    return odd;
  }

  let cleared = executeWith(db, "DELETE FROM documents WHERE source = " + placeholderAt(db, 1), [source]);
  if (!cleared.ok) {
    let blocked: Upload = {
      ok: false,
      chunks: 0,
      error: "\"" + source + "\"'s old chunks could not be cleared, so re-indexing was refused rather than risk duplicating them: " + cleared.error,
    };
    return blocked;
  }

  let stem = source;
  if (stem.length > 48) {
    stem = stem.slice(0, 39) + "_" + fnv1a(source);
  }

  if (model.kind != "embedding") {
    let wrong: Upload = { ok: false, chunks: 0, error: model.label + " is not an embedding model" };
    return wrong;
  }

  // A document's chunks go up together. One round trip per chunk was the whole
  // cost of indexing: eight chunks measured 1.8s serially and 0.37s in one
  // request. EMBED_BATCH bounds the body rather than the wait.
  let chunks = splitIntoChunks(body, CHUNK_CHARS);
  let written: int = 0;
  let at: int = 0;
  while (at < chunks.length) {
    let upto = at + EMBED_BATCH;
    if (upto > chunks.length) {
      upto = chunks.length;
    }
    let batch: string[] = [];
    let b: int = at;
    while (b < upto) {
      batch.push(chunks[b]);
      b = b + 1;
    }
    let got = embedTexts(model, batch, apiKey);
    if (!got.ok) {
      let failed: Upload = { ok: false, chunks: written,
        error: "chunk " + `${at}` + ": " + got.error };
      return failed;
    }
    if (got.dimensions != model.dimensions) {
      let mismatched: Upload = { ok: false, chunks: written,
        error: model.label + " says " + `${model.dimensions}` + " dimensions and returned "
          + `${got.dimensions}` };
      return mismatched;
    }
    let k: int = 0;
    while (k < got.vectors.length) {
      let which = at + k;
      let id = stem + "_" + `${which}`;
      executeWith(db, "DELETE FROM documents WHERE id = " + placeholderAt(db, 1), [id]);
      let stored = executeWith(db,
        "INSERT INTO documents (id, source, scope, body, model_id, embedding) VALUES ("
        + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", "
        + placeholderAt(db, 3) + ", " + placeholderAt(db, 4) + ", "
        + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ")",
        [id, source, normalScope(scope), chunks[which], model.id, got.vectors[k]]);
      if (!stored.ok) {
        let refused: Upload = { ok: false, chunks: written,
          error: "chunk " + `${which}` + ": " + stored.error };
        return refused;
      }
      written = written + 1;
      k = k + 1;
    }
    at = upto;
  }
  let out: Upload = { ok: true, chunks: written, error: "" };
  return out;
}

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
  if (!db.query(sql, [where])) {
    return out;
  }
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


export type AgentRetrievalRow = {
  agentId: string,
  embeddingModelId: string,
  topK: int,
  maxDistance: number,
  enabled: bool,
};

export function agentRetrievalMapping(): DbRepository {
  return agentRetrievalRepository();
}

export function knowledgePlan(db: Db): Migration[] {
  let plan: Migration[] = [
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

export function grantScope(db: Db, agentId: string, scope: string): string {
  let path = normalScope(scope);
  let already = agentScopes(db, agentId);
  let i: int = 0;
  while (i < already.length) {
    if (already[i] == path) {
      return "";
    }
    i = i + 1;
  }
  let written = executeWith(db, "INSERT INTO agent_scopes (agent_id, scope) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ")", [agentId, path]);
  if (!written.ok) {
    return written.error;
  }
  return "";
}

export function revokeScope(db: Db, agentId: string, scope: string): string {
  let removed = executeWith(db, "DELETE FROM agent_scopes WHERE agent_id = " + placeholderAt(db, 1)
    + " AND scope = " + placeholderAt(db, 2), [agentId, normalScope(scope)]);
  if (!removed.ok) {
    return removed.error;
  }
  return "";
}

export function retrievalFor(db: Db, agentId: string): AgentRetrievalRow {
  let off: AgentRetrievalRow = {
    agentId: agentId, embeddingModelId: "", topK: 0, maxDistance: 0.0, enabled: false,
  };
  let document = findById(db, agentRetrievalMapping(), agentId);
  if (document == "") {
    return off;
  }
  return JSON.parse<AgentRetrievalRow>(document);
}

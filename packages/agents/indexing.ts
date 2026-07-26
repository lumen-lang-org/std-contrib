// Indexing as a queue, because embedding is slow and a request is not.
//
// Uploading a document used to mean holding the HTTP connection open while
// every chunk went to the model one at a time: a large file times out, a
// browser shows nothing until it finishes, and a failure halfway leaves a
// partly indexed corpus with nobody told. So an upload writes a job and
// answers; a worker drains the queue and the job carries what happened.
//
// The queue is a table rather than a broker. PostgreSQL is already required
// here — documents need pgvector — so a job table adds no service, and
// `FOR UPDATE SKIP LOCKED` gives the same at-most-one-worker-per-row guarantee
// a broker would. The rows are also the journal the console renders, which a
// broker does not keep.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, asc, persist, findById, listOrdered, executeWith, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

// What a job is doing. A reader sees these words, so they are the words.
export const JOB_QUEUED: string = "queued";
export const JOB_INDEXING: string = "indexing";
export const JOB_INDEXED: string = "indexed";
export const JOB_FAILED: string = "failed";

export type IndexJobRow = {
  id: string,
  source: string,
  scope: string,
  // Which embedding model was active when this was queued. Kept on the job so
  // a corpus reindexed after the model changed says which one produced it.
  modelId: string,
  body: string,
  status: string,
  chunks: int,
  error: string,
  createdAt: string,
  updatedAt: string,
};

export function indexJobsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("source", "source", "text"),
    field("scope", "scope", "text"),
    field("modelId", "model_id", "text"),
    field("body", "body", "text"),
    field("status", "status", "text"),
    field("chunks", "chunks", "int"),
    field("error", "error", "text"),
    field("createdAt", "created_at", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("index_jobs", "id", "id", fs);
}

export function indexingPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("40", "index jobs", createTableSql(db, indexJobsMapping())),
    migration("41", "index jobs by status",
      "CREATE INDEX IF NOT EXISTS index_jobs_by_status ON index_jobs (status, created_at)"),
  ];
  return plan;
}

// Queue a document. The body is carried on the job rather than in a file: a
// worker in another process cannot read the uploader's disk, and a document
// small enough to POST is small enough to hold.
export function enqueue(db: Db, source: string, scope: string, modelId: string, body: string, now: string): string {
  let id = crypto.randomUUID();
  let row: IndexJobRow = {
    id: id, source: source, scope: scope, modelId: modelId, body: body,
    status: JOB_QUEUED, chunks: 0, error: "", createdAt: now, updatedAt: now,
  };
  let written = persist(db, indexJobsMapping(), JSON.stringify(row));
  if (!written.ok) { return ""; }
  return id;
}

// Take the oldest queued job, atomically.
//
// The claim is one statement — a SELECT then an UPDATE would hand the same row
// to two workers between them. `SKIP LOCKED` is what makes a second worker
// take the next row instead of waiting on this one.
export function claimNext(db: Db, now: string): IndexJobRow {
  let none: IndexJobRow = {
    id: "", source: "", scope: "", modelId: "", body: "",
    status: "", chunks: 0, error: "", createdAt: "", updatedAt: "",
  };
  let sql = "UPDATE index_jobs SET status = " + db.placeholder
    + ", updated_at = " + placeholderAt(db, 2)
    + " WHERE id = (SELECT id FROM index_jobs WHERE status = " + placeholderAt(db, 3)
    + " ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)"
    + " RETURNING id, source, scope, model_id, body";
  if (!db.query(sql, [JOB_INDEXING, now, JOB_QUEUED])) { return none; }
  if (db.rows() == 0) { return none; }
  let claimed: IndexJobRow = {
    id: db.value(0, 0), source: db.value(0, 1), scope: db.value(0, 2),
    modelId: db.value(0, 3), body: db.value(0, 4),
    status: JOB_INDEXING, chunks: 0, error: "", createdAt: "", updatedAt: now,
  };
  return claimed;
}

export function markIndexed(db: Db, id: string, chunks: int, now: string): void {
  executeWith(db, "UPDATE index_jobs SET status = " + db.placeholder
    + ", chunks = " + placeholderAt(db, 2)
    + ", updated_at = " + placeholderAt(db, 3)
    + " WHERE id = " + placeholderAt(db, 4),
    [JOB_INDEXED, `${chunks}`, now, id]);
}

export function markFailed(db: Db, id: string, why: string, now: string): void {
  executeWith(db, "UPDATE index_jobs SET status = " + db.placeholder
    + ", error = " + placeholderAt(db, 2)
    + ", updated_at = " + placeholderAt(db, 3)
    + " WHERE id = " + placeholderAt(db, 4),
    [JOB_FAILED, why, now, id]);
}

// Jobs that have not finished, for a scope or for everything. What the console
// shows above the indexed documents, so an upload is visible while it waits.
export function pendingJobs(db: Db, scope: string): IndexJobRow[] {
  let out: IndexJobRow[] = [];
  let sql = "SELECT id, source, scope, status, chunks, error, created_at FROM index_jobs"
    + " WHERE status <> " + db.placeholder + " AND status <> " + placeholderAt(db, 2);
  let args: string[] = [JOB_INDEXED, ""];
  if (scope != "") {
    sql = sql + " AND scope = " + placeholderAt(db, 3);
    args = [JOB_INDEXED, "", scope];
  }
  sql = sql + " ORDER BY created_at";
  if (!db.query(sql, args)) { return out; }
  let i: int = 0;
  while (i < db.rows()) {
    let row: IndexJobRow = {
      id: db.value(i, 0), source: db.value(i, 1), scope: db.value(i, 2),
      modelId: "", body: "", status: db.value(i, 3),
      chunks: parseInt(db.value(i, 4)) ?? 0, error: db.value(i, 5),
      createdAt: db.value(i, 6), updatedAt: "",
    };
    out.push(row);
    i = i + 1;
  }
  return out;
}

// A job whose worker died mid-flight: still "indexing" long after it was
// claimed. Returned to the queue rather than left forever — the alternative is
// a document nobody indexes and nobody is told about.
export function requeueStalled(db: Db, before: string): void {
  executeWith(db, "UPDATE index_jobs SET status = " + db.placeholder
    + " WHERE status = " + placeholderAt(db, 2)
    + " AND updated_at < " + placeholderAt(db, 3),
    [JOB_QUEUED, JOB_INDEXING, before]);
}

export function forgetFinished(db: Db, before: string): void {
  executeWith(db, "DELETE FROM index_jobs WHERE status = " + db.placeholder
    + " AND updated_at < " + placeholderAt(db, 2), [JOB_INDEXED, before]);
}

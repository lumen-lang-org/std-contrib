import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, persist, findById, listOrdered, executeWith, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export const JOB_QUEUED: string = "queued";
export const JOB_INDEXING: string = "indexing";
export const JOB_INDEXED: string = "indexed";
export const JOB_FAILED: string = "failed";

export type IndexJobRow = {
  id: string,
  source: string,
  scope: string,
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
  return repository({ table: "index_jobs", idField: "id", idColumn: "id", fields: fs });
}

export function indexingPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("40", "index jobs", createTableSql(db, indexJobsMapping())),
    migration("41", "index jobs by status",
      "CREATE INDEX IF NOT EXISTS index_jobs_by_status ON index_jobs (status, created_at)"),
  ];
  return plan;
}

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

export function requeueStalled(db: Db, before: string): void {
  if (before == "") {
    executeWith(db, "UPDATE index_jobs SET status = " + db.placeholder
      + " WHERE status = " + placeholderAt(db, 2),
      [JOB_QUEUED, JOB_INDEXING]);
    return;
  }
  executeWith(db, "UPDATE index_jobs SET status = " + db.placeholder
    + " WHERE status = " + placeholderAt(db, 2)
    + " AND updated_at < " + placeholderAt(db, 3),
    [JOB_QUEUED, JOB_INDEXING, before]);
}

export function forgetFinished(db: Db, before: string): void {
  executeWith(db, "DELETE FROM index_jobs WHERE status = " + db.placeholder
    + " AND updated_at < " + placeholderAt(db, 2), [JOB_INDEXED, before]);
}

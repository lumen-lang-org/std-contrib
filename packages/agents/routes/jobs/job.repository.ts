import { Db } from "../../../plume/driver.ts";
import { DbRepository, executeWith, persist, placeholderAt } from "../../../plume/plume.ts";
import { IndexJobRow, JOB_FAILED, JOB_INDEXED, JOB_INDEXING, JOB_QUEUED, indexJobRepository } from "./entities/index-job.entity.ts";

export class JobRepository {
  database: Db;
  jobs: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.jobs = indexJobRepository();
  }

  enqueue(source: string, scope: string, modelId: string, body: string, now: string): string {
    let id = crypto.randomUUID();
    let row: IndexJobRow = {
      id: id, source: source, scope: scope, modelId: modelId, body: body,
      status: JOB_QUEUED, chunks: 0, error: "", createdAt: now, updatedAt: now,
    };
    let written = persist(this.database, this.jobs, JSON.stringify(row));
    if (!written.ok) {
      return "";
    }
    return id;
  }

  claimNext(now: string): IndexJobRow {
    let none: IndexJobRow = {
      id: "", source: "", scope: "", modelId: "", body: "",
      status: "", chunks: 0, error: "", createdAt: "", updatedAt: "",
    };
    let sql = "UPDATE index_jobs SET status = " + this.database.placeholder
      + ", updated_at = " + placeholderAt(this.database, 2)
      + " WHERE id = (SELECT id FROM index_jobs WHERE status = " + placeholderAt(this.database, 3)
      + " ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)"
      + " RETURNING id, source, scope, model_id, body";
    if (!this.database.query(sql, [JOB_INDEXING, now, JOB_QUEUED])) {
      return none;
    }
    if (this.database.rows() == 0) {
      return none;
    }
    let claimed: IndexJobRow = {
      id: this.database.value(0, 0), source: this.database.value(0, 1), scope: this.database.value(0, 2),
      modelId: this.database.value(0, 3), body: this.database.value(0, 4),
      status: JOB_INDEXING, chunks: 0, error: "", createdAt: "", updatedAt: now,
    };
    return claimed;
  }

  markIndexed(id: string, chunks: int, now: string): void {
    executeWith(this.database, "UPDATE index_jobs SET status = " + this.database.placeholder
      + ", chunks = " + placeholderAt(this.database, 2)
      + ", updated_at = " + placeholderAt(this.database, 3)
      + " WHERE id = " + placeholderAt(this.database, 4),
      [JOB_INDEXED, `${chunks}`, now, id]);
  }

  markFailed(id: string, why: string, now: string): void {
    executeWith(this.database, "UPDATE index_jobs SET status = " + this.database.placeholder
      + ", error = " + placeholderAt(this.database, 2)
      + ", updated_at = " + placeholderAt(this.database, 3)
      + " WHERE id = " + placeholderAt(this.database, 4),
      [JOB_FAILED, why, now, id]);
  }

  requeueStalled(before: string): void {
    if (before == "") {
      executeWith(this.database, "UPDATE index_jobs SET status = " + this.database.placeholder
        + " WHERE status = " + placeholderAt(this.database, 2),
        [JOB_QUEUED, JOB_INDEXING]);
      return;
    }
    executeWith(this.database, "UPDATE index_jobs SET status = " + this.database.placeholder
      + " WHERE status = " + placeholderAt(this.database, 2)
      + " AND updated_at < " + placeholderAt(this.database, 3),
      [JOB_QUEUED, JOB_INDEXING, before]);
  }

  forgetFinished(before: string): void {
    executeWith(this.database, "DELETE FROM index_jobs WHERE status = " + this.database.placeholder
      + " AND updated_at < " + placeholderAt(this.database, 2), [JOB_INDEXED, before]);
  }

  pending(scope: string): IndexJobRow[] {
    let out: IndexJobRow[] = [];
    let sql = "SELECT id, source, scope, status, chunks, error, created_at FROM index_jobs"
      + " WHERE status <> " + this.database.placeholder + " AND status <> " + placeholderAt(this.database, 2);
    let args: string[] = [JOB_INDEXED, ""];
    if (scope != "") {
      sql = sql + " AND scope = " + placeholderAt(this.database, 3);
      args = [JOB_INDEXED, "", scope];
    }
    sql = sql + " ORDER BY created_at";
    if (!this.database.query(sql, args)) {
      return out;
    }
    let i: int = 0;
    while (i < this.database.rows()) {
      let row: IndexJobRow = {
        id: this.database.value(i, 0), source: this.database.value(i, 1), scope: this.database.value(i, 2),
        modelId: "", body: "", status: this.database.value(i, 3),
        chunks: parseInt(this.database.value(i, 4)) ?? 0, error: this.database.value(i, 5),
        createdAt: this.database.value(i, 6), updatedAt: "",
      };
      out.push(row);
      i = i + 1;
    }
    return out;
  }
}

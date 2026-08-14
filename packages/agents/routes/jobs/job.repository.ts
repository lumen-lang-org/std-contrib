import { Db } from "../../../plume/driver.ts";
import { placeholderAt } from "../../../plume/plume.ts";
import { IndexJobRow, JOB_INDEXED } from "./entities/index-job.entity.ts";

export class JobRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
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

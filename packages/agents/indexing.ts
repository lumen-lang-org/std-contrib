import { Db } from "../plume/driver.ts";
import { DbRepository, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { indexJobRepository } from "./routes/jobs/entities/index-job.entity.ts";

export function indexJobsMapping(): DbRepository {
  return indexJobRepository();
}

export function indexingPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("40", "index jobs", createTableSql(db, indexJobsMapping())),
    migration("41", "index jobs by status",
      "CREATE INDEX IF NOT EXISTS index_jobs_by_status ON index_jobs (status, created_at)"),
  ];
  return plan;
}

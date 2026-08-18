import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, field, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { indexJobRepository } from "./routes/knowledge/jobs/entities/index-job.entity.ts";

export function indexJobsMapping(): DbRepository {
  return indexJobRepository();
}

/* The shape migration 40 created, frozen. It is generated from a mapping, so
 * reading it from the live entity makes an applied migration change under us. */
function indexJobsMappingV1(): DbRepository {
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
    migration("40", "index jobs", createTableSql(db, indexJobsMappingV1())),
    migration("41", "index jobs by status",
      "CREATE INDEX IF NOT EXISTS index_jobs_by_status ON index_jobs (status, created_at)"),
    migration("129", "a queued upload belongs to whoever asked for it",
      "ALTER TABLE index_jobs ADD COLUMN owner " + db.textType + " NOT NULL DEFAULT ''"),
  ];
  return plan;
}

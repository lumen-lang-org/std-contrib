import { Guarded } from "../../../rest/server.ts";
import { pgOnly } from "../../guards.ts";
import { JobService } from "./job.service.ts";

export function jobsNeedPostgres(jobs: JobService): Guarded {
  let database = jobs.repository.database;
  return pgOnly(database, "jobs need PostgreSQL (pgvector); this runs on " + database.name);
}

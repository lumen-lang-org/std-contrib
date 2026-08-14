import { Db } from "../../../plume/driver.ts";
import { ScopeNode, scopeCounts } from "../../knowledge.ts";
import { JobRepository } from "../jobs/job.repository.ts";
import { IndexJobRow } from "../jobs/entities/index-job.entity.ts";

export class ScopeRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  pending(): IndexJobRow[] {
    return new JobRepository(this.database).pending("");
  }

  counts(prefix: string, scopes: string[]): ScopeNode[] {
    return scopeCounts(this.database, prefix, scopes);
  }
}

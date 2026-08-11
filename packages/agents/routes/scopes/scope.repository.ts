import { Db } from "../../../plume/driver.ts";
import { IndexJobRow, pendingJobs } from "../../indexing.ts";
import { ScopeNode, scopeCounts } from "../../knowledge.ts";

export class ScopeRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  pending(): IndexJobRow[] {
    return pendingJobs(this.database, "");
  }

  counts(prefix: string, scopes: string[]): ScopeNode[] {
    return scopeCounts(this.database, prefix, scopes);
  }
}

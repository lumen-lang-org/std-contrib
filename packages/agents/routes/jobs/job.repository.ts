import { Db } from "../../../plume/driver.ts";
import { IndexJobRow, pendingJobs } from "../../indexing.ts";

export class JobRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  pending(scope: string): IndexJobRow[] {
    return pendingJobs(this.database, scope);
  }
}

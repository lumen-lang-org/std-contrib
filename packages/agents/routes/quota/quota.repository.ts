import { Db } from "../../../plume/driver.ts";
import { runsSince } from "../../usage.ts";

export class QuotaRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  runCountSince(owner: string, since: string): int {
    return runsSince(this.database, owner, since);
  }
}

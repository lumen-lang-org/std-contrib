import { Db } from "../../../plume/driver.ts";
import { DbResult, findById, persist } from "../../../plume/plume.ts";
import { TraceConfigRow, traceConfigMapping } from "../../trace.ts";

export class TraceRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  one(): string {
    return findById(this.database, traceConfigMapping(), "default");
  }

  save(row: TraceConfigRow): DbResult {
    return persist(this.database, traceConfigMapping(), JSON.stringify(row));
  }
}

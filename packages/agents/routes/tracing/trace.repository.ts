import { Db } from "../../../plume/driver.ts";
import { DbResult, findById, persist } from "../../../plume/plume.ts";
import { TraceConfigRow, traceConfigRepository } from "./entities/trace-config.entity.ts";

export class TraceRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  one(): string {
    return findById(this.database, traceConfigRepository(), "default");
  }

  save(row: TraceConfigRow): DbResult {
    return persist(this.database, traceConfigRepository(), JSON.stringify(row));
  }
}

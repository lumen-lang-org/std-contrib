import { Db } from "../../../plume/driver.ts";
import { DbRepository, findById } from "../../../plume/plume.ts";
import { runRepository } from "./entities/run.entity.ts";

export class RunRepository {
  database: Db;
  runs: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.runs = runRepository();
  }

  one(id: string): string {
    return findById(this.database, this.runs, id);
  }
}

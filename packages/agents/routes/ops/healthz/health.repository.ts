import { Db } from "../../../../plume/driver.ts";
import { appliedHighWater } from "../../../../plume/migrate.ts";

export class HealthRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  migrationHighWater(): string {
    return appliedHighWater(this.database);
  }
}

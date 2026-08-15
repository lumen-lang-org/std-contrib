import { Db } from "../../../../plume/driver.ts";
import { OwnerUsage, ownerUsage } from "../../../usage.ts";

export class UsageRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  totals(owner: string): OwnerUsage {
    return ownerUsage(this.database, owner);
  }
}

import { Db } from "../../../plume/driver.ts";
import { usageJson } from "../../usage.ts";
import { UsageRepository } from "./usage.repository.ts";

export class UsageService {
  repository: UsageRepository;

  constructor(database: Db) {
    this.repository = new UsageRepository(database);
  }

  forOwner(owner: string): string {
    return usageJson(this.repository.totals(owner));
  }
}

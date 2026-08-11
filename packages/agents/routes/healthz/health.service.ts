import { Db } from "../../../plume/driver.ts";
import { boolJson } from "../../api-core.ts";
import { envDockerUp } from "../../environments.ts";
import { HealthRepository } from "./health.repository.ts";

const API_VERSION: string = "0.2.0";

export class HealthService {
  repository: HealthRepository;

  constructor(database: Db) {
    this.repository = new HealthRepository(database);
  }

  status(now: string): string {
    return "{\"version\":" + JSON.stringify(API_VERSION)
      + ",\"migration\":" + JSON.stringify(this.repository.migrationHighWater())
      + ",\"docker\":" + boolJson(envDockerUp(now)) + "}";
  }
}

import { Db } from "../../../plume/driver.ts";
import { appliedHighWater } from "../../../plume/migrate.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, Ok } from "../../../rest/server.ts";
import { boolJson, stamp } from "../../api-core.ts";
import { envDockerUp } from "../../environments.ts";

const API_VERSION: string = "0.2.0";

export function healthJson(db: Db, now: string): string {
  return "{\"version\":" + JSON.stringify(API_VERSION)
    + ",\"migration\":" + JSON.stringify(appliedHighWater(db))
    + ",\"docker\":" + boolJson(envDockerUp(now)) + "}";
}

@controller("/healthz")
@bindings
export class HealthApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  show(req: Request): Reply {
    return Ok(healthJson(this.db, stamp()));
  }
}

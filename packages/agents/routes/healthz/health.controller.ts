import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Ok } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { HealthService } from "./health.service.ts";

@controller("/healthz")
@bindings
export class HealthApi {
  health: HealthService;

  constructor(database: Db) {
    this.health = new HealthService(database);
  }

  @Get("/")
  show(): Reply {
    return Ok(this.health.status(stamp()));
  }
}

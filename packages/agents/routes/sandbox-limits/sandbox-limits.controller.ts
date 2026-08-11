import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, answered, OkJson } from "../../../rest/server.ts";
import { SandboxLimitsService } from "./sandbox-limits.service.ts";

@controller("/sandbox-limits")
@bindings
export class SandboxLimitsApi {
  limits: SandboxLimitsService;

  constructor(database: Db) {
    this.limits = new SandboxLimitsService(database);
  }

  @Get("/")
  show(): Reply {
    return OkJson(this.limits.view());
  }

  @Put("/")
  change(@RequestBody body: string): Reply {
    return answered(this.limits.change(body));
  }
}

import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, OkJson, Refused } from "../../../rest/server.ts";
import { SandboxLimits, defaultLimits, sandboxLimits, saveSandboxLimits } from "../../sandbox-limits.ts";
import { SandboxLimitsView } from "./types.ts";

@controller("/sandbox-limits")
@bindings
export class SandboxLimitsApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  show(req: Request): Reply {
    let v: SandboxLimitsView = { limits: sandboxLimits(this.db), defaults: defaultLimits() };
    return OkJson(v);
  }

  @Put("/")
  change(req: Request): Reply {
    if (req.body == "") {
      return BadRequest("a body is required: the seven limits, 0 for any that should keep the default");
    }
    let l: SandboxLimits = JSON.parse<SandboxLimits>(req.body);
    let problem = saveSandboxLimits(this.db, l);
    if (problem != "") {
      return BadRequest(problem);
    }
    return this.show(req);
  }
}

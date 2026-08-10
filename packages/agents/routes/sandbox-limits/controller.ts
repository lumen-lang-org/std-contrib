import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, okJson, problem } from "../../../rest/server.ts";
import { SandboxLimits, defaultLimits, sandboxLimits, saveSandboxLimits } from "../../sandbox-limits.ts";
import { SandboxLimitsView } from "./types.ts";

@controller("/sandbox-limits")
export class SandboxLimitsApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  show(req: Request): Reply {
    let v: SandboxLimitsView = { limits: sandboxLimits(this.db), defaults: defaultLimits() };
    return okJson(v);
  }

  @put("/")
  change(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: the seven limits, 0 for any that should keep the default"); }
    let l: SandboxLimits = JSON.parse<SandboxLimits>(req.body);
    let problem = saveSandboxLimits(this.db, l);
    if (problem != "") { return badRequest(problem); }
    return this.show(req);
  }
}

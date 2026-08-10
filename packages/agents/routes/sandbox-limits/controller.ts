import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, ok, problem } from "../../../rest/server.ts";
import { SandboxLimits, defaultLimits, sandboxLimits, saveSandboxLimits } from "../../sandbox-limits.ts";

// The /sandbox-limits routes.

// The sandbox's limits, operator-set. The numbers a script container is
// bounded by, and the counts that bound how many environments and keys pile
// up — every one of which used to be a constant that needed a rebuild to
// change. Admin-tier like every other configuration surface (the console
// proxy tiers it; a bare :8100 is the launch gate's problem, not this
// route's). The reply always carries `defaults` too, so the screen can show
// what a field left at 0 will fall back to.
@controller("/sandbox-limits")
export class SandboxLimitsApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  show(req: Request): Reply {
    return ok("{\"limits\":" + JSON.stringify(sandboxLimits(this.db))
      + ",\"defaults\":" + JSON.stringify(defaultLimits()) + "}");
  }

  // Written whole, like the tracing connection and for the same reason: these
  // numbers are one policy, and a partial update is how a box ends with a
  // memory cap from one intention and a wall clock from another.
  @put("/")
  change(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required: the seven limits, 0 for any that should keep the default"); }
    let l: SandboxLimits = JSON.parse<SandboxLimits>(req.body);
    let problem = saveSandboxLimits(this.db, l);
    if (problem != "") { return badRequest(problem); }
    // saveSandboxLimits already applied them to the running process.
    return this.show(req);
  }
}

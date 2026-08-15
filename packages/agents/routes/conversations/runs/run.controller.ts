import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, Ok } from "../../../../rest/server.ts";
import { callerTags } from "../../../api-core.ts";
import { runVisible } from "./run.guard.ts";
import { RunService } from "./run.service.ts";

@controller("/runs")
@bindings
export class RunApi {
  runs: RunService;

  constructor(database: Db) {
    this.runs = new RunService(database);
  }

  theRun(request: Request): Guarded {
    return runVisible(this.runs, request);
  }

  @Get("/:id")
  @Guard(theRun)
  find(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return Ok(this.runs.visible(id, tags));
  }
}

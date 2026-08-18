import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, Accepted, BadRequest, Created, NoContent, Ok } from "../../../../rest/server.ts";
import { callerTags, owningCaller } from "../../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../../guards.ts";
import { namedAuthor, workflowOwned } from "./workflow.guard.ts";
import { WorkflowService } from "./workflow.service.ts";

@controller("/workflows")
@bindings
export class WorkflowApi {
  workflows: WorkflowService;

  constructor(database: Db) {
    this.workflows = new WorkflowService(database);
  }

  theWorkflow(request: Request): Guarded {
    return workflowOwned(this.workflows, request);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(@From(owningCaller) owner: string): Reply {
    return Ok(this.workflows.listing(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a workflow yours to keep"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    let made = this.workflows.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Get("/:id")
  @Guard(theWorkflow)
  one(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return Ok(this.workflows.one(id, tags));
  }

  @Put("/:id")
  @Guard(theWorkflow)
  update(@PathVariable("id") id: string, @From(callerTags) tags: string[],
         @RequestBody body: string): Reply {
    return answered(this.workflows.update(id, tags, body));
  }

  @Post("/script-check")
  @Guard(namedAuthor)
  scriptCheck(@RequestBody body: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"source\":\"...\"}");
    }
    return Ok(this.workflows.compiled(body));
  }

  @Post("/:id/publish")
  @Guard(theWorkflow)
  publish(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return answered(this.workflows.publish(id, tags));
  }

  @Post("/:id/run-now")
  @Guard(theWorkflow)
  runNow(@PathVariable("id") id: string, @From(callerTags) tags: string[],
         @RequestBody body: string): Reply {
    let started = this.workflows.runNow(id, tags, body);
    if (started.fault != "") {
      return BadRequest(started.fault);
    }
    return Accepted(started.document);
  }

  @Get("/:id/runs")
  @Guard(theWorkflow)
  runs(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return Ok(this.workflows.runs(id, tags));
  }

  @Delete("/:id")
  @Guard(theWorkflow)
  remove(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    let gone = this.workflows.forget(id, tags);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}

import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, Accepted, BadRequest, Created, NoContent, Ok } from "../../../../rest/server.ts";
import { callerTags, owningCaller } from "../../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../../guards.ts";
import { taskOwned } from "./task.guard.ts";
import { TaskService } from "./task.service.ts";

@controller("/tasks")
@bindings
export class TaskApi {
  tasks: TaskService;

  constructor(database: Db) {
    this.tasks = new TaskService(database);
  }

  theTask(request: Request): Guarded {
    return taskOwned(this.tasks, request);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(@From(owningCaller) owner: string): Reply {
    return Ok(this.tasks.listing(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a task yours to run"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    let made = this.tasks.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theTask)
  update(@PathVariable("id") id: string, @From(callerTags) tags: string[],
         @RequestBody body: string): Reply {
    return answered(this.tasks.update(id, tags, body));
  }

  @Post("/:id/run-now")
  @Guard(theTask)
  runNow(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    let started = this.tasks.runNow(id, tags);
    if (started.fault != "") {
      return BadRequest(started.fault);
    }
    return Accepted(started.document);
  }

  @Delete("/:id")
  @Guard(theTask)
  remove(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    let gone = this.tasks.forget(id, tags);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}

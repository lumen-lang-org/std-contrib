import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../rest/server.ts";
import { callerTags, owningCaller } from "../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";
import { projectOwned } from "./project.guard.ts";
import { ProjectService } from "./project.service.ts";

@controller("/projects")
@bindings
export class ProjectApi {
  projects: ProjectService;

  constructor(database: Db) {
    this.projects = new ProjectService(database);
  }

  theProject(request: Request): Guarded {
    return projectOwned(this.projects, request);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(@From(owningCaller) owner: string): Reply {
    return Ok(this.projects.listing(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a project yours"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    let made = this.projects.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theProject)
  update(@PathVariable("id") id: string, @From(callerTags) tags: string[],
         @RequestBody body: string): Reply {
    return answered(this.projects.update(id, tags, body));
  }

  @Delete("/:id")
  @Guard(theProject)
  remove(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    let gone = this.projects.forget(id, tags);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }

  @Post("/:id/files-thread")
  @Guard(theProject)
  filesThread(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return answered(this.projects.filesThread(id, tags));
  }
}

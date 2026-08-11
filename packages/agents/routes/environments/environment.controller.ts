import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, BadRequest, Created, NoContent, NotFound, OkJson } from "../../../rest/server.ts";
import { owningCaller } from "../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";
import { environmentOwned, threadEnvironmentOwned } from "./environment.guard.ts";
import { EnvironmentService } from "./environment.service.ts";

@controller("/environments")
@bindings
export class EnvironmentApi {
  environments: EnvironmentService;

  constructor(database: Db) {
    this.environments = new EnvironmentService(database);
  }

  theEnvironment(request: Request): Guarded {
    return environmentOwned(this.environments, request);
  }

  theThreadEnvironment(request: Request): Guarded {
    return threadEnvironmentOwned(this.environments, request);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  catalog(@From(owningCaller) owner: string): Reply {
    return OkJson(this.environments.catalog(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes an environment yours to keep"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    let made = this.environments.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Delete("/:id")
  @Guard(theEnvironment)
  remove(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    this.environments.remove(id, owner);
    return NoContent();
  }

  @Get("/mine")
  @Guard(ownedOrEmpty)
  mine(@From(owningCaller) owner: string): Reply {
    return OkJson(this.environments.mine(owner));
  }

  @Delete("/mine/:threadId/:name")
  @Guard(theThreadEnvironment)
  drop(@PathVariable("threadId") threadId: string, @PathVariable("name") name: string): Reply {
    if (!this.environments.drop(threadId, name)) {
      return NotFound("environment " + name);
    }
    return NoContent();
  }
}

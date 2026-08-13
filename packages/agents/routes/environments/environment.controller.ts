import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Ok, Reply, Request, BadRequest, Created, NoContent, NotFound, OkJson } from "../../../rest/server.ts";
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

  // Start one that serves. Publishing a port is not something a script run
  // should do by accident, so it is asked for explicitly and only by the owner.
  @Post("/mine/:threadId/:name/serve")
  @Guard(theThreadEnvironment)
  serve(@PathVariable("threadId") threadId: string, @PathVariable("name") name: string,
    @RequestBody body: string): Reply {
    let up = this.environments.serve(threadId, name, body);
    if (up.fault != "") {
      return BadRequest(up.fault);
    }
    return Ok(up.document);
  }

  // The way in, asked for by the console and answered only to the owner of the
  // conversation the environment belongs to.
  @Post("/mine/:threadId/:name/grant")
  @Guard(theThreadEnvironment)
  letIn(@PathVariable("threadId") threadId: string, @PathVariable("name") name: string,
    @From(owningCaller) owner: string): Reply {
    let made = this.environments.grant(threadId, name, owner);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Ok(made.document);
  }

  // The two the gateway calls, and the reason neither carries a session: the
  // browser arrives at a hostname this engine does not own a cookie on, so the
  // grant in the URL is the whole credential and the slug is the whole address.
  // Behind AGENTS_API_TOKEN, which every route but /healthz already sits behind.
  @Post("/redeem")
  redeem(@RequestBody body: string): Reply {
    return OkJson(this.environments.redeem(body));
  }

  @Get("/reach/:slug")
  reach(@PathVariable("slug") slug: string): Reply {
    return OkJson(this.environments.reach(slug));
  }
}

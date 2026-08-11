import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../rest/server.ts";
import { callerTags, owningCaller } from "../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";
import { botOwned } from "./trigger.guard.ts";
import { TriggerService } from "./trigger.service.ts";

@controller("/triggers")
@bindings
export class TriggerApi {
  triggers: TriggerService;

  constructor(database: Db, master: string) {
    this.triggers = new TriggerService(database, master);
  }

  theBot(request: Request): Guarded {
    return botOwned(this.triggers, request);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(@From(owningCaller) owner: string): Reply {
    return Ok(this.triggers.listing(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a bot yours to keep"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    let made = this.triggers.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Get("/:id")
  @Guard(theBot)
  one(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return Ok(this.triggers.one(id, tags));
  }

  @Put("/:id")
  @Guard(theBot)
  update(@PathVariable("id") id: string, @From(callerTags) tags: string[],
         @RequestBody body: string): Reply {
    return answered(this.triggers.update(id, tags, body));
  }

  @Post("/:id/test")
  @Guard(theBot)
  test(@PathVariable("id") id: string, @From(callerTags) tags: string[],
       @RequestBody body: string): Reply {
    return answered(this.triggers.test(id, tags, body));
  }

  @Get("/:id/queue")
  @Guard(theBot)
  queue(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return Ok(this.triggers.queue(id, tags));
  }

  @Delete("/:id")
  @Guard(theBot)
  remove(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    let gone = this.triggers.forget(id, tags);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}

import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, BadRequest, Created, NoContent, NotFound, Ok } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../../guards.ts";
import { EnvKeyService } from "./env-key.service.ts";

@controller("/env-keys")
@bindings
export class EnvKeyApi {
  envKeys: EnvKeyService;

  constructor(database: Db, master: string) {
    this.envKeys = new EnvKeyService(database, master);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(@From(owningCaller) owner: string): Reply {
    return Ok(this.envKeys.listing(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes an environment key yours to keep"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"imageId\":\"...\",\"name\":\"OPENAI_API_KEY\",\"value\":\"...\"}");
    }
    let made = this.envKeys.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    if (!this.envKeys.forget(id, owner)) {
      return NotFound("environment key " + id);
    }
    return NoContent();
  }
}

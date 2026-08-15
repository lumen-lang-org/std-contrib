import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, BadRequest, Created, NoContent, NotFound, Ok } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../../guards.ts";
import { ApiKeyService } from "./api-key.service.ts";

@controller("/api-keys")
@bindings
export class ApiKeyApi {
  apiKeys: ApiKeyService;

  constructor(database: Db) {
    this.apiKeys = new ApiKeyService(database);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(@From(owningCaller) owner: string): Reply {
    return Ok(this.apiKeys.listing(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a key yours to keep"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"name\":\"...\",\"scopes\":\"search,retrieve\"}");
    }
    let made = this.apiKeys.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    if (!this.apiKeys.forget(id, owner)) {
      return NotFound("key " + id);
    }
    return NoContent();
  }
}

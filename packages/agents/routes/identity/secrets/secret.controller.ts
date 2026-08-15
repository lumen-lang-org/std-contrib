import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, BadRequest, Created, NoContent, NotFound, Ok } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { ownedOrEmpty, roleAtLeast } from "../../../guards.ts";
import { SecretService } from "./secret.service.ts";

@controller("/secrets")
@bindings
export class SecretApi {
  secrets: SecretService;

  constructor(database: Db, master: string) {
    this.secrets = new SecretService(database, master);
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(@From(owningCaller) owner: string): Reply {
    return Ok(this.secrets.listing(owner));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a secret yours to keep"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"name\":\"...\",\"value\":\"...\",\"destination\":\"https://api.example.com\",\"header\":\"Authorization\",\"category\":\"Payments\"}");
    }
    let made = this.secrets.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    if (!this.secrets.forget(id, owner)) {
      return NotFound("secret " + id);
    }
    return NoContent();
  }
}

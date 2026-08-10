import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, NoContent, NotFound, Ok, Refused } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { apiKeysOf, forgetApiKey, mintApiKey } from "../../api-keys.ts";
import { owningTag } from "../../owner.ts";
import { jsonText } from "../../scan.ts";
import { MintedKey } from "./types.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";

@controller("/api-keys")
@bindings
export class ApiKeyApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return Ok(apiKeysOf(this.db, owningTag(tags)));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a key yours to keep"))
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (req.body == "") {
      return BadRequest("a body is required: {\"name\":\"...\",\"scopes\":\"search,retrieve\"}");
    }
    let made = mintApiKey(this.db, owner,
      jsonText(req.body, "name"),
      jsonText(req.body, "scopes"),
      stamp());
    if (made.problem != "") {
      return BadRequest(made.problem);
    }
    let minted: MintedKey = { id: made.id, secret: made.secret, keyPrefix: made.prefix };
    return Created(JSON.stringify(minted));
  }

  @Delete("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    if (!forgetApiKey(this.db, id, owningTag(callerTags(req)))) {
      return NotFound("key " + id);
    }
    return NoContent();
  }
}

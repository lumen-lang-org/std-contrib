import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, problem } from "../../../rest/server.ts";
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

  constructor(db: Db) { this.db = db; }

  @get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return ok(apiKeysOf(this.db, owningTag(tags)));
  }

  @post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a key yours to keep"))
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"scopes\":\"search,retrieve\"}");
    }
    let made = mintApiKey(this.db, owner,
      jsonText(req.body, "name"),
      jsonText(req.body, "scopes"),
      stamp());
    if (made.problem != "") { return badRequest(made.problem); }
    let minted: MintedKey = { id: made.id, secret: made.secret, keyPrefix: made.prefix };
    return created(JSON.stringify(minted));
  }

  @del("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    if (!forgetApiKey(this.db, id, owningTag(callerTags(req)))) {
      return notFound("key " + id);
    }
    return noContent();
  }
}

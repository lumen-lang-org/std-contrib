import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { apiKeysOf, forgetApiKey, mintApiKey } from "../../api-keys.ts";
import { owningTag } from "../../owner.ts";
import { jsonText } from "../../scan.ts";

// The /api-keys routes.

// The keys a person mints to call Joule's public products from their own code
// (api-keys.ts). Management only — list, mint, revoke — behind the same proxy
// identity every user route trusts. The secret itself is answered once, by
// create, and by nothing else: the store keeps a hash, and so does this API.
@controller("/api-keys")
export class ApiKeyApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // This owner's keys — named and prefixed, never the secret, never the hash.
  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(apiKeysOf(this.db, owningTag(tags)));
  }

  // Mint one. The response carries the secret ONCE — the only time any route
  // returns it — so the console can show it and then forget it, exactly as the
  // row already has.
  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // A key is a standing credential someone's code will carry: it has to
    // belong to a signed-in person, never a guest.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a key yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"scopes\":\"search,retrieve\"}");
    }
    let made = mintApiKey(this.db, owner,
      jsonText(req.body, "name"),
      jsonText(req.body, "scopes"),
      stamp());
    if (made.problem != "") { return badRequest(made.problem); }
    // The secret, this once. Every character is [a-z0-9_-], so it needs no
    // JSON escaping — the id is a uuid, the secret and prefix are "jl_" and
    // hex. Shaped so the console has the id to list by and the prefix it keeps
    // showing after the secret is dismissed.
    let body = "{\"id\":\"" + made.id + "\",\"secret\":\"" + made.secret + "\",\"keyPrefix\":\"" + made.prefix + "\"}";
    return created(body);
  }

  @del("/:id")
  remove(req: Request): Reply {
    // Owner-scoped inside forgetApiKey: somebody else's key is absent, not
    // forbidden.
    if (!forgetApiKey(this.db, param(req, "id"), owningTag(callerTags(req)))) {
      return notFound("key " + param(req, "id"));
    }
    return noContent();
  }
}

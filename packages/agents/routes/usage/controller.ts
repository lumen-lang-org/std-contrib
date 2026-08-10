import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, notFound, ok, queryParam } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { ownerUsage, usageJson } from "../../usage.ts";

// The /usage routes.

// What a tenant has used, for whoever is doing the accounting.
//
// `?owner=` is a filter, never an escalation: a scoped caller may only ask
// about a tag it holds, and asking about somebody else's is the same 404 a
// thread that is not theirs gets. Unscoped — no proxy in front — any tag can
// be asked about, which is the community edition's single-tenant reading of
// the same route.
@controller("/usage")
export class UsageApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    let tags = callerTags(req);
    let want = queryParam(req, "owner", owningTag(tags));
    if (!holdsOwner(tags, want)) { return notFound("owner " + want); }
    return ok(usageJson(ownerUsage(this.db, want)));
  }
}

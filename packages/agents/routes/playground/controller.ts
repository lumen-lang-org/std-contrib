import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, problem } from "../../../rest/server.ts";
import { callerTags, forwardProduct } from "../../api-core.ts";
import { owningTag } from "../../owner.ts";

// The /playground routes.

// The same forward, for a signed-in person trying it from the console. No key:
// the playground is a person at a keyboard, authenticated by the proxy the way
// every other console route is, and the key-scoped door is /v1. A guest is
// asked to sign in rather than served.
@controller("/playground")
export class PlaygroundApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/search")
  search(req: Request): Reply { return this.run(req, "search"); }

  @get("/retrieve")
  retrieve(req: Request): Reply { return this.run(req, "retrieve"); }

  @get("/suggest")
  suggest(req: Request): Reply { return this.run(req, "suggest"); }

  run(req: Request, product: string): Reply {
    if (owningTag(callerTags(req)) == "") {
      return problem(401, "sign in to use the playground");
    }
    return forwardProduct(req, product);
  }
}

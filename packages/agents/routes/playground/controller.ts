import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, Refused } from "../../../rest/server.ts";
import { callerTags, forwardProduct } from "../../api-core.ts";
import { owningTag } from "../../owner.ts";

@controller("/playground")
@bindings
export class PlaygroundApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/search")
  search(req: Request): Reply {
    return this.run(req, "search");
  }

  @Get("/retrieve")
  retrieve(req: Request): Reply {
    return this.run(req, "retrieve");
  }

  @Get("/suggest")
  suggest(req: Request): Reply {
    return this.run(req, "suggest");
  }

  run(req: Request, product: string): Reply {
    if (owningTag(callerTags(req)) == "") {
      return Refused(401, "sign in to use the playground");
    }
    return forwardProduct(req, product);
  }
}

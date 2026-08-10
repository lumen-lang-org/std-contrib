import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, Ok } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { libraryFor } from "../../artifacts.ts";

@controller("/artifacts")
@bindings
export class LibraryApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  list(req: Request): Reply {
    let cards = libraryFor(this.db, callerTags(req), 240);
    let out = "[";
    let i: int = 0;
    while (i < cards.length) {
      if (i > 0) {
        out = out + ",";
      }
      out = out + JSON.stringify(cards[i]);
      i = i + 1;
    }
    return Ok(out + "]");
  }
}

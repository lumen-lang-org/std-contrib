import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, OkJson } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { LibraryService } from "./library.service.ts";

@controller("/artifacts")
@bindings
export class LibraryApi {
  library: LibraryService;

  constructor(database: Db) {
    this.library = new LibraryService(database);
  }

  @Get("/")
  list(@From(callerTags) tags: string[]): Reply {
    return OkJson(this.library.cards(tags));
  }
}

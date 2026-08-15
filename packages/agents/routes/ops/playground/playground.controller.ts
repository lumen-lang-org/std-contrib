import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply } from "../../../../rest/server.ts";
import { signedIn } from "./playground.guard.ts";
import { PlaygroundService } from "./playground.service.ts";
import { PlaygroundCall, playgroundCallOf } from "./playground.utils.ts";

@controller("/playground")
@bindings
export class PlaygroundApi {
  playground: PlaygroundService;

  constructor(database: Db) {
    this.playground = new PlaygroundService(database);
  }

  @Get("/search")
  @Guard(signedIn)
  search(@From(playgroundCallOf) call: PlaygroundCall): Reply {
    return this.playground.forward("search", call);
  }

  @Get("/retrieve")
  @Guard(signedIn)
  retrieve(@From(playgroundCallOf) call: PlaygroundCall): Reply {
    return this.playground.forward("retrieve", call);
  }

  @Get("/suggest")
  @Guard(signedIn)
  suggest(@From(playgroundCallOf) call: PlaygroundCall): Reply {
    return this.playground.forward("suggest", call);
  }
}

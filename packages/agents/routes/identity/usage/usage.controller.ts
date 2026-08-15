import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, Ok } from "../../../../rest/server.ts";
import { callerTags } from "../../../api-core.ts";
import { ownerHeld } from "./usage.guard.ts";
import { UsageService } from "./usage.service.ts";
import { wantedOwner } from "./usage.utils.ts";

@controller("/usage")
@bindings
export class UsageApi {
  usage: UsageService;

  constructor(database: Db) {
    this.usage = new UsageService(database);
  }

  @Get("/")
  @Guard(ownerHeld)
  show(@RequestParam("owner", "") asked: string, @From(callerTags) tags: string[]): Reply {
    return Ok(this.usage.forOwner(wantedOwner(tags, asked)));
  }
}

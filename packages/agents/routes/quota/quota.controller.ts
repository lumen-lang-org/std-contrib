import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, OkJson } from "../../../rest/server.ts";
import { callerTags, guestTag } from "../../api-core.ts";
import { QuotaNone } from "./dtos/quota-none.dto.ts";
import { QuotaService } from "./quota.service.ts";

@controller("/quota")
@bindings
export class QuotaApi {
  quota: QuotaService;

  constructor(database: Db) {
    this.quota = new QuotaService(database);
  }

  @Get("/")
  show(@From(callerTags) tags: string[]): Reply {
    let guest = guestTag(tags);
    if (guest == "") {
      let none: QuotaNone = { limit: 0 };
      return OkJson(none);
    }
    return OkJson(this.quota.forGuest(guest, Date.now()));
  }
}

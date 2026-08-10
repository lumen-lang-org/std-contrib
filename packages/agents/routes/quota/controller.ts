import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, OkJson } from "../../../rest/server.ts";
import { GUEST_DAILY_RUNS, callerTags, guestTag } from "../../api-core.ts";
import { nextUtcMidnightIso, runsSince, utcDayStartText } from "../../usage.ts";
import { QuotaNone, QuotaView } from "./types.ts";

@controller("/quota")
@bindings
export class QuotaApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  show(req: Request): Reply {
    let guest = guestTag(callerTags(req));
    if (guest == "") {
      let none: QuotaNone = { limit: 0 };
      return OkJson(none);
    }
    let now = Date.now();
    let used = runsSince(this.db, guest, utcDayStartText(now));
    let left = GUEST_DAILY_RUNS - used;
    if (left < 0) {
      left = 0;
    }
    let v: QuotaView = { limit: GUEST_DAILY_RUNS, used: used, remaining: left,
      resetsAt: nextUtcMidnightIso(now) };
    return OkJson(v);
  }
}

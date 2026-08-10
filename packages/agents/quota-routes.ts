// The /quota routes.

import { Db } from "../plume/driver.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, ok } from "../rest/server.ts";
import { GUEST_DAILY_RUNS, callerTags, guestTag } from "./api-core.ts";
import { nextUtcMidnightIso, runsSince, utcDayStartText } from "./usage.ts";

// What the day's ceiling looks like from where this caller stands — read once
// at console boot; every send after that carries `guestRemaining` in its own
// reply, so nothing polls this.
//
// A signed-in caller (and the community deployment, which has no gateway and
// no guests) gets `{"limit":0}`: 0 is "no ceiling", and answering it here
// rather than 404ing keeps the console's one boot call unconditional.
@controller("/quota")
export class QuotaApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    let guest = guestTag(callerTags(req));
    if (guest == "") { return ok("{\"limit\":0}"); }
    let now = Date.now();
    let used = runsSince(this.db, guest, utcDayStartText(now));
    let left = GUEST_DAILY_RUNS - used;
    if (left < 0) { left = 0; }
    return ok("{\"limit\":" + `${GUEST_DAILY_RUNS}`
      + ",\"used\":" + `${used}`
      + ",\"remaining\":" + `${left}`
      + ",\"resetsAt\":" + JSON.stringify(nextUtcMidnightIso(now)) + "}");
  }
}

import { Db } from "../plume/driver.ts";
import { Request, Guarded, badRequest, passes, stops } from "../rest/server.ts";
import { callerTags, guestTag } from "./api-core.ts";
import { owningTag } from "./owner.ts";

export function pgOnly(db: Db, said: string): Guarded {
  if (db.name != "postgres") { return stops(badRequest(said)); }
  return passes();
}

export function roleAtLeast(req: Request, role: string): Guarded {
  let tags = callerTags(req);
  if (role == "signed-in") {
    if (guestTag(tags) != "" || (owningTag(tags) == "" && tags.length > 0)) {
      return stops(badRequest("signing in is what makes this yours"));
    }
    return passes();
  }
  if (role == "owner") {
    if (owningTag(tags) == "" && tags.length > 0) {
      return stops(badRequest("this needs an owner"));
    }
    return passes();
  }
  if (role == "guest-ok") { return passes(); }
  return stops(badRequest("unknown role: " + role));
}

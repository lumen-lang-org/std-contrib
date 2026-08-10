import { Db } from "../plume/driver.ts";
import { Request, Guarded, BadRequest, Ok, passes, stops } from "../rest/server.ts";
import { callerTags, guestTag } from "./api-core.ts";
import { owningTag } from "./owner.ts";

export function pgOnly(db: Db, said: string): Guarded {
  if (db.name != "postgres") {
    return stops(BadRequest(said));
  }
  return passes();
}

// Why the refusal sentence is an argument: every route that asks for a signed-in
// caller says why in its own words — a key is yours to keep, a task is yours to
// run — and a single sentence for all of them would be a worse page.
export function roleAtLeast(req: Request, role: string, said: string): Guarded {
  let tags = callerTags(req);
  if (role == "signed-in") {
    if (guestTag(tags) != "" || (owningTag(tags) == "" && tags.length > 0)) {
      return stops(BadRequest(said));
    }
    return passes();
  }
  if (role == "owner") {
    if (owningTag(tags) == "") {
      return stops(BadRequest(said));
    }
    return passes();
  }
  if (role == "guest-ok") {
    return passes();
  }
  return stops(BadRequest("unknown role: " + role));
}

// A caller behind a trusted proxy who is nobody in particular sees an empty
// list rather than a refusal: there is nothing of theirs to show, which is not
// the same as being told no.
export function ownedOrEmpty(req: Request): Guarded {
  let tags = callerTags(req);
  if (owningTag(tags) == "" && tags.length > 0) {
    return stops(Ok("[]"));
  }
  return passes();
}

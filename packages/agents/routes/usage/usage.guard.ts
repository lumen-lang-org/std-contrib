import { Guarded, Request, NotFound, queryParam, reject, resolve } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { holdsOwner } from "../../owner.ts";
import { wantedOwner } from "./usage.utils.ts";

export function ownerHeld(request: Request): Guarded {
  let tags = callerTags(request);
  let want = wantedOwner(tags, queryParam(request, "owner", ""));
  if (!holdsOwner(tags, want)) {
    return reject(NotFound("owner " + want));
  }
  return resolve();
}

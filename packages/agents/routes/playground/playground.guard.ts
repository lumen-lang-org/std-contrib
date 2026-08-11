import { Guarded, Refused, Request, reject, resolve } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { owningTag } from "../../owner.ts";

export function signedIn(request: Request): Guarded {
  if (owningTag(callerTags(request)) == "") {
    return reject(Refused(401, "sign in to use the playground"));
  }
  return resolve();
}

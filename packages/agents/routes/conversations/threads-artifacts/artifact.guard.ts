import { Guarded, Request, NotFound, param, resolve, reject } from "../../../../rest/server.ts";
import { callerTags } from "../../../api-core.ts";
import { ArtifactService } from "./artifact.service.ts";
import { slotFromPath } from "./artifact.utils.ts";

export function threadOwned(artifacts: ArtifactService, request: Request): Guarded {
  let id = param(request, "id");
  if (!artifacts.threadIsOwned(id, callerTags(request))) {
    return reject(NotFound("thread " + id));
  }
  return resolve();
}

/** Reading is wider than writing here.
 *
 *  A conversation offered as a starting point is meant to be looked inside
 *  before it is taken — its transcript already is, and its files are the other
 *  half of what is on offer. Guarding the listing by ownership made a prepared
 *  React project answer "Nothing produced in this conversation yet" to
 *  everyone but nobody. Writing stays on threadOwned: what is readable by all
 *  is still editable only by whoever owns it. */
export function threadReadable(artifacts: ArtifactService, request: Request): Guarded {
  let id = param(request, "id");
  if (!artifacts.threadIsReadable(id, callerTags(request))) {
    return reject(NotFound("thread " + id));
  }
  return resolve();
}

export function artifactAtSlot(artifacts: ArtifactService, request: Request): Guarded {
  let slot = param(request, "slot");
  if (!artifacts.hasSlot(param(request, "id"), slotFromPath(slot))) {
    return reject(NotFound("artifact " + slot));
  }
  return resolve();
}

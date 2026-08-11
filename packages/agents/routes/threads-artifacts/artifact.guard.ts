import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { ArtifactService } from "./artifact.service.ts";
import { slotFromPath } from "./artifact.utils.ts";

export function threadOwned(artifacts: ArtifactService, request: Request): Guarded {
  let id = param(request, "id");
  if (!artifacts.threadIsOwned(id, callerTags(request))) {
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

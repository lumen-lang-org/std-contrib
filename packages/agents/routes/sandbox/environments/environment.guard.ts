import { Guarded, Request, NotFound, param, reject, resolve } from "../../../../rest/server.ts";
import { callerTags, owningCaller } from "../../../api-core.ts";
import { EnvironmentService } from "./environment.service.ts";

export function environmentOwned(environments: EnvironmentService, request: Request): Guarded {
  let id = param(request, "id");
  if (!environments.owns(id, owningCaller(request))) {
    return reject(NotFound("environment " + id));
  }
  return resolve();
}

export function threadEnvironmentOwned(environments: EnvironmentService, request: Request): Guarded {
  let threadId = param(request, "threadId");
  if (!environments.threadOwnedBy(threadId, callerTags(request))) {
    return reject(NotFound("environment " + param(request, "name")));
  }
  return resolve();
}

import { Guarded, Request, NotFound, param, reject, resolve } from "../../../../rest/server.ts";
import { callerTags } from "../../../api-core.ts";
import { roleAtLeast } from "../../../guards.ts";
import { WorkflowService } from "./workflow.service.ts";

export function workflowOwned(workflows: WorkflowService, request: Request): Guarded {
  let id = param(request, "id");
  if (!workflows.owns(id, callerTags(request))) {
    return reject(NotFound("workflow " + id));
  }
  return resolve();
}

export function namedAuthor(request: Request): Guarded {
  return roleAtLeast(request, "signed-in", "signing in is what makes a script yours to compile");
}

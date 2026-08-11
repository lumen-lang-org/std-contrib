import { Guarded, Request, BadRequest, NotFound, param, reject, resolve } from "../../../rest/server.ts";
import { callerTags, guestTag } from "../../api-core.ts";
import { owningTag } from "../../owner.ts";
import { WorkflowService } from "./workflow.service.ts";

export function workflowOwned(workflows: WorkflowService, request: Request): Guarded {
  let id = param(request, "id");
  if (!workflows.owns(id, callerTags(request))) {
    return reject(NotFound("workflow " + id));
  }
  return resolve();
}

export function namedAuthor(request: Request): Guarded {
  let tags = callerTags(request);
  if (owningTag(tags) == "" || guestTag(tags) != "") {
    return reject(BadRequest("signing in is what makes a script yours to compile"));
  }
  return resolve();
}

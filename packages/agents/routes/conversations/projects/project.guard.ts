import { Guarded, Request, NotFound, param, reject, resolve } from "../../../../rest/server.ts";
import { callerTags } from "../../../api-core.ts";
import { ProjectService } from "./project.service.ts";

export function projectOwned(projects: ProjectService, request: Request): Guarded {
  let id = param(request, "id");
  if (!projects.owns(id, callerTags(request))) {
    return reject(NotFound("project " + id));
  }
  return resolve();
}

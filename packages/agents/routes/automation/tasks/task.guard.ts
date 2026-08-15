import { Guarded, Request, NotFound, param, reject, resolve } from "../../../../rest/server.ts";
import { callerTags } from "../../../api-core.ts";
import { TaskService } from "./task.service.ts";

export function taskOwned(tasks: TaskService, request: Request): Guarded {
  let id = param(request, "id");
  if (!tasks.owns(id, callerTags(request))) {
    return reject(NotFound("task " + id));
  }
  return resolve();
}

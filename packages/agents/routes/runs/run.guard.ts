import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { RunService } from "./run.service.ts";

export function runVisible(runs: RunService, request: Request): Guarded {
  let id = param(request, "id");
  if (!runs.canSee(id, callerTags(request))) {
    return reject(NotFound("run " + id));
  }
  return resolve();
}

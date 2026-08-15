import { Guarded, Request, NotFound, param, resolve, reject } from "../../../../rest/server.ts";
import { PreviewService } from "./preview.service.ts";

export function artifactExists(service: PreviewService, request: Request): Guarded {
  let token = param(request, "token");
  if (service.artifactByToken(token).id == "") {
    return reject(NotFound("artifact"));
  }
  return resolve();
}

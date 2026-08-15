import { Guarded, Request, NotFound, param, resolve, reject } from "../../../../rest/server.ts";
import { ModelService } from "./model.service.ts";

export function modelExists(models: ModelService, request: Request): Guarded {
  let id = param(request, "id");
  if (!models.exists(id)) {
    return reject(NotFound("model " + id));
  }
  return resolve();
}

import { Guarded, Request, NotFound, param, resolve, reject } from "../../../../rest/server.ts";
import { ScriptImageService } from "./script-image.service.ts";

export function scriptImageExists(images: ScriptImageService, request: Request): Guarded {
  let id = param(request, "id");
  if (!images.exists(id)) {
    return reject(NotFound("script image " + id));
  }
  return resolve();
}

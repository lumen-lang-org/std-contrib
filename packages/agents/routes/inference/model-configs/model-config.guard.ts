import { Guarded, NotFound, Request, param, reject, resolve } from "../../../../rest/server.ts";
import { ModelConfigService } from "./model-config.service.ts";

export function configExists(configs: ModelConfigService, request: Request): Guarded {
  let id = param(request, "id");
  if (!configs.exists(id)) {
    return reject(NotFound("model config " + id));
  }
  return resolve();
}

import { Guarded, NotFound, Request, param, reject, resolve } from "../../../../rest/server.ts";
import { ModelRouterService } from "./model-router.service.ts";

export function routerExists(routers: ModelRouterService, request: Request): Guarded {
  let id = param(request, "id");
  if (!routers.exists(id)) {
    return reject(NotFound("model router " + id));
  }
  return resolve();
}

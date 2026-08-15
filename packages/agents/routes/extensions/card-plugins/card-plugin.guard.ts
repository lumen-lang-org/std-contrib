import { Guarded, Request, NotFound, param, resolve, reject } from "../../../../rest/server.ts";
import { CardPluginService } from "./card-plugin.service.ts";

export function pluginInstalled(plugins: CardPluginService, request: Request): Guarded {
  let id = param(request, "id");
  if (!plugins.exists(id)) {
    return reject(NotFound("no plugin " + id));
  }
  return resolve();
}

import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { PluginService } from "./plugin.service.ts";

export function pluginExists(plugins: PluginService, request: Request): Guarded {
  let id = param(request, "id");
  if (!plugins.exists(id)) {
    return reject(NotFound("plugin " + id));
  }
  return resolve();
}

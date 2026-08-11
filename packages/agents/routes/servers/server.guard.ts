import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { ServerService } from "./server.service.ts";

export function serverExists(servers: ServerService, request: Request): Guarded {
  let id = param(request, "id");
  if (!servers.exists(id)) {
    return reject(NotFound("server " + id));
  }
  return resolve();
}

export function serverListed(servers: ServerService, request: Request): Guarded {
  let id = param(request, "id");
  if (!servers.exists(id)) {
    return reject(NotFound("no server " + id));
  }
  return resolve();
}

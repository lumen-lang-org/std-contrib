import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { ConnectService } from "./connect.service.ts";

export function connectorExists(connect: ConnectService, request: Request): Guarded {
  let id = param(request, "id");
  if (!connect.exists(id)) {
    return reject(NotFound("server " + id));
  }
  return resolve();
}

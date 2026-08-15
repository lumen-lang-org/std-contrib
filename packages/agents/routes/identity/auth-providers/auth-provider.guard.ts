import { Guarded, Request, NotFound, param, resolve, reject } from "../../../../rest/server.ts";
import { AuthProviderService } from "./auth-provider.service.ts";

export function authProviderExists(authProviders: AuthProviderService, request: Request): Guarded {
  let id = param(request, "id");
  if (!authProviders.exists(id)) {
    return reject(NotFound("auth provider " + id));
  }
  return resolve();
}

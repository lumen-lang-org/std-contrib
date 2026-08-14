import { Guarded, Request, Refused, header, reject, resolve } from "../../../rest/server.ts";
import { hasScope } from "../api-keys/api-key.utils.ts";
import { presentedKey } from "../../search-gateway.ts";
import { V1Service } from "./v1.service.ts";

export function keyScopedFor(v1: V1Service, request: Request, product: string): Guarded {
  let secret = presentedKey(header(request, "authorization"), header(request, "x-api-key"));
  let auth = v1.authorize(secret);
  if (!auth.ok) {
    return reject(Refused(401, "a valid API key is required — send it as \"Authorization: Bearer jl_...\" or an X-API-Key header"));
  }
  if (!hasScope(auth.scopes, product)) {
    return reject(Refused(403, "this key is not scoped for " + product + " — mint one with that scope on the Platform page"));
  }
  return resolve();
}

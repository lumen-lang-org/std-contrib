import { Guarded, Request } from "../../../rest/server.ts";
import { roleAtLeast } from "../../guards.ts";

export function signedIn(request: Request): Guarded {
  return roleAtLeast(request, "signed-in", "sign in to use the playground");
}

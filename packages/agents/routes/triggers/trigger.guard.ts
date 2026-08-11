import { Guarded, Request, NotFound, param, reject, resolve } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { TriggerService } from "./trigger.service.ts";

export function botOwned(triggers: TriggerService, request: Request): Guarded {
  let id = param(request, "id");
  if (!triggers.owns(id, callerTags(request))) {
    return reject(NotFound("bot " + id));
  }
  return resolve();
}

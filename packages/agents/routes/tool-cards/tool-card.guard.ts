import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { ToolCardService } from "./tool-card.service.ts";

export function toolCardExists(cards: ToolCardService, request: Request): Guarded {
  let id = param(request, "id");
  if (!cards.exists(id)) {
    return reject(NotFound("no tool card " + id));
  }
  return resolve();
}

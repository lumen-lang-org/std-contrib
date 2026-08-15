import { Guarded, NotFound, Request, param, reject, resolve } from "../../../../rest/server.ts";
import { ModelChoiceService } from "./model-choice.service.ts";

export function choiceExists(choices: ModelChoiceService, request: Request): Guarded {
  let id = param(request, "id");
  if (!choices.exists(id)) {
    return reject(NotFound("model choice " + id));
  }
  return resolve();
}

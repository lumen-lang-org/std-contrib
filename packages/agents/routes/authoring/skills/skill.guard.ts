import { Guarded, Request, NotFound, param, resolve, Respond, reject } from "../../../../rest/server.ts";
import { filingAs } from "../../../api-core.ts";
import { OWNED_SKILL, ownerOfRow } from "../../../owner.ts";
import { SkillService } from "./skill.service.ts";

export function skillExists(skills: SkillService, request: Request): Guarded {
  let id = param(request, "id");
  if (!skills.exists(id)) {
    return reject(NotFound("skill " + id));
  }
  return resolve();
}

export function skillFileExists(skills: SkillService, request: Request): Guarded {
  let fileId = param(request, "fileId");
  if (!skills.fileExists(fileId)) {
    return reject(NotFound("skill file " + fileId));
  }
  return resolve();
}

/** Whose skill it is. Copying one is how you get your own to edit, so this
 *  refuses rather than silently forking. */
export function skillOwned(skills: SkillService, request: Request): Guarded {
  let id = param(request, "id");
  if (!skills.exists(id)) {
    return reject(NotFound("skill " + id));
  }
  if (ownerOfRow(skills.repository.database, OWNED_SKILL, id) != filingAs(request)) {
    return reject(Respond(403, "{\"error\":\"that skill is not yours — copy it and edit the copy\"}",
      "application/json"));
  }
  return resolve();
}

import { Guarded, Request, NotFound, param, resolve, reject } from "../../../../rest/server.ts";
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

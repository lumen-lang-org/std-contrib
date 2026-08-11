import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { TemplateService } from "./template.service.ts";

export function templateExists(templates: TemplateService, request: Request): Guarded {
  let id = param(request, "id");
  if (!templates.exists(id)) {
    return reject(NotFound("template " + id));
  }
  return resolve();
}

export function templateFileExists(templates: TemplateService, request: Request): Guarded {
  let fileId = param(request, "fileId");
  if (!templates.fileExists(fileId)) {
    return reject(NotFound("template file " + fileId));
  }
  return resolve();
}

export function templateIsPublic(templates: TemplateService, request: Request): Guarded {
  let id = param(request, "id");
  if (!templates.isPublic(id)) {
    return reject(NotFound("template " + id));
  }
  return resolve();
}

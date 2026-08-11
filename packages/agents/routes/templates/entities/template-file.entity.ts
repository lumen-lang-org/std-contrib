import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("template_files")
export class TemplateFile {
  @id
  @column("id", "text")
  id: string;

  @column("template_id", "text")
  templateId: string;

  @column("path", "text")
  path: string;

  @column("title", "text")
  title: string;

  @column("body", "text")
  body: string;

  constructor(id: string, templateId: string, path: string, title: string, body: string) {
    this.id = id;
    this.templateId = templateId;
    this.path = path;
    this.title = title;
    this.body = body;
  }
}

export function templateFileRepository(): DbRepository {
  return entityTemplateFile;
}

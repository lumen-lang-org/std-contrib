import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("template_files")
export class TemplateFile {
  @Id
  @Column("id", "text")
  id: string;

  @Column("template_id", "text")
  templateId: string;

  @Column("path", "text")
  path: string;

  @Column("title", "text")
  title: string;

  @Column("body", "text")
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

import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("office_renders")
export class OfficeRender {
  @Id
  @Column("id", "text")
  id: string;

  @Column("artifact_id", "text")
  artifactId: string;

  @Column("version", "int")
  version: int;

  @Column("body", "text")
  body: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, artifactId: string, version: int, body: string, createdAt: string) {
    this.id = id;
    this.artifactId = artifactId;
    this.version = version;
    this.body = body;
    this.createdAt = createdAt;
  }
}

export function officeRenderRepository(): DbRepository {
  return entityOfficeRender;
}

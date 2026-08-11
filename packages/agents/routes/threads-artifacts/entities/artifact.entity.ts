import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("artifacts")
export class Artifact {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("slot", "int")
  slot: int;

  @Column("path", "text")
  path: string;

  @Column("title", "text")
  title: string;

  @Column("kind", "text")
  kind: string;

  @Column("mime", "text")
  mime: string;

  @Column("current_version", "int")
  currentVersion: int;

  @Column("preview_token", "text")
  previewToken: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, threadId: string, slot: int, path: string, title: string, kind: string,
              mime: string, currentVersion: int, previewToken: string, createdAt: string, updatedAt: string) {
    this.id = id;
    this.threadId = threadId;
    this.slot = slot;
    this.path = path;
    this.title = title;
    this.kind = kind;
    this.mime = mime;
    this.currentVersion = currentVersion;
    this.previewToken = previewToken;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export function artifactRepository(): DbRepository {
  return entityArtifact;
}

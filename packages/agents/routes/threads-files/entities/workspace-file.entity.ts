import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("workspace_files")
export class WorkspaceFile {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("file_name", "text")
  fileName: string;

  @Column("mime", "text")
  mime: string;

  @Column("origin", "text")
  origin: string;

  @Column("body", "text")
  body: string;

  @Column("document_id", "text")
  documentId: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, threadId: string, fileName: string, mime: string, origin: string, body: string, documentId: string, updatedAt: string) {
    this.id = id;
    this.threadId = threadId;
    this.fileName = fileName;
    this.mime = mime;
    this.origin = origin;
    this.body = body;
    this.documentId = documentId;
    this.updatedAt = updatedAt;
  }
}

export function workspaceFileRepository(): DbRepository {
  return entityWorkspaceFile;
}

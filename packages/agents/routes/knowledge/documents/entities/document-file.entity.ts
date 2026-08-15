import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("document_files")
export class DocumentFile {
  @Id
  @Column("id", "text")
  id: string;

  @Column("source", "text")
  source: string;

  @Column("scope", "text")
  scope: string;

  @Column("filename", "text")
  filename: string;

  @Column("mime", "text")
  mime: string;

  @Column("bytes", "text")
  bytes: string;

  @Column("size", "int")
  size: int;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, source: string, scope: string, filename: string, mime: string, bytes: string, size: int, createdAt: string) {
    this.id = id;
    this.source = source;
    this.scope = scope;
    this.filename = filename;
    this.mime = mime;
    this.bytes = bytes;
    this.size = size;
    this.createdAt = createdAt;
  }
}

export function documentFileRepository(): DbRepository {
  return entityDocumentFile;
}

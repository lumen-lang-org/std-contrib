import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("artifact_versions")
export class ArtifactVersion {
  @Id
  @Column("id", "text")
  id: string;

  @Column("artifact_id", "text")
  artifactId: string;

  @Column("version", "int")
  version: int;

  @Column("body", "text")
  body: string;

  @Column("bytes", "int")
  bytes: int;

  @Column("origin", "text")
  origin: string;

  @Column("turn_seq", "int")
  turnSeq: int;

  @Column("note", "text")
  note: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, artifactId: string, version: int, body: string, bytes: int,
              origin: string, turnSeq: int, note: string, createdAt: string) {
    this.id = id;
    this.artifactId = artifactId;
    this.version = version;
    this.body = body;
    this.bytes = bytes;
    this.origin = origin;
    this.turnSeq = turnSeq;
    this.note = note;
    this.createdAt = createdAt;
  }
}

export function artifactVersionRepository(): DbRepository {
  return entityArtifactVersion;
}

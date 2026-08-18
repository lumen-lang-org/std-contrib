import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

export const JOB_QUEUED: string = "queued";
export const JOB_INDEXING: string = "indexing";
export const JOB_INDEXED: string = "indexed";
export const JOB_FAILED: string = "failed";

export type IndexJobRow = {
  id: string,
  owner: string,
  source: string,
  scope: string,
  modelId: string,
  body: string,
  status: string,
  chunks: int,
  error: string,
  createdAt: string,
  updatedAt: string,
};

@entity("index_jobs")
export class IndexJob {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("source", "text")
  source: string;

  @Column("scope", "text")
  scope: string;

  @Column("model_id", "text")
  modelId: string;

  @Column("body", "text")
  body: string;

  @Column("status", "text")
  status: string;

  @Column("chunks", "int")
  chunks: int;

  @Column("error", "text")
  error: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, owner: string, source: string, scope: string, modelId: string, body: string,
              status: string, chunks: int, fault: string, createdAt: string, updatedAt: string) {
    this.id = id;
    this.owner = owner;
    this.source = source;
    this.scope = scope;
    this.modelId = modelId;
    this.body = body;
    this.status = status;
    this.chunks = chunks;
    this.error = fault;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export function indexJobRepository(): DbRepository {
  return entityIndexJob;
}

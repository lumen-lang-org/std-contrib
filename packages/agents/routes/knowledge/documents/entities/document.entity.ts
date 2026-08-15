import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("documents")
export class Document {
  @Id
  @Column("id", "text")
  id: string;

  @Column("source", "text")
  source: string;

  @Column("scope", "text")
  scope: string;

  @Column("body", "text")
  body: string;

  constructor(id: string, source: string, scope: string, body: string) {
    this.id = id;
    this.source = source;
    this.scope = scope;
    this.body = body;
  }
}

export function documentRepository(): DbRepository {
  return entityDocument;
}

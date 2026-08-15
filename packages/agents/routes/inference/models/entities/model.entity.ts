import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("models")
export class Model {
  @Id
  @Column("id", "text")
  id: string;

  @Column("label", "text")
  label: string;

  @Column("api_name", "text")
  apiName: string;

  @Column("provider", "text")
  provider: string;

  @Column("kind", "text")
  kind: string;

  @Column("dimensions", "int")
  dimensions: int;

  @Column("base_url", "text")
  baseUrl: string;

  @Column("context_tokens", "int")
  contextTokens: int;

  @Column("enabled", "bool")
  enabled: bool;

  constructor(id: string, label: string, apiName: string, provider: string, kind: string,
              dimensions: int, baseUrl: string, contextTokens: int, enabled: bool) {
    this.id = id;
    this.label = label;
    this.apiName = apiName;
    this.provider = provider;
    this.kind = kind;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
    this.contextTokens = contextTokens;
    this.enabled = enabled;
  }
}

export function modelRepository(): DbRepository {
  return entityModel;
}

import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("models")
export class Model {
  @id
  @column("id", "text")
  id: string;

  @column("label", "text")
  label: string;

  @column("api_name", "text")
  apiName: string;

  @column("provider", "text")
  provider: string;

  @column("kind", "text")
  kind: string;

  @column("dimensions", "int")
  dimensions: int;

  @column("base_url", "text")
  baseUrl: string;

  @column("context_tokens", "int")
  contextTokens: int;

  @column("enabled", "bool")
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

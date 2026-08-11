import { Rule, validated, OneOf, Required } from "../../../../validation/validation.ts";

@validated
export class ModelAsk {
  @Required("an \"id\" is required")
  id: string;

  @Required("a model needs a label")
  label: string;

  @Required("a model needs the provider's own name for it")
  apiName: string;

  provider: string;

  @Required("a model is chat or embedding")
  @OneOf("chat,embedding", "a model is chat or embedding")
  kind: string;

  dimensions: int;

  baseUrl: string;

  enabled: bool;

  contextTokens: int;

  constructor(id: string, label: string, apiName: string, provider: string,
              kind: string, dimensions: int, baseUrl: string, enabled: bool,
              contextTokens: int) {
    this.id = id;
    this.label = label;
    this.apiName = apiName;
    this.provider = provider;
    this.kind = kind;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
    this.enabled = enabled;
    this.contextTokens = contextTokens;
  }
}

import { validated, Rule } from "../../../../validation/validation.ts";

@validated
export class ModelAsk {
  @required("an \"id\" is required")
  id: string;

  @required("a model needs a label")
  label: string;

  @required("a model needs the provider's own name for it")
  apiName: string;

  provider: string;

  @required("a model is chat or embedding")
  @oneOf("chat,embedding", "a model is chat or embedding")
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

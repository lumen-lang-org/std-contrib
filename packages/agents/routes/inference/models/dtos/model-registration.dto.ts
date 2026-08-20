import { validated, OneOf, Required } from "../../../../../validation/validation.ts";

@validated
export class ModelRegistration {
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

  contextTokens: int;

  temperature: number;

  maxTokens: int;

  topP: number;

  thinking: string;

  constructor(label: string, apiName: string, provider: string, kind: string,
              dimensions: int, baseUrl: string, contextTokens: int,
              temperature: number, maxTokens: int, topP: number,
              thinking: string) {
    this.label = label;
    this.apiName = apiName;
    this.provider = provider;
    this.kind = kind;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
    this.contextTokens = contextTokens;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.topP = topP;
    this.thinking = thinking;
  }
}

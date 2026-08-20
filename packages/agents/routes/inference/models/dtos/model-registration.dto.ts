import { validated, OneOf, Required } from "../../../../../validation/validation.ts";

/** Everything needed to make a model usable, in one body.
 *
 *  There is deliberately no `id` here. Registering a model takes three rows —
 *  the model, a config, and the choice a workflow binds — and a caller made to
 *  invent three ids is a caller who forgets the third, ending up with a model
 *  that answers over /completions and is offered in no picker. The ids are
 *  minted on this side instead. */
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

  /* The config knobs an operator actually turns. Left at zero they fall back to
     the defaults in register() rather than being written as zero: a maxTokens
     of 0 is a model that returns nothing, which is the kind of setting that
     looks like a broken model rather than a bad value. */
  temperature: number;

  maxTokens: int;

  topP: number;

  /* "off" for a reasoning model you do not want reasoning from. A model that
     thinks until its budget runs out returns an empty answer, not an error. */
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

import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("model_configs")
export class ModelConfig {
  @id
  @column("id", "text")
  id: string;

  @column("model_id", "text")
  modelId: string;

  @column("temperature", "float8")
  temperature: number;

  @column("max_tokens", "int")
  maxTokens: int;

  @column("top_p", "float8")
  topP: number;

  @column("extra", "text")
  extra: string;

  @column("thinking", "text")
  thinking: string;

  @column("label", "text")
  label: string;

  @column("selectable", "bool")
  selectable: bool;

  @column("menu_rank", "int")
  rank: int;

  @hasOne("models", "model_id", "id", "id, label, api_name AS \"apiName\", provider, {bool:enabled} AS \"enabled\"")
  model: string;

  constructor(id: string, modelId: string, temperature: number, maxTokens: int, topP: number,
              extra: string, thinking: string, label: string, selectable: bool, rank: int,
              model: string) {
    this.id = id;
    this.modelId = modelId;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.topP = topP;
    this.extra = extra;
    this.thinking = thinking;
    this.label = label;
    this.selectable = selectable;
    this.rank = rank;
    this.model = model;
  }
}

export function modelConfigRepository(): DbRepository {
  return entityModelConfig;
}

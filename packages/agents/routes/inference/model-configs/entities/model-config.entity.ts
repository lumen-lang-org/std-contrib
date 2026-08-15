import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("model_configs")
export class ModelConfig {
  @Id
  @Column("id", "text")
  id: string;

  @Column("model_id", "text")
  modelId: string;

  @Column("temperature", "float8")
  temperature: number;

  @Column("max_tokens", "int")
  maxTokens: int;

  @Column("top_p", "float8")
  topP: number;

  @Column("extra", "text")
  extra: string;

  @Column("thinking", "text")
  thinking: string;

  @Column("label", "text")
  label: string;

  @Column("selectable", "bool")
  selectable: bool;

  @Column("menu_rank", "int")
  rank: int;

  @HasOne("models", "model_id", "id", "id, label, api_name AS \"apiName\", provider, {bool:enabled} AS \"enabled\"")
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

import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("model_choices")
export class ModelChoice {
  @id
  @column("id", "text")
  id: string;

  @column("label", "text")
  label: string;

  @column("description", "text")
  description: string;

  @column("kind", "text")
  kind: string;

  @column("config_id", "text")
  configId: string;

  @column("router_id", "text")
  routerId: string;

  @column("tier", "text")
  tier: string;

  @column("enabled", "bool")
  enabled: bool;

  @column("menu_rank", "int")
  rank: int;

  constructor(id: string, label: string, description: string, kind: string, configId: string,
              routerId: string, tier: string, enabled: bool, rank: int) {
    this.id = id;
    this.label = label;
    this.description = description;
    this.kind = kind;
    this.configId = configId;
    this.routerId = routerId;
    this.tier = tier;
    this.enabled = enabled;
    this.rank = rank;
  }
}

export function modelChoiceRepository(): DbRepository {
  return entityModelChoice;
}

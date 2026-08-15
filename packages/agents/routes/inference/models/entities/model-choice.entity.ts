import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("model_choices")
export class ModelChoice {
  @Id
  @Column("id", "text")
  id: string;

  @Column("label", "text")
  label: string;

  @Column("description", "text")
  description: string;

  @Column("kind", "text")
  kind: string;

  @Column("config_id", "text")
  configId: string;

  @Column("router_id", "text")
  routerId: string;

  @Column("tier", "text")
  tier: string;

  @Column("enabled", "bool")
  enabled: bool;

  @Column("menu_rank", "int")
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

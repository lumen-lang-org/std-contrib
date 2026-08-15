import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("model_routers")
export class ModelRouter {
  @Id
  @Column("id", "text")
  id: string;

  @Column("label", "text")
  label: string;

  @Column("router_config_id", "text")
  routerConfigId: string;

  @Column("candidates_json", "text")
  candidatesJson: string;

  @Column("fallback_config_id", "text")
  fallbackConfigId: string;

  @Column("route_every", "text")
  routeEvery: string;

  @Column("escalate_only", "bool")
  escalateOnly: bool;

  @Column("enabled", "bool")
  enabled: bool;

  constructor(id: string, label: string, routerConfigId: string, candidatesJson: string,
              fallbackConfigId: string, routeEvery: string, escalateOnly: bool, enabled: bool) {
    this.id = id;
    this.label = label;
    this.routerConfigId = routerConfigId;
    this.candidatesJson = candidatesJson;
    this.fallbackConfigId = fallbackConfigId;
    this.routeEvery = routeEvery;
    this.escalateOnly = escalateOnly;
    this.enabled = enabled;
  }
}

export function modelRouterRepository(): DbRepository {
  return entityModelRouter;
}

import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("tool_cards")
export class ToolCard {
  @Id
  @Column("id", "text")
  id: string;

  @Column("plugin_id", "text")
  pluginId: string;

  @Column("tool_name", "text")
  toolName: string;

  @Column("marker", "text")
  marker: string;

  @Column("payload", "text")
  payload: string;

  @Column("hint", "text")
  hint: string;

  @Column("enabled", "bool")
  enabled: bool;

  constructor(id: string, pluginId: string, toolName: string, marker: string, payload: string,
              hint: string, enabled: bool) {
    this.id = id;
    this.pluginId = pluginId;
    this.toolName = toolName;
    this.marker = marker;
    this.payload = payload;
    this.hint = hint;
    this.enabled = enabled;
  }
}

export function toolCardRepository(): DbRepository {
  return entityToolCard;
}

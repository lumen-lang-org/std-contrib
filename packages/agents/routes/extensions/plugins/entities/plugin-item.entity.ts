import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("plugin_items")
export class PluginItem {
  @Id
  @Column("id", "text")
  id: string;

  @Column("plugin_id", "text")
  pluginId: string;

  @Column("kind", "text")
  kind: string;

  @Column("item_id", "text")
  itemId: string;

  constructor(id: string, pluginId: string, kind: string, itemId: string) {
    this.id = id;
    this.pluginId = pluginId;
    this.kind = kind;
    this.itemId = itemId;
  }
}

export function pluginItemRepository(): DbRepository {
  return entityPluginItem;
}

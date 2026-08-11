import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("plugin_items")
export class PluginItem {
  @id
  @column("id", "text")
  id: string;

  @column("plugin_id", "text")
  pluginId: string;

  @column("kind", "text")
  kind: string;

  @column("item_id", "text")
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

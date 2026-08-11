import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("plugins")
export class Plugin {
  @id
  @column("id", "text")
  id: string;

  @column("plugin_name", "text")
  pluginName: string;

  @column("description", "text")
  description: string;

  @column("source_url", "text")
  sourceUrl: string;

  @column("version", "text")
  version: string;

  @column("installed_at", "text")
  installedAt: string;

  constructor(id: string, pluginName: string, description: string, sourceUrl: string,
              version: string, installedAt: string) {
    this.id = id;
    this.pluginName = pluginName;
    this.description = description;
    this.sourceUrl = sourceUrl;
    this.version = version;
    this.installedAt = installedAt;
  }
}

export function pluginRepository(): DbRepository {
  return entityPlugin;
}

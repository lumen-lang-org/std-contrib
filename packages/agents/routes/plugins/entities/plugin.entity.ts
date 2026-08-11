import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("plugins")
export class Plugin {
  @Id
  @Column("id", "text")
  id: string;

  @Column("plugin_name", "text")
  pluginName: string;

  @Column("description", "text")
  description: string;

  @Column("source_url", "text")
  sourceUrl: string;

  @Column("version", "text")
  version: string;

  @Column("installed_at", "text")
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

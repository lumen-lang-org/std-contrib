import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("card_plugins")
export class CardPlugin {
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

  @Column("renderer_url", "text")
  rendererUrl: string;

  @Column("renderer_source", "text")
  rendererSource: string;

  @Column("enabled", "bool")
  enabled: bool;

  @Column("installed_at", "text")
  installedAt: string;

  constructor(id: string, pluginName: string, description: string, sourceUrl: string,
              version: string, rendererUrl: string, rendererSource: string, enabled: bool,
              installedAt: string) {
    this.id = id;
    this.pluginName = pluginName;
    this.description = description;
    this.sourceUrl = sourceUrl;
    this.version = version;
    this.rendererUrl = rendererUrl;
    this.rendererSource = rendererSource;
    this.enabled = enabled;
    this.installedAt = installedAt;
  }
}

export function cardPluginRepository(): DbRepository {
  return entityCardPlugin;
}

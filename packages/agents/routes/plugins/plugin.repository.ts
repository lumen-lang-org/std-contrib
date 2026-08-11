import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, existsById, findById, listOrdered, listWhere } from "../../../plume/plume.ts";
import { Manifest, install, installFault, uninstall } from "../../plugins.ts";
import { mcpServerRepository } from "../servers/entities/mcp-server.entity.ts";
import { skillRepository } from "../skills/entities/skill.entity.ts";
import { PluginItemBody } from "./dtos/plugin-item-body.dto.ts";
import { pluginItemRepository } from "./entities/plugin-item.entity.ts";
import { pluginRepository } from "./entities/plugin.entity.ts";

export class PluginRepository {
  database: Db;
  plugins: DbRepository;
  pluginItems: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.plugins = pluginRepository();
    this.pluginItems = pluginItemRepository();
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "plugin_name" }];
    return listOrdered(this.database, this.plugins, { order: keys });
  }

  one(id: string): string {
    return findById(this.database, this.plugins, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.plugins, id);
  }

  items(pluginId: string): PluginItemBody[] {
    let held = listWhere(this.database, this.pluginItems,
      "plugin_id = " + this.database.placeholder, [pluginId]);
    if (held == "" || held == "[]") {
      let none: PluginItemBody[] = [];
      return none;
    }
    return JSON.parse<PluginItemBody[]>(held);
  }

  skill(id: string): string {
    return findById(this.database, skillRepository(), id);
  }

  server(id: string): string {
    return findById(this.database, mcpServerRepository(), id);
  }

  clash(manifest: Manifest): string {
    return installFault(this.database, manifest);
  }

  installFrom(manifest: Manifest, sourceUrl: string, now: string): string {
    return install(this.database, manifest, sourceUrl, now).id;
  }

  forget(id: string): void {
    uninstall(this.database, id);
  }
}

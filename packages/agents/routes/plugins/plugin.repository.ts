import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, countWhere, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { Manifest, PluginRow } from "./plugin.utils.ts";
import { ServerBody } from "../servers/dtos/server-body.dto.ts";
import { mcpServerRepository } from "../servers/entities/mcp-server.entity.ts";
import { SkillBody } from "../skills/dtos/skill-body.dto.ts";
import { SkillFileBody } from "../skills/dtos/skill-file-body.dto.ts";
import { skillRepository } from "../skills/entities/skill.entity.ts";
import { skillFileRepository } from "../skills/entities/skill-file.entity.ts";
import { PluginItemBody } from "./dtos/plugin-item-body.dto.ts";
import { pluginItemRepository } from "./entities/plugin-item.entity.ts";
import { pluginRepository } from "./entities/plugin.entity.ts";

function emptyPlugin(): PluginRow {
  let none: PluginRow = {
    id: "", pluginName: "", description: "", sourceUrl: "", version: "", installedAt: "",
  };
  return none;
}

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
    if (countWhere(this.database, this.plugins, "plugin_name = " + placeholderAt(this.database, 1), [manifest.pluginName]) > 0) {
      return "\"" + manifest.pluginName + "\" is already installed — remove it first to install it again";
    }
    let i: int = 0;
    while (i < manifest.skills.length) {
      if (countWhere(this.database, skillRepository(), "skill_name = " + placeholderAt(this.database, 1), [manifest.skills[i].skillName]) > 0) {
        return "a skill called \"" + manifest.skills[i].skillName + "\" already exists here; rename it, or remove it, before installing this plugin";
      }
      i = i + 1;
    }
    let c: int = 0;
    while (c < manifest.connectors.length) {
      if (countWhere(this.database, mcpServerRepository(), "server_name = " + placeholderAt(this.database, 1), [manifest.connectors[c].serverName]) > 0) {
        return "a connector called \"" + manifest.connectors[c].serverName + "\" already exists here";
      }
      c = c + 1;
    }
    return "";
  }

  private receipt(pluginId: string, kind: string, itemId: string): void {
    let row: PluginItemBody = {
      id: crypto.randomUUID(),
      pluginId: pluginId,
      kind: kind,
      itemId: itemId,
    };
    persist(this.database, this.pluginItems, JSON.stringify(row));
  }

  installFrom(manifest: Manifest, sourceUrl: string, now: string): string {
    let plugin: PluginRow = {
      id: crypto.randomUUID(),
      pluginName: manifest.pluginName,
      description: manifest.description,
      sourceUrl: sourceUrl,
      version: manifest.version,
      installedAt: now,
    };
    let written = persist(this.database, this.plugins, JSON.stringify(plugin));
    if (!written.ok) {
      return emptyPlugin().id;
    }

    let i: int = 0;
    while (i < manifest.skills.length) {
      let seed = manifest.skills[i];
      let skill: SkillBody = {
        id: crypto.randomUUID(),
        skillName: seed.skillName,
        description: seed.description,
        body: seed.body,
        updatedAt: now,
        visibility: "private",
        featuredRank: 0,
        source: "repo",
        sourceUrl: sourceUrl,
      };
      persist(this.database, skillRepository(), JSON.stringify(skill));
      this.receipt(plugin.id, "skill", skill.id);
      let f: int = 0;
      while (f < seed.files.length) {
        let file: SkillFileBody = {
          id: crypto.randomUUID(),
          skillId: skill.id,
          path: seed.files[f].path,
          body: seed.files[f].body,
        };
        persist(this.database, skillFileRepository(), JSON.stringify(file));
        f = f + 1;
      }
      i = i + 1;
    }

    let c: int = 0;
    while (c < manifest.connectors.length) {
      let seed = manifest.connectors[c];
      let server: ServerBody = {
        id: crypto.randomUUID(),
        serverName: seed.serverName,
        transport: "http",
        endpoint: seed.endpoint,
        authKind: seed.authKind,
        authHeader: seed.authHeader,
        enabled: false,
      };
      persist(this.database, mcpServerRepository(), JSON.stringify(server));
      this.receipt(plugin.id, "connector", server.id);
      c = c + 1;
    }
    return plugin.id;
  }

  forget(id: string): void {
    let held = listWhere(this.database, this.pluginItems,
      "plugin_id = " + this.database.placeholder, [id]);
    let items: PluginItemBody[] = held == "" || held == "[]" ? [] : JSON.parse<PluginItemBody[]>(held);
    let i: int = 0;
    while (i < items.length) {
      if (items[i].kind == "skill") {
        let files = listWhere(this.database, skillFileRepository(),
          "skill_id = " + this.database.placeholder, [items[i].itemId]);
        if (files != "" && files != "[]") {
          let rows: SkillFileBody[] = JSON.parse<SkillFileBody[]>(files);
          let f: int = 0;
          while (f < rows.length) {
            deleteById(this.database, skillFileRepository(), rows[f].id);
            f = f + 1;
          }
        }
        deleteById(this.database, skillRepository(), items[i].itemId);
      }
      if (items[i].kind == "connector") {
        deleteById(this.database, mcpServerRepository(), items[i].itemId);
      }
      deleteById(this.database, this.pluginItems, items[i].id);
      i = i + 1;
    }
    deleteById(this.database, this.plugins, id);
  }
}

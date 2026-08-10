import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, asc, createTableSql, field, listOrdered, listWhere, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export type CardPluginRow = {
  id: string,
  pluginName: string,
  description: string,
  sourceUrl: string,
  version: string,
  rendererUrl: string,
  rendererSource: string,
  enabled: bool,
  installedAt: string,
};

export type CardCaseRow = {
  id: string,
  pluginId: string,
  when: string,
  then: string,
};

export function cardPluginsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("pluginName", "plugin_name", "text"),
    field("description", "description", "text"),
    field("sourceUrl", "source_url", "text"),
    field("version", "version", "text"),
    field("rendererUrl", "renderer_url", "text"),
    field("rendererSource", "renderer_source", "text"),
    field("enabled", "enabled", "bool"),
    field("installedAt", "installed_at", "text"),
  ];
  return repository("card_plugins", "id", "id", fs);
}

export function cardCasesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("pluginId", "plugin_id", "text"),
    field("when", "when_asked", "text"),
    field("then", "then_do", "text"),
  ];
  return repository("card_cases", "id", "id", fs);
}

function cardPluginsMappingAsCreated(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("pluginName", "plugin_name", "text"),
    field("description", "description", "text"),
    field("sourceUrl", "source_url", "text"),
    field("version", "version", "text"),
    field("enabled", "enabled", "bool"),
    field("installedAt", "installed_at", "text"),
  ];
  return repository("card_plugins", "id", "id", fs);
}

export function cardPluginsPlan(db: Db): Migration[] {
  return [
    migration("97.1", "a card plugin: cards, cases and where it came from",
      createTableSql(db, cardPluginsMappingAsCreated())),
    migration("97.2", "when to reach for a plugin's cards",
      createTableSql(db, cardCasesMapping())),
    migration("97.3", "where a plugin's renderers are fetched from",
      "ALTER TABLE card_plugins ADD COLUMN renderer_url " + db.textType + " NOT NULL DEFAULT ''"),
    migration("97.4", "the renderer itself, snapshotted at install",
      "ALTER TABLE card_plugins ADD COLUMN renderer_source " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

export function allCardPlugins(db: Db): CardPluginRow[] {
  return JSON.parse<CardPluginRow[]>(
    listOrdered(db, cardPluginsMapping(), "", [], [asc("plugin_name")]));
}

export function pluginOn(db: Db, pluginId: string): bool {
  if (pluginId == "") { return true; }
  let rows = JSON.parse<CardPluginRow[]>(listWhere(db, cardPluginsMapping(),
    "id = " + db.placeholder, [pluginId]));
  if (rows.length == 0) { return false; }
  return rows[0].enabled;
}

export function casesBriefing(db: Db): string {
  let plugins = allCardPlugins(db);
  let lines: string[] = [];
  let p: int = 0;
  while (p < plugins.length) {
    if (plugins[p].enabled) {
      let cases = JSON.parse<CardCaseRow[]>(listWhere(db, cardCasesMapping(),
        "plugin_id = " + db.placeholder, [plugins[p].id]));
      let c: int = 0;
      while (c < cases.length) {
        if (cases[c].when != "" && cases[c].then != "") {
          lines.push("- When the question is about " + cases[c].when + ": " + cases[c].then + ".");
        }
        c = c + 1;
      }
    }
    p = p + 1;
  }
  if (lines.length == 0) { return ""; }
  return "This deployment draws some answers as cards instead of prose:\n"
    + lines.join("\n")
    + "\nThe card is rendered from the tool's own result, so never copy figures "
    + "out of it into your text — call the tool, then emit the marker.";
}

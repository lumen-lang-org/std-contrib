import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, field, listOrdered, listWhere, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { pluginOn } from "./plugincards.ts";

export type ToolCardRow = {
  id: string,
  pluginId: string,
  toolName: string,
  marker: string,
  payload: string,
  hint: string,
  enabled: bool,
};

export function toolCardsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("pluginId", "plugin_id", "text"),
    field("toolName", "tool_name", "text"),
    field("marker", "marker", "text"),
    field("payload", "payload", "text"),
    field("hint", "hint", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "tool_cards", idField: "id", idColumn: "id", fields: fs });
}

export function toolCardsPlan(db: Db): Migration[] {
  return [
    migration("96", "tool results the console draws as cards",
      createTableSql(db, toolCardsMapping())),
  ];
}

export function cardHintFor(db: Db, toolName: string): string {
  let rows = JSON.parse<ToolCardRow[]>(listWhere(db, toolCardsMapping(),
    "tool_name = " + db.placeholder, [toolName]));
  let i: int = 0;
  while (i < rows.length) {
    let row = rows[i];
    if (row.enabled && row.marker != "" && pluginOn(db, row.pluginId)) {
      if (row.hint != "") { return "\n\n" + row.hint; }
      return "\n\nWhen you answer, do not restate or list these fields. Emit "
        + "exactly one line, alone: [" + row.marker + "]" + row.payload
        + "[/" + row.marker + "] — the console renders this from the tool "
        + "result. Add at most one short sentence of your own before it.";
    }
    i = i + 1;
  }
  return "";
}

export function cardClaims(db: Db, toolName: string): bool {
  let rows = JSON.parse<ToolCardRow[]>(listWhere(db, toolCardsMapping(),
    "tool_name = " + db.placeholder, [toolName]));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].enabled && rows[i].marker != "" && pluginOn(db, rows[i].pluginId)) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function allToolCards(db: Db): ToolCardRow[] {
  return JSON.parse<ToolCardRow[]>(listOrdered(db, toolCardsMapping(), { order: [{ column: "tool_name" }] }));
}

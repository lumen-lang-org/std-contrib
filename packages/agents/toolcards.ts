// Which tool results the console draws instead of restating.
//
// A connector answers in JSON — a cycle, a list of tickets, a build, an
// invoice — and a model asked to relay that JSON in prose writes bullet soup:
// accurate, long, and unread. The console can draw it properly, but only if
// the model emits a marker instead of the prose, and the model only does that
// if it is told to on the result of the call that produced the data (recency
// is what a small model follows).
//
// The first version of this was two `if (name == "list_cycles")` branches in
// run.ts, which is the wrong place in the obvious way: the engine does not
// know what Linear is, and should not learn. This table is that knowledge,
// moved out of the code and into a row anybody can add — which is also what
// makes a card installable, since a plugin is then a row plus a renderer the
// console fetches rather than a patch to this package.
//
// Nothing here renders anything. A row is a *hint*: the tool that carries the
// data, the marker the model should emit, and the sentence telling it to. The
// console owns the drawing (app/src/cards.ts), reads the numbers out of the
// tool result itself, and shows the model's line as ordinary text when it has
// no renderer for that marker — an unknown card degrades to a visible line,
// never to a blank.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, asc, createTableSql, field, listOrdered, listWhere, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { pluginOn } from "./plugincards.ts";

export type ToolCardRow = {
  id: string,
  // The plugin that installed this card, or "" for one added by hand. A card
  // whose plugin is switched off is inert without being deleted — see
  // pluginOn in plugincards.ts.
  pluginId: string,
  // The tool whose successful result should carry the hint — matched exactly,
  // and only on success. "list_cycles", "list_issues", "get_build".
  toolName: string,
  // What the model is asked to emit, e.g. "LINEAR_CYCLE". The console looks up
  // its renderer by this name; an unknown one simply never becomes a card.
  marker: string,
  // The short JSON the model puts inside the marker — its own contribution,
  // which is a heading or a name and never a number. Written as the example
  // the model copies, because copying an example is the one thing every model
  // size does reliably.
  payload: string,
  // The sentence appended to the tool result. Empty means the default below,
  // which is what a row added through the API without one gets.
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
  return repository("tool_cards", "id", "id", fs);
}

export function toolCardsPlan(db: Db): Migration[] {
  return [
    migration("96", "tool results the console draws as cards",
      createTableSql(db, toolCardsMapping())),
  ];
}

/** The hint to append to a successful result from this tool, or "".
 *
 *  One query per successful tool call, and only when a row exists — a
 *  deployment with no cards configured pays a lookup and nothing else. */
export function cardHintFor(db: Db, toolName: string): string {
  let rows = JSON.parse<ToolCardRow[]>(listWhere(db, toolCardsMapping(),
    "tool_name = " + db.placeholder, [toolName]));
  let i: int = 0;
  while (i < rows.length) {
    let row = rows[i];
    if (row.enabled && row.marker != "" && pluginOn(db, row.pluginId)) {
      if (row.hint != "") { return "\n\n" + row.hint; }
      // The default, written once here rather than copied into every row: do
      // not restate, emit exactly this line, keep your own words short.
      return "\n\nWhen you answer, do not restate or list these fields. Emit "
        + "exactly one line, alone: [" + row.marker + "]" + row.payload
        + "[/" + row.marker + "] — the console renders this from the tool "
        + "result. Add at most one short sentence of your own before it.";
    }
    i = i + 1;
  }
  return "";
}

/** Whether a card draws this tool's result.
 *
 *  Asked when a step is stored, to decide whether the result may be kept
 *  whole — see `resultCeiling` in steps.ts. Separate from `cardHintFor`
 *  because the two questions have different answers at different moments:
 *  the hint is appended to what the MODEL reads, and this decides what the
 *  CONSOLE is later able to draw from. */
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

/** Every card row, for the console's registry and the operator's page. */
export function allToolCards(db: Db): ToolCardRow[] {
  return JSON.parse<ToolCardRow[]>(listOrdered(db, toolCardsMapping(), "", [], [asc("tool_name")]));
}

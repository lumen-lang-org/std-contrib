// A card plugin: what to draw, how to get it, and when.
//
// `toolcards.ts` next door holds one row per drawable tool result, which is
// enough to render a cycle and not enough to be a plugin. A person installing
// "Linear cards" is not installing a marker; they are installing a small body
// of knowledge — these three tools carry the data, this is how you get to
// them, and these are the questions where drawing beats prose. Split across
// unrelated rows, that knowledge cannot be installed, listed, disabled, or
// removed as one thing, which is what "add a plugin" means.
//
// So a card plugin is a row in `card_plugins` and its parts point back at it:
//
//   card_plugins   the thing you install, enable, and remove
//     ├─ tool_cards      (plugin_id) which results become which markers
//     └─ card_cases      (plugin_id) when to reach for them, in the prompt
//
// The division of labour with the model is unchanged and is the point of the
// whole design: the model emits a marker and a heading, and every number, id
// and url in the drawn card is read by the console out of the tool result
// itself. A plugin can therefore add capability without adding a way for a
// model to get facts wrong.
//
// What a plugin does NOT hold: a renderer. The console looks one up by marker
// (app/src/cards.ts), and a marker it has no renderer for degrades to the
// model's own visible line. That keeps the engine free of presentation and
// keeps an install from being able to inject markup into a transcript.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, asc, createTableSql, field, listOrdered, listWhere, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export type CardPluginRow = {
  id: string,
  // What it is called in the list somebody manages it from.
  pluginName: string,
  description: string,
  // Where it came from, when it came from anywhere: a url, a marketplace id,
  // or "" for one written here. Kept so an install can be traced back to what
  // was installed, which is the first question when a card draws wrongly.
  sourceUrl: string,
  version: string,
  // Where the console fetches this plugin's renderers from — an ES module on
  // a CDN, not code compiled into the console. Empty for a plugin whose
  // markers the console already draws.
  //
  // This is the line the whole "a plugin is installable" claim rests on: with
  // renderers compiled in, adding a card means shipping the console, and the
  // manifest is only half a plugin. It is also the line that makes a plugin
  // able to put markup of its author's choosing inside a transcript — see
  // app/src/plugin-cards.ts for the sandbox that contains it; installing one
  // is a deliberate act by an operator, the same trust as attaching a
  // connector.
  rendererUrl: string,
  // The renderer's SOURCE, snapshotted at install and served to the console
  // from here — the console never fetches the CDN. What this buys, in order:
  // integrity (the code that runs is the code the operator installed, not
  // whatever the URL serves today), availability (a CDN outage cannot take
  // cards down), and no CSP widening (the console loads renderers from its
  // own origin). The url above is provenance; this is the artifact. A new
  // version is a reinstall, which is the point — an install is a decision.
  rendererSource: string,
  // Off without being uninstalled: the rows stay, nothing is briefed, no
  // result carries a hint. The state a person wants while working out whether
  // a plugin is what is making the model behave oddly.
  enabled: bool,
  installedAt: string,
};

/** When to reach for this plugin's cards, in the model's own briefing.
 *
 *  The "cases" half. A card hint (toolcards.ts) rides the RESULT of a call
 *  that already happened, which is perfect for "draw this rather than restate
 *  it" and useless for "this question is one of ours" — by then the model has
 *  already chosen prose and a tool. A case is the other end: one line in the
 *  system prompt saying what kind of question this plugin answers and which
 *  tool starts it.
 *
 *  One line each, deliberately. A plugin that writes a paragraph into every
 *  conversation is a plugin that has taken the context budget from the
 *  conversation, and the budget is what the answer is drawn from. */
export type CardCaseRow = {
  id: string,
  pluginId: string,
  // The kind of question, in the words a person would use: "sprint or cycle
  // progress", "what is assigned to me".
  when: string,
  // What to do about it: "call list_cycles, then emit [LINEAR_CYCLE]".
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

/* The table as 97.1 CREATED it, before either renderer column existed.
 *
 * A migration generated from the live mapping changes whenever the mapping
 * grows a field, and an applied migration whose SQL changes is exactly what
 * the checksum guard refuses the next boot. So the applied migration keeps
 * its own frozen copy of the shape it made, and every later field arrives by
 * ALTER in its own migration — the rule schema.ts already follows for the
 * agents table, learned here the same way. */
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
    // Added rather than folded into 97.1: that migration is applied on a
    // running deployment and its checksum is what stops an edit to an applied
    // migration going unnoticed. A new column is a new migration.
    migration("97.3", "where a plugin's renderers are fetched from",
      "ALTER TABLE card_plugins ADD COLUMN renderer_url " + db.textType + " NOT NULL DEFAULT ''"),
    migration("97.4", "the renderer itself, snapshotted at install",
      "ALTER TABLE card_plugins ADD COLUMN renderer_source " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

/** Every installed plugin, newest name first. */
export function allCardPlugins(db: Db): CardPluginRow[] {
  return JSON.parse<CardPluginRow[]>(
    listOrdered(db, cardPluginsMapping(), "", [], [asc("plugin_name")]));
}

/** Whether this plugin is installed and switched on. A card or a case whose
 *  plugin is off is inert without being deleted — and a row with no plugin at
 *  all is live, which is what a hand-written card added straight through
 *  /tool-cards is. */
export function pluginOn(db: Db, pluginId: string): bool {
  if (pluginId == "") { return true; }
  let rows = JSON.parse<CardPluginRow[]>(listWhere(db, cardPluginsMapping(),
    "id = " + db.placeholder, [pluginId]));
  if (rows.length == 0) { return false; }
  return rows[0].enabled;
}

/** The cases of every enabled plugin, as the lines that go in the prompt.
 *
 *  Empty when nothing is installed, which is the ordinary deployment — a box
 *  with no card plugins adds not one token to any conversation. */
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

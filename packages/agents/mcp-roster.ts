// What a connector last said it could do.
//
// A connector's tool list is behind the same door as its data: every hosted
// server on the shelf answers `tools/list` with 401 until somebody has signed
// in. So a workflow step that names a connector cannot offer its tools until
// the connection exists, and the Connector panel had nothing to draw but
// "not signed in to linear" — true, and a dead end.
//
// This is the middle answer. The listing is cached the moment a real one
// succeeds, so afterwards the panel has real tool names even when the server
// is unreachable, the token has gone stale, or the person editing the workflow
// is not the person who connected it.
//
// --- the rule that keeps a cache from becoming a lie -------------------------
//
// A live listing always wins. `workflows.ts` already says why: a picker over
// yesterday's tools offers a call the server no longer answers. So this is
// never consulted while a live listing is available, and when it is consulted
// the answer carries `listedAt` so the screen can say "as of 3 August" rather
// than implying it just asked. A cache that cannot be told apart from a fresh
// answer is worse than no cache.
//
// Name and description only. The schema is the biggest part of a listing and
// the only caller that needs it is the run loop, which has a live listing in
// hand by then — storing it would multiply the row size for nobody.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, deleteById, field, findById, persist, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { McpTool } from "./mcp.ts";

// A connector with more tools than this is unusual, and a row that grows
// without bound is the one that eventually will not load.
export const MAX_REMEMBERED_TOOLS: int = 200;

export type McpRosterRow = {
  // The server's id. One roster per connector.
  id: string,
  // The tools as JSON text: [{"name":...,"description":...}]. Text and not a
  // record array because plume maps columns, not documents, and this is one
  // column whose shape is the console's business.
  tools: string,
  // When the listing that produced this actually happened, so a screen can
  // date it rather than pass it off as current.
  listedAt: string,
};

export function mcpRosterMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("tools", "tools", "text"),
    field("listedAt", "listed_at", "text"),
  ];
  return repository("mcp_tool_roster", "id", "id", fs);
}

export function mcpRosterPlan(db: Db): Migration[] {
  // 113: the highest in the tree is env-templates' 112, and a migration that
  // sorts below one already applied refuses the whole plan.
  return [
    migration("113", "what a connector last said it could do",
      createTableSqlV1(db)),
  ];
}

// Frozen at what 113 created — secrets.ts's rule. 113 generates its CREATE
// from a mapping, so a column added to the live mapping above would rewrite an
// applied migration and every deployed database would refuse the whole plan.
// New columns are ALTERs at new versions.
function createTableSqlV1(db: Db): string {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("tools", "tools", "text"),
    field("listedAt", "listed_at", "text"),
  ];
  return createTableSql(db, repository("mcp_tool_roster", "id", "id", fs));
}

export type Roster = {
  // "[]" when nothing has ever been listed.
  tools: string,
  // "" when nothing has ever been listed.
  listedAt: string,
};

export function emptyRoster(): Roster {
  let none: Roster = { tools: "[]", listedAt: "" };
  return none;
}

/** Keep what this connector just said it offers.
 *
 *  Called only on a listing that succeeded. A failed listing must not reach
 *  here: overwriting a good roster with an empty one on a network blip is
 *  exactly how a cache stops being worth having. */
export function rememberRoster(db: Db, serverId: string, tools: McpTool[], now: string): void {
  if (serverId == "") { return; }
  let out = "[";
  let i: int = 0;
  while (i < tools.length && i < MAX_REMEMBERED_TOOLS) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"name\":" + JSON.stringify(tools[i].name)
      + ",\"description\":" + JSON.stringify(tools[i].description) + "}";
    i = i + 1;
  }
  out = out + "]";
  let row: McpRosterRow = { id: serverId, tools: out, listedAt: now };
  persist(db, mcpRosterMapping(), JSON.stringify(row));
}

/** What this connector last said, or an empty roster. */
export function rosterOf(db: Db, serverId: string): Roster {
  let document = findById(db, mcpRosterMapping(), serverId);
  if (document == "") { return emptyRoster(); }
  let row: McpRosterRow = JSON.parse<McpRosterRow>(document);
  if (row.tools == "") { return emptyRoster(); }
  let out: Roster = { tools: row.tools, listedAt: row.listedAt };
  return out;
}

/** Forget it, with the connector it belongs to. A roster outliving its server
 *  is a list of tools nothing can call — forgetServer's rule, one table on. */
export function forgetRoster(db: Db, serverId: string): void {
  deleteById(db, mcpRosterMapping(), serverId);
}

// One remembered tool, as the row stores it.
type RosterTool = {
  name: string,
  description: string,
};

/** A stored roster in the shape the tools route answers, with each tool's
 *  switch filled in from the deployment's own list.
 *
 *  The switches are read fresh rather than remembered: which tools are mounted
 *  is this deployment's decision and changes without the connector being asked
 *  anything, so a remembered `on` would be the one field in the answer that
 *  could be wrong about our own state. */
export function rosterWithSwitches(tools: string, declined: string[]): string {
  let rows: RosterTool[] = JSON.parse<RosterTool[]>(tools);
  let out = "[";
  let i: int = 0;
  while (i < rows.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"name\":" + JSON.stringify(rows[i].name)
      + ",\"description\":" + JSON.stringify(rows[i].description)
      + ",\"on\":" + (declined.includes(rows[i].name) ? "false" : "true") + "}";
    i = i + 1;
  }
  return out + "]";
}

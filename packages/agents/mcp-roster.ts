import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, createTableSql, deleteById, field, findById, persist, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { McpTool } from "./mcp.ts";

export const MAX_REMEMBERED_TOOLS: int = 200;

export type McpRosterRow = {
  id: string,
  tools: string,
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
  return [
    migration("113", "what a connector last said it could do",
      createTableSqlV1(db)),
  ];
}

function createTableSqlV1(db: Db): string {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("tools", "tools", "text"),
    field("listedAt", "listed_at", "text"),
  ];
  return createTableSql(db, repository("mcp_tool_roster", "id", "id", fs));
}

export type Roster = {
  tools: string,
  listedAt: string,
};

export function emptyRoster(): Roster {
  let none: Roster = { tools: "[]", listedAt: "" };
  return none;
}

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

export function rosterOf(db: Db, serverId: string): Roster {
  let document = findById(db, mcpRosterMapping(), serverId);
  if (document == "") { return emptyRoster(); }
  let row: McpRosterRow = JSON.parse<McpRosterRow>(document);
  if (row.tools == "") { return emptyRoster(); }
  let out: Roster = { tools: row.tools, listedAt: row.listedAt };
  return out;
}

export function forgetRoster(db: Db, serverId: string): void {
  deleteById(db, mcpRosterMapping(), serverId);
}

type RosterTool = {
  name: string,
  description: string,
};

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

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
  return repository({ table: "mcp_tool_roster", idField: "id", idColumn: "id", fields: fs });
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
  return createTableSql(db, repository({ table: "mcp_tool_roster", idField: "id", idColumn: "id", fields: fs }));
}

export type Roster = {
  tools: string,
  listedAt: string,
};

export function emptyRoster(): Roster {
  let none: Roster = { tools: "[]", listedAt: "" };
  return none;
}

type RosterTool = {
  name: string,
  description: string,
};

function rosterTool(tool: McpTool): RosterTool {
  let out: RosterTool = { name: tool.name, description: tool.description };
  return out;
}

export function rememberRoster(db: Db, serverId: string, tools: McpTool[], now: string): void {
  if (serverId == "") {
    return;
  }
  let kept = tools.length > MAX_REMEMBERED_TOOLS ? tools.slice(0, MAX_REMEMBERED_TOOLS) : tools;
  let row: McpRosterRow = { id: serverId, tools: JSON.stringify(kept.map(rosterTool)), listedAt: now };
  persist(db, mcpRosterMapping(), JSON.stringify(row));
}

export function rosterOf(db: Db, serverId: string): Roster {
  let document = findById(db, mcpRosterMapping(), serverId);
  if (document == "") {
    return emptyRoster();
  }
  let row: McpRosterRow = JSON.parse<McpRosterRow>(document);
  if (row.tools == "") {
    return emptyRoster();
  }
  let out: Roster = { tools: row.tools, listedAt: row.listedAt };
  return out;
}

export function forgetRoster(db: Db, serverId: string): void {
  deleteById(db, mcpRosterMapping(), serverId);
}

type RosterSwitch = {
  name: string,
  description: string,
  on: bool,
};

export function rosterWithSwitches(tools: string, declined: string[]): string {
  let rows: RosterTool[] = JSON.parse<RosterTool[]>(tools);
  return JSON.stringify(rows.map((row: RosterTool): RosterSwitch => {
    let out: RosterSwitch = { name: row.name, description: row.description, on: !declined.includes(row.name) };
    return out;
  }));
}

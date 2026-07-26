// The tools an agent may call, assembled from its rows.
//
//   let mounted = mountTools(db, "a1");
//   let answer  = callMounted(mounted, "read_file", "{\"path\":\"/etc/hosts\"}");
//
// An agent reaches an MCP server because a row links the two. Adding a tool to
// an agent is an INSERT into `agent_mcp_servers` and takes effect on the next
// run — nothing here is compiled in, and nothing restarts.
//
// The server is asked what it offers every time an agent runs. That is a round
// trip per run per server, and it is deliberate: a server's tool list is its
// own to change, and a cached list is a list that is wrong the first time
// somebody deploys a new tool.

import { Db } from "../plume/driver.ts";
import { listWhere, placeholderAt } from "../plume/plume.ts";
import { AgentRow, McpServerRow, agentsMapping, mcpServersMapping } from "./schema.ts";
import { McpCall, McpTool, listTools, callTool } from "./mcp.ts";
import { ToolSpec, toolSpec } from "./provider.ts";

// One tool, and which server answers it.
export type MountedTool = {
  name: string,
  description: string,
  schema: string,
  // Into `Mounted.servers`. A row rather than a copy of the row per tool: a
  // server with twelve tools is one endpoint, not twelve.
  server: int,
};

export type Mounted = {
  tools: MountedTool[],
  servers: McpServerRow[],
  // What could not be mounted, in words. Not an error — an agent with one
  // unreachable server out of three still runs — but never silent, because a
  // tool the model was never told about is a failure that looks like a bad
  // answer.
  problems: string[],
};

// The servers an agent is linked to.
export function agentServers(db: Db, agentId: string): McpServerRow[] {
  let where = "id IN (SELECT server_id FROM agent_mcp_servers WHERE agent_id = " + placeholderAt(db, 1) + ")";
  let document = listWhere(db, mcpServersMapping(), where, [agentId]);
  if (document == "" || document == "[]") {
    let none: McpServerRow[] = [];
    return none;
  }
  return JSON.parse<McpServerRow[]>(document);
}

// --- delegation ---------------------------------------------------------------
//
// An agent's children are tools too. A parent that can ask a specialist is the
// same shape as a parent that can read a file: a name, a description of when
// to use it, and one argument. Making delegation a tool rather than a separate
// mechanism means one loop, one trace and one budget cover both.

// The children an agent may delegate to. One level, like `agentsFull` — a tree
// is walked a level at a time, so a cycle in the graph is a row rather than an
// infinite query.
export function agentChildren(db: Db, agentId: string): AgentRow[] {
  let where = "id IN (SELECT child_id FROM agent_sub_agents WHERE parent_id = " + placeholderAt(db, 1) + ")";
  let document = listWhere(db, agentsMapping(), where, [agentId]);
  if (document == "" || document == "[]") {
    let none: AgentRow[] = [];
    return none;
  }
  return JSON.parse<AgentRow[]>(document);
}

// The tool name a child answers to.
//
// `ask_` because the model is choosing between "read a file" and "ask the
// person who knows about stock", and the verb is what makes that choice
// obvious. Anything a provider will not accept in a tool name becomes `_`:
// the names are agent names, chosen by whoever built the agent, and they
// should not have to know a provider's character set.
export function delegateToolName(agentName: string): string {
  let out = "ask_";
  let i: int = 0;
  while (i < agentName.length) {
    let c = agentName.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 45;
    if (ok) { out = out + agentName.charAt(i); } else { out = out + "_"; }
    i = i + 1;
  }
  return out;
}

// What a child is described as, for a parent deciding whether to ask it. The
// description is the child's own row: whoever wrote the agent said what it is
// for, and that is exactly what the parent needs to read.
export function delegateDescription(child: AgentRow): string {
  if (child.description == "") {
    return "Ask the " + child.agentName + " agent. It answers in its own words.";
  }
  return "Ask the " + child.agentName + " agent: " + child.description;
}

// One argument, named for what it is. A child is another agent, so what it
// takes is a question in words, not a structure.
export function delegateSchema(): string {
  // "In full" is not a style note. A parent that asks "what is the stock of
  // A-114?" having been asked about Rotterdam gets an answer about some
  // warehouse the child picked, and passes it on as fact — observed, not
  // hypothesised. The child has no conversation to fall back on, so every
  // name the question depends on has to be in the question.
  return "{\"type\":\"object\",\"properties\":{\"question\":{\"type\":\"string\","
    + "\"description\":\"What to ask, in full. This agent cannot see your conversation, "
    + "so repeat every name, place, quantity and date the question depends on. "
    + "A question missing one of those gets an answer about something else.\"}},"
    + "\"required\":[\"question\"]}";
}

// Everything the agent can call, asked of each of its servers in turn.
//
// Two servers offering the same tool name is the one case with no good answer:
// the model is given a flat list of names, so the second one cannot be
// described without renaming it out from under the server that owns it. The
// first server linked wins and the clash is recorded, which at least makes it
// visible to whoever linked them.
export function mountTools(db: Db, agentId: string): Mounted {
  let tools: MountedTool[] = [];
  let problems: string[] = [];
  let servers = agentServers(db, agentId);

  let s: int = 0;
  while (s < servers.length) {
    let server = servers[s];
    if (!server.enabled) {
      problems.push(server.serverName + " is disabled");
      s = s + 1;
      continue;
    }
    if (server.transport != "http") {
      problems.push(server.serverName + " speaks " + server.transport + ", which needs a subprocess this cannot spawn");
      s = s + 1;
      continue;
    }

    let offered = listTools(server);
    if (offered.length == 0) {
      problems.push(server.serverName + " listed no tools");
      s = s + 1;
      continue;
    }

    let i: int = 0;
    while (i < offered.length) {
      if (mountedIndex(tools, offered[i].name) >= 0) {
        problems.push(server.serverName + " also offers \"" + offered[i].name + "\", which is already mounted");
      } else {
        let t: MountedTool = {
          name: offered[i].name,
          description: offered[i].description,
          schema: offered[i].schema,
          server: s,
        };
        tools.push(t);
      }
      i = i + 1;
    }
    s = s + 1;
  }

  let out: Mounted = { tools: tools, servers: servers, problems: problems };
  return out;
}

// Where a tool sits in the list, or -1.
export function mountedIndex(tools: MountedTool[], name: string): int {
  let i: int = 0;
  while (i < tools.length) {
    if (tools[i].name == name) { return i; }
    i = i + 1;
  }
  return -1;
}

// The tools as the provider needs them described.
export function toolSpecs(mounted: Mounted): ToolSpec[] {
  let out: ToolSpec[] = [];
  let i: int = 0;
  while (i < mounted.tools.length) {
    out.push(toolSpec(mounted.tools[i].name, mounted.tools[i].description, mounted.tools[i].schema));
    i = i + 1;
  }
  return out;
}

// Call a tool by the name the model used.
//
// A name that is not mounted comes back as a failed call rather than stopping
// the run: the model invented it, and being told so is something it can
// recover from, where a dead run is not.
export function callMounted(mounted: Mounted, name: string, args: string): McpCall {
  let at = mountedIndex(mounted.tools, name);
  if (at < 0) {
    let unknown: McpCall = {
      ok: false,
      text: "There is no tool named \"" + name + "\". Call one of the tools you were given.",
      error: "no tool named \"" + name + "\"",
    };
    return unknown;
  }
  return callTool(mounted.servers[mounted.tools[at].server], name, args);
}

// Which server answers a tool, for a caller recording what ran.
export function serverOf(mounted: Mounted, name: string): string {
  let at = mountedIndex(mounted.tools, name);
  if (at < 0) { return ""; }
  return mounted.servers[mounted.tools[at].server].serverName;
}

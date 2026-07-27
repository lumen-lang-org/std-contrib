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
import { credentialFor } from "./credentials.ts";
import { listWhere, placeholderAt } from "../plume/plume.ts";
import { AgentRow, McpServerRow, agentsMapping, mcpServersMapping } from "./schema.ts";
import { McpCall, McpTool, listTools, callTool } from "./mcp.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { jsonText } from "./scan.ts";
import { normalScope } from "./knowledge.ts";
import { FileToolResult } from "./workspace.ts";
import { putArtifact, getArtifact, getVersion, utf8Length } from "./artifacts.ts";

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
  // One token per server, read out of the encrypted store when the tools were
  // mounted. Carried here so calling a tool does not need the master key —
  // the decryption happened once, where the key already was.
  tokens: string[],
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
export function mountTools(db: Db, agentId: string, master: string): Mounted {
  let tools: MountedTool[] = [];
  let problems: string[] = [];
  let tokens: string[] = [];
  let servers = agentServers(db, agentId);

  // One token per server, in step with `servers`, filled before any of the
  // guards below can skip an entry. A list that only gains an item on the
  // paths that reach the bottom drifts out of alignment with the one it is
  // indexed beside, which is the whole reason a tool's `server` is an index.
  let t: int = 0;
  while (t < servers.length) {
    let each = servers[t];
    let held = "";
    if (each.authKind != "" && each.authKind != "none") {
      held = credentialFor(db, "mcp:" + each.id, master);
    }
    tokens.push(held);
    t = t + 1;
  }

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

    // A server told to authenticate with nothing stored for it will be
    // refused by the server itself; saying so here beats an opaque 401.
    let token = tokens[s];
    if (server.authKind != "" && server.authKind != "none" && token == "") {
      problems.push(server.serverName + " needs a token and none is stored for it");
      s = s + 1;
      continue;
    }
    let offered = listTools(server, token);
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

  let out: Mounted = { tools: tools, servers: servers, tokens: tokens, problems: problems };
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
  let which = mounted.tools[at].server;
  return callTool(mounted.servers[which], name, args, mounted.tokens[which]);
}

// Which server answers a tool, for a caller recording what ran.
export function serverOf(mounted: Mounted, name: string): string {
  let at = mountedIndex(mounted.tools, name);
  if (at < 0) { return ""; }
  return mounted.servers[mounted.tools[at].server].serverName;
}

// --- artifacts -----------------------------------------------------------------
//
// What a conversation produces, as tools. Offered beside the workspace files
// and answered ahead of MCP, for the same reason those are: these two names
// belong to the thread, and a server that happens to offer a `write_artifact`
// must not be the thing that answers one.
//
// Two tools and not five. A model that can save a body and read the current one
// can do the work; listing, diffing and rolling a version back are things a
// person does through the API, with the whole log in front of them.

// The self-containment rule, in the description because it is the one thing
// about an artifact a model cannot learn by trying. A body that pulls a script
// off a CDN validates, stores and previews without a single error and merely
// renders without the script — so nothing in the loop ever tells the model it
// got this wrong, and it has to be told up front.
const SELF_CONTAINED: string = "An artifact may reach its siblings and nothing else. "
  + "Files you save in this same conversation are served next to each other, so a page at /index.html can link "
  + "<link rel=\"stylesheet\" href=\"css/main.css\"> or <script src=\"js/app.js\"> and they will load — save each one with its own "
  + "write_artifact call, at the path the page refers to. Nothing from another host will: the preview blocks every "
  + "request off this origin, so a CDN script, a Google font or a remote image is simply missing when a reader opens it. "
  + "Draw rather than link, and inline anything too small to be its own file.";

// The two tools, described for the model. A ToolSpec straight away rather than
// a private tool type the caller re-wraps field by field: there is nothing here
// a provider does not already understand.
export function artifactTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  out.push(toolSpec("write_artifact",
    "Save something the user is meant to look at — a page, a diagram, a document, a data file — as an artifact of this conversation. "
    + "Writing a path that already exists appends a new version instead of replacing the old one, and the reply names the slot and version number, "
    + "which is how you refer to what you just saved when you answer. "
    + SELF_CONTAINED,
    "{\"type\":\"object\",\"properties\":{"
    + "\"path\":{\"type\":\"string\",\"description\":\"Where it lives in this conversation, such as /report.html. Segments are letters, digits, dot and dash; the extension decides how it renders and must be one of .html, .svg, .md, .json, .txt or a source suffix.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"What to call it where artifacts are listed.\"},"
    + "\"content\":{\"type\":\"string\",\"description\":\"The whole body. This is not a patch: what you send is the new version, entire.\"},"
    + "\"note\":{\"type\":\"string\",\"description\":\"Why this version exists, in a few words. Empty is fine for a first draft.\"}},"
    + "\"required\":[\"path\",\"title\",\"content\"]}"));
  out.push(toolSpec("read_artifact",
    "Read the current version of one of this conversation's artifacts, whole. "
    + "Artifacts are self-contained — no remote scripts, styles or fonts — so what comes back is all of it, with nothing left to fetch.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"path\":{\"type\":\"string\",\"description\":\"The path the artifact was saved under.\"}},"
    + "\"required\":[\"path\"]}"));
  return out;
}

// One call to the artifact tools.
//
// A record, not four positional strings. `threadId`, `name`, `args` and `now`
// are all strings with no shape between them: swapped, a run files the model's
// arguments as a thread id, or stamps a version row with a tool name where the
// date belongs. Nothing in the types and nothing in the storage would refuse
// any of it — `putArtifact` would take "write_artifact" as a timestamp without
// comment. This is the same fix `ArtifactWrite` and `FileWrite` already are,
// applied to the call that reaches them.
//
// `args` stays whole and is unpacked here. The workspace's caller pre-extracts
// two argument names before it knows which tool was called, which is why adding
// an argument there means editing a schema in one file and an extraction in
// another and hoping the two agree. Holding the JSON until the name is known
// leaves one place that decides what write_artifact takes.
export type ArtifactToolCall = {
  threadId: string,
  name: string,
  // The arguments as the model sent them: JSON text.
  args: string,
  now: string,
};

// Dispatch one of the two. `handled` false means the name is not ours, which is
// how the run loop knows to go on to delegation and then to MCP.
//
// The result is the workspace's `FileToolResult` rather than a second record
// with the same three fields — the loop treats both dispatchers identically and
// a parallel type would only be a thing to keep in step. The name is about
// files rather than about the shape, and is worth widening the day workspace.ts
// is open for another reason.
export function callArtifactTool(db: Db, call: ArtifactToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "" };
  // An artifact is addressed within a conversation, so a bare run has none.
  // The loop does not offer these tools without a thread; this catches a model
  // that invented the name from its own training rather than from the list.
  if (call.threadId == "") { return not; }

  if (call.name == "write_artifact") {
    let path = normalScope(jsonText(call.args, "path"));
    let content = jsonText(call.args, "content");
    let written = putArtifact(db, {
      threadId: call.threadId,
      path: path,
      title: jsonText(call.args, "title"),
      content: content,
      note: jsonText(call.args, "note"),
      // Fixed here, never read out of the arguments: origin says who produced
      // a body, and a model asked to declare that can call its own output an
      // upload. This call site knows the answer.
      origin: "generated",
      now: call.now,
    });
    if (!written.ok) {
      // The refusal in the storage's own words — every one of them names what
      // was wrong with the path or the body, which is what the model needs to
      // try again rather than give up.
      let refused: FileToolResult = { handled: true, ok: false, text: written.problem };
      return refused;
    }
    // Both numbers, because the sentence the model writes next has to point at
    // what it just saved: "the artifact" is ambiguous the moment there are two,
    // and "the latest version" stops being true on the next write.
    let wrote: FileToolResult = {
      handled: true, ok: true,
      text: "Saved " + path + " as artifact " + `${written.slot}` + ", version " + `${written.version}`
        + " (" + `${utf8Length(content)}` + " bytes). Refer to it as artifact " + `${written.slot}`
        + ", version " + `${written.version}` + ".",
    };
    return wrote;
  }

  if (call.name == "read_artifact") {
    let path = normalScope(jsonText(call.args, "path"));
    let artifact = getArtifact(db, call.threadId, path);
    if (artifact.id == "") {
      let missing: FileToolResult = {
        handled: true, ok: false,
        text: "There is no artifact at " + path + " in this conversation.",
      };
      return missing;
    }
    let current = getVersion(db, artifact.id, artifact.currentVersion);
    if (current.id == "") {
      // The pointer names a version the log does not hold. Said out loud rather
      // than answered with the empty body `getVersion` returns: an artifact
      // that reads as blank is indistinguishable from one that was saved blank,
      // and the model would confidently report it as empty.
      let broken: FileToolResult = {
        handled: true, ok: false,
        text: "Artifact " + path + " points at version " + `${artifact.currentVersion}`
          + ", which is not in its history.",
      };
      return broken;
    }
    let read: FileToolResult = { handled: true, ok: true, text: current.body };
    return read;
  }

  return not;
}

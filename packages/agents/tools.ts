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
import { AgentRow, McpServerRow, SkillRow, SkillFileRow, agentsMapping, mcpServersMapping, skillsMapping, skillFilesMapping } from "./schema.ts";
import { McpCall, McpTool, listTools, callTool } from "./mcp.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { jsonFind, jsonList, jsonRaw, jsonText, jsonUnescape } from "./scan.ts";
import { normalScope } from "./knowledge.ts";
import { FileToolResult } from "./workspace.ts";
import { putArtifact, getArtifact, getVersion, utf8Length } from "./artifacts.ts";
import { ArtifactSearch, searchArtifacts } from "./artifacts-search.ts";
import { editArtifact } from "./artifacts-edit.ts";
import { wireView } from "./artifacts-fence.ts";
import { SCRIPT_OUTPUT_MAX, SCRIPT_RUN_DIR, SCRIPT_WALL_SECONDS, ScriptRan, ScriptRefusal, ScriptRun, ScriptVersioned, scriptDockerWorks, scriptRun, foldName } from "./run-script.ts";

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
// The key a person's own token for a server lives under. Beside the
// deployment's "mcp:<id>" rather than in a new table: the credential store
// already encrypts, already never reads back, and a second store would be a
// second set of those promises to keep.
export function userTokenKey(serverId: string, owner: string): string {
  return "mcp:" + serverId + ":u:" + owner;
}

export function mountTools(db: Db, agentId: string, master: string, owner: string): Mounted {
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
      // The person's own token first, the deployment's as the fallback. The
      // order is the feature: a GitHub connector with one shared PAT calls
      // out as one account for everybody, which is wrong the moment the
      // account is somebody's own. "" for owner — a bare run, an unowned
      // box — skips straight to the shared one, which is what it always did.
      if (owner != "") {
        held = credentialFor(db, userTokenKey(each.id, owner), master);
      }
      if (held == "") {
        held = credentialFor(db, "mcp:" + each.id, master);
      }
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
    // Naming what IS there, not only what is not. A model that invented
    // "search_web" and is told "no such tool" invents another name or gives
    // up and answers from memory — which is exactly what it must not do
    // about a live question. The list is the recovery: it is short, it is
    // this run's own, and it turns a dead end into the next call.
    let unknown: McpCall = {
      ok: false,
      text: "There is no tool named \"" + name + "\". The tools you have are: "
        + mountedNames(mounted) + ". Call one of those instead — "
        + "anything a skill does is reached through use_skill, not by its own name.",
      error: "no tool named \"" + name + "\"",
    };
    return unknown;
  }
  let which = mounted.tools[at].server;
  return callTool(mounted.servers[which], name, args, mounted.tokens[which]);
}

// Every tool name this run offered, as a sentence — the MCP ones the mount
// carries plus the built-ins every run has. Written here because this is
// where a refusal needs it; the built-ins are named literally because they
// are not in `mounted` and their names are fixed by their own tool specs.
function mountedNames(mounted: Mounted): string {
  let out = "use_skill, run_script, read_artifact, write_artifact, edit_artifact";
  let i: int = 0;
  while (i < mounted.tools.length) {
    out = out + ", " + mounted.tools[i].name;
    i = i + 1;
  }
  return out;
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
// Four tools and not seven. Save, read, find, change is the complete verb set
// for a file a model owns: write_artifact makes a version, read_artifact
// returns one whole, search_artifacts finds the line to change, and
// edit_artifact changes it without resending the rest. Listing, diffing and
// rolling a version back remain the person's, through the API, with the whole
// log in front of them — a model given rollback would use it to erase the
// version that shows what it did.

// The self-containment rule, in the description because it is the one thing
// about an artifact a model cannot learn by trying. A body that pulls a script
// off a CDN validates, stores and previews without a single error and merely
// renders without the script — so nothing in the loop ever tells the model it
// got this wrong, and it has to be told up front.
const SELF_CONTAINED: string = "An artifact may reach its siblings and nothing else. "
  + "Files you save in this same conversation are served next to each other, so a page at /index.html can link "
  + "<link rel=\"stylesheet\" href=\"css/main.css\"> or <script src=\"js/app.js\"> and they will load — save each one with its own "
  + "write_artifact call, at the path the page refers to. Images are the exception the other way: an <img> may point "
  + "at any https URL and it will load, so a photograph or a GIF from the web is allowed. Everything else from another "
  + "host is blocked — a CDN script, a Google font, a remote stylesheet is simply missing when a reader opens the page. "
  + "Draw rather than link, inline anything too small to be its own file, and prefer saving an image you were given a "
  + "URL for (fetch it in run_script) so the page keeps working when that host does not.";

// The fence convention, for the system prompt. A prompt line rather than a
// tool description because the fence is not a tool call: a model deciding how
// to answer needs the convention before it starts writing, not at the moment
// it happens to consider write_artifact. Offered only where the tools are —
// with a thread — since a fence saves into the same conversation they do.
export const FILE_FENCE: string = "You can also create a file directly in your reply: open a code fence whose "
  + "info line names a path, like ```html path=/index.html title=Landing page — the fenced body is saved as a new "
  + "artifact and your reply keeps a one-line reference in its place. The first word after the backticks is the "
  + "language, path= takes the path as one word, and title= runs to the end of the line. A fence can only CREATE "
  + "a file that does not exist yet, and only of an inert kind: .html, .svg, .md, .json or .txt. Updating a path "
  + "that already exists, and writing a script or stylesheet of any kind, must go through the write_artifact tool "
  + "— a fence that tries either is refused, and the refusal is noted. A fence without path= is ordinary quoted "
  + "code and is left alone. If you fence one new path twice in a reply, the last body is the one saved; if you "
  + "both call write_artifact on a path and fence it, the tool call wins and the fence is skipped.";

// The two tools, described for the model. A ToolSpec straight away rather than
// a private tool type the caller re-wraps field by field: there is nothing here
// a provider does not already understand.
export function artifactTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  out.push(toolSpec("write_artifact",
    "Save something the user is meant to look at — a page, a diagram, a document, a data file — as an artifact of this conversation. "
    + "Writing a path that already exists appends a new version instead of replacing the old one, and the reply names the slot and version number, "
    + "which is how you refer to what you just saved when you answer. "
    // The pointer used to run one way: edit_artifact ends by naming this tool
    // for a rewrite, and this tool named neither of the other two. A model
    // reads the list in order, meets the whole-file tool first, and takes it —
    // one deleted two invented fields from a 16KB docflow by re-emitting the
    // whole file, and the reply hit the model's own output ceiling mid-JSON,
    // so the turn was refused and nothing was saved. Both halves of that are
    // named here because both were paid: reading the file whole to find the
    // line, then sending it whole to change it.
    + "Changing part of a file that is already here is edit_artifact's work, not this tool's: send the changed text alone, "
    + "and search_artifacts finds the line to send without reading the file. "
    + "Keep this tool for a path that does not exist yet, or a rewrite that replaces most of what is there — "
    + "a body sent whole costs its own size out of one reply's room, and a file large enough cannot be sent that way at all. "
    + "A path-carrying code fence in your reply (```html path=/index.html) can create a new inert file the same way, but only this tool can update an existing path or write a script or stylesheet; when a reply names one path through both, this tool wins. "
    + SELF_CONTAINED,
    "{\"type\":\"object\",\"properties\":{"
    + "\"path\":{\"type\":\"string\",\"description\":\"Where it lives in this conversation, such as /report.html. Segments are letters, digits, dot and dash; the extension decides how it renders and must be one of .html, .svg, .md, .json, .txt or a source suffix.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"What to call it where artifacts are listed.\"},"
    + "\"content\":{\"type\":\"string\",\"description\":\"The whole body. This is not a patch: what you send is the new version, entire.\"},"
    + "\"note\":{\"type\":\"string\",\"description\":\"Why this version exists, in a few words. Empty is fine for a first draft.\"}},"
    + "\"required\":[\"path\",\"title\",\"content\"]}"));
  out.push(toolSpec("read_artifact",
    "Read the current version of one of this conversation's artifacts, whole. "
    + "Artifacts are self-contained — no remote scripts, styles or fonts — so what comes back is all of it, with nothing left to fetch. "
    + "Whole is the cost as well as the promise: when you want one line — to check a value, or to have the exact text "
    + "edit_artifact needs as old — search_artifacts returns it with its line number and leaves the rest unread.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"path\":{\"type\":\"string\",\"description\":\"The path the artifact was saved under.\"}},"
    + "\"required\":[\"path\"]}"));
  out.push(toolSpec("search_artifacts",
    "Find where something lives in this conversation's artifacts before you change it. "
    + "The query is matched as an exact substring - no patterns, no case folding, one line only - "
    + "against every artifact's path, title, and the body of its current version. "
    + "Each hit names the path, the version searched, and the matching line with its line number, "
    + "which is the text edit_artifact expects as old. "
    + "A line longer than 160 bytes comes back cut, ending in the marker [cut]; "
    + "never use a cut line as edit_artifact's old - read_artifact the file instead. "
    + "At most 20 hits, at most 5 per artifact; no hits is an answer, not an error, "
    + "and names how many artifacts were searched.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"query\":{\"type\":\"string\",\"description\":\"The exact text to look for, 2 to 200 bytes of UTF-8, no newline. "
    + "Every length here is bytes, so a letter outside ASCII counts as more than one. "
    + "Substring only: 'a.*b' finds lines containing those four characters and nothing else.\"}},"
    + "\"required\":[\"query\"]}"));
  out.push(toolSpec("edit_artifact",
    "Change part of an existing artifact without resending the rest. "
    + "old is matched against the artifact's current version as an exact substring - every character, "
    + "including whitespace, quotes and indentation, exactly as read_artifact or search_artifacts returned it - "
    + "and replaced once with new, saved as the next version. "
    + "The call is refused when old matches nowhere (nothing is guessed or fuzzily matched; the refusal says "
    + "whether a whitespace-insensitive scan found a near miss and on what line) and refused when old matches "
    + "more than once (the refusal lists the matches with their lines and text; include more surrounding text "
    + "until the match is unique). "
    + "The reply names the slot, the new version number, and shows the changed lines with two lines around them - "
    + "read that reply; it is how you learn what actually changed in a file you did not reread. "
    + "If the refusal says the artifact changed while you were editing, read or search it again before retrying. "
    + "For a file that does not exist yet, or when most of a file changes, use write_artifact.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"path\":{\"type\":\"string\",\"description\":\"The path the artifact was saved under, such as /report.html.\"},"
    + "\"old\":{\"type\":\"string\",\"description\":\"The exact text to replace, verbatim from the current version. "
    + "Must occur exactly once.\"},"
    + "\"new\":{\"type\":\"string\",\"description\":\"What replaces it. May be empty to delete the old text.\"},"
    + "\"note\":{\"type\":\"string\",\"description\":\"Why this version exists, in a few words.\"}},"
    + "\"required\":[\"path\",\"old\",\"new\"]}"));
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
  // The agent whose call this is. Only run_script reads it, to resolve the
  // curated image its environments are built from — the choice is the
  // operator's, made in configuration, never a member of the call.
  agentId: string,
  name: string,
  // The arguments as the model sent them: JSON text.
  args: string,
  // The round this call belongs to: the thread's turn seq at the round's
  // base. The fence door stamps the same number, so a version row answers
  // "which round wrote you" identically whichever door was used.
  turnSeq: int,
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
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
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
      // The tool is the door that MAY update, so no create-only here.
      mustCreate: false,
      // Fixed here, never read out of the arguments: origin says who produced
      // a body, and a model asked to declare that can call its own output an
      // upload. This call site knows the answer.
      origin: "generated",
      turnSeq: call.turnSeq,
      now: call.now,
    });
    if (!written.ok) {
      // The refusal in the storage's own words — every one of them names what
      // was wrong with the path or the body, which is what the model needs to
      // try again rather than give up.
      let refused: FileToolResult = { handled: true, ok: false, text: written.problem, line: 0, changed: "" };
      return refused;
    }
    // Both numbers, because the sentence the model writes next has to point at
    // what it just saved: "the artifact" is ambiguous the moment there are two,
    // and "the latest version" stops being true on the next write.
    let wrote: FileToolResult = {
      handled: true, ok: true,
      text: "Saved " + path + " as artifact " + `${written.slot}` + ", version " + `${written.version}`
        + " (" + `${utf8Length(content)}` + " bytes). Refer to it as artifact " + `${written.slot}`
        + ", version " + `${written.version}` + ".", line: 0, changed: ""
    };
    return wrote;
  }

  if (call.name == "read_artifact") {
    let path = normalScope(jsonText(call.args, "path"));
    let artifact = getArtifact(db, call.threadId, path);
    if (artifact.id == "") {
      let missing: FileToolResult = {
        handled: true, ok: false,
        text: "There is no artifact at " + path + " in this conversation.", line: 0, changed: ""
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
          + ", which is not in its history.", line: 0, changed: ""
      };
      return broken;
    }
    let read: FileToolResult = { handled: true, ok: true, text: current.body, line: 0, changed: "" };
    return read;
  }

  if (call.name == "search_artifacts") {
    // Presence-checked before anything else: jsonText answers "" for a
    // missing member, and a refusal must name the member that was absent,
    // not complain about an empty query.
    if (jsonFind(call.args, "query") < 0) {
      let unnamed: FileToolResult = {
        handled: true, ok: false,
        text: "search_artifacts needs a member named \"query\" — the exact text to look for.", line: 0, changed: ""
      };
      return unnamed;
    }
    let found = searchArtifacts(db, call.threadId, jsonText(call.args, "query"));
    if (!found.ok) {
      let refused: FileToolResult = { handled: true, ok: false, text: found.problem, line: 0, changed: "" };
      return refused;
    }
    // Every quoted line below is an artifact body, and an artifact body is
    // untrusted — wireView keeps a marker planted in one from arriving in
    // model context as a reference the model never earned.
    let answered: FileToolResult = {
      handled: true, ok: true, text: wireView(searchAnswer(found)).text, line: 0, changed: ""
    };
    return answered;
  }

  if (call.name == "edit_artifact") {
    // The same presence checks, one refusal per member, so an omitted or
    // misspelled member is named instead of arriving as "".
    if (jsonFind(call.args, "path") < 0) {
      let unnamed: FileToolResult = {
        handled: true, ok: false,
        text: "edit_artifact needs a member named \"path\" — the path the artifact was saved under.", line: 0, changed: ""
      };
      return unnamed;
    }
    if (jsonFind(call.args, "old") < 0) {
      let unnamed: FileToolResult = {
        handled: true, ok: false,
        text: "edit_artifact needs a member named \"old\" — the exact text to replace.", line: 0, changed: ""
      };
      return unnamed;
    }
    if (jsonFind(call.args, "new") < 0) {
      let unnamed: FileToolResult = {
        handled: true, ok: false,
        text: "edit_artifact needs a member named \"new\" — the replacement, which may be empty to delete old.", line: 0, changed: ""
      };
      return unnamed;
    }
    // A .docx is not text, and a text edit on one is not a small mistake.
    //
    // Observed: a model asked to change a placeholder in a meeting-notes
    // template called edit_artifact, was told the text was not found — which
    // is true and useless, because the body is a zip — and then told the
    // person their template was missing the placeholder that is plainly in
    // it. The refusal has to name the reason and the route, or the model
    // spends the round arguing with a binary.
    if (binaryKind(kindOf(normalScope(jsonText(call.args, "path"))))) {
      let wrongTool: FileToolResult = {
        handled: true, ok: false,
        text: "That artifact is a binary document, not text — its bytes are a zip, so"
          + " there is nothing here to find or replace. Edit it with a script instead:"
          + " load the skill for its kind (make-doc for .docx, make-sheet for .xlsx,"
          + " make-deck for .pptx), name the file in run_script's paths, and change it"
          + " in the office environment. Never tell the person a placeholder is absent"
          + " on the strength of this tool — it cannot see inside the document.",
        line: 0, changed: ""
      };
      return wrongTool;
    }
    // The wire says old/new; the record says oldText/newText, because `new`
    // is a reserved word. This unpacking is what decouples the spellings.
    let edited = editArtifact(db, {
      threadId: call.threadId,
      path: normalScope(jsonText(call.args, "path")),
      oldText: jsonText(call.args, "old"),
      newText: jsonText(call.args, "new"),
      note: jsonText(call.args, "note"),
      turnSeq: call.turnSeq,
      now: call.now,
    });
    if (!edited.ok) {
      // The refusal may quote body lines — numbered multi-match snippets —
      // so it passes through the same neutralisation the success echo does.
      let refused: FileToolResult = { handled: true, ok: false, text: wireView(edited.problem).text, line: 0, changed: "" };
      return refused;
    }
    let changed: FileToolResult = {
      handled: true, ok: true,
      text: wireView("Edited " + normalScope(jsonText(call.args, "path")) + ": artifact " + `${edited.slot}`
        + " is now version " + `${edited.version}` + " (" + `${edited.bytes}` + " bytes)."
        + " Changed at line " + `${edited.line}` + ":\n" + edited.context).text,
      // The one answer that carries a line: where the edit landed, so the
      // step row can say it and the card can number its snippets.
      line: edited.line, changed: ""
    };
    return changed;
  }

  return not;
}

// A search's hits as the model reads them. Line 0 marks a hit on the path or
// title rather than in the body, so those rows skip the line number.
function searchAnswer(found: ArtifactSearch): string {
  let what = found.searched == 1 ? " artifact" : " artifacts";
  if (found.hits.length == 0) {
    return "0 hits in " + `${found.searched}` + what + " searched.";
  }
  let hitWord = found.hits.length == 1 ? " hit" : " hits";
  let out = `${found.hits.length}` + hitWord + " in " + `${found.searched}` + what + " searched";
  if (found.capped) {
    out = out + " (capped: more matches exist; narrow the query)";
  }
  out = out + ":";
  let i: int = 0;
  while (i < found.hits.length) {
    let hit = found.hits[i];
    if (hit.line > 0) {
      out = out + "\n- " + hit.path + " v" + `${hit.version}` + ", line " + `${hit.line}` + ": " + hit.text;
    } else {
      out = out + "\n- " + hit.path + " v" + `${hit.version}` + ": " + hit.text;
    }
    i = i + 1;
  }
  return out;
}

// --- scripts ---------------------------------------------------------------------
//
// One more tool beside the artifact four, offered on one condition more: it
// exists only where docker answers. scriptTools() is the offering door — it
// returns nothing at all when the probe fails, because a tool that is offered
// and can only refuse teaches the model a name it will keep trying
// (RUN-SCRIPT.md: absent, not offered-and-failing).

// The description tells the model everything a run will not teach it: that
// the environment persists, that installs into it stick, that deletion never
// propagates, and what the reply names. All of that is invisible in a single
// successful call, so — like SELF_CONTAINED above — it has to be said up
// front.
// The environments an operator has enabled, as the names run_script takes:
// each image row's label, lowercased, which is exactly what
// scriptImageForEnv matches on. Read from the database rather than listed in
// prose, so an operator adding an image makes it reachable the same minute.
export function scriptEnvNames(db: Db): string[] {
  let out: string[] = [];
  let held = listWhere(db, scriptImagesMapping(), "enabled = " + placeholderAt(db, 1), ["1"]);
  if (held == "" || held == "[]") { return out; }
  let rows: ScriptImageRow[] = JSON.parse<ScriptImageRow[]>(held);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].label != "" && rows[i].image != "") {
      // Name first, then what is inside it. A model choosing between "search"
      // and "browser" on the names alone is guessing; the summary is what
      // makes the choice informed, and an image with none still offers its
      // name rather than being hidden.
      let name = rows[i].label.toLowerCase();
      out.push(rows[i].summary == "" ? name : name + " (" + rows[i].summary + ")");
    }
    i = i + 1;
  }
  return out;
}

export function scriptTool(envs: string[]): ToolSpec {
  return toolSpec("run_script",
    "Run a program against this conversation's artifacts when tool calls alone would take too many steps — "
    + "transform hundreds of entries at once, validate with a real library, compute before deciding what to write. "
    + "The script runs inside this conversation's environment, a container that persists between runs: what it leaves "
    + "outside its run directory — installed packages, caches, scratch files — is still there on the next call. That "
    + "state is cache, not record; when the environment had to be recreated the reply says so, and only artifacts "
    + "survive for certain. The environment has the network, and HOME is /workspace and persists: pip install and npm install work, and what one run installs the next run finds. "
    + "Name in paths every artifact the script reads or rewrites; each is copied into the run directory " + SCRIPT_RUN_DIR
    + " at its own path under it — the artifact /report.md is the file " + SCRIPT_RUN_DIR + "/report.md, and that "
    + "directory is also where the script starts, so report.md alone finds it. Nowhere else holds a copy: not the "
    + "artifact path, not /tmp, not /workspace. The directory is made fresh for every run, the script runs there, and "
    + "afterwards each file is compared back: unchanged bytes save nothing, changed bytes become the artifact's next "
    + "version under write_artifact's rules, a file created beyond paths is saved only when mayCreate is true, and "
    + "nothing is ever deleted — a file the script removed is reported and every stored version stays. "
    + "Where the environment has a browser, a screenshot is an ordinary script: drive the page, save the .png, let "
    + "mayCreate keep it. Launch chromium with --no-sandbox — the container is the sandbox. "
    + "A raster image the script writes — .png, .jpg, .gif, .webp — is stored base64 and shown as a picture in the "
    + "preview; generate images with the standard library or installed packages, write the file, and let mayCreate "
    + "save it. Never copy image base64 back through write_artifact yourself: retyping it corrupts it, and the run "
    + "already saved the exact bytes. An image from the web may be hot-linked in a page — img is the one thing a "
    + "preview may load from another host — but fetching it in a script and saving it with mayCreate is better: the "
    + "page then keeps working when that host does not, and tells no third party who is reading it. "
    + "The reply carries stdout and stderr, each capped at " + `${SCRIPT_OUTPUT_MAX}` + " bytes of UTF-8, and names "
    + "what changed, was created, unchanged, missing or refused, with version numbers — read it rather than assuming; "
    + "a refused path says why. A run may last at most " + `${SCRIPT_WALL_SECONDS}` + " seconds.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"language\":{\"type\":\"string\",\"description\":\"What runs the script: python, node or sh.\"},"
    + "\"source\":{\"type\":\"string\",\"description\":\"The whole program. It runs with the run directory as its "
    + "working directory (" + SCRIPT_RUN_DIR + "); read and write the materialised files by their relative paths, and print what you want to read back.\"},"
    + "\"paths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"The artifact paths the script "
    + "works on, named one by one, such as /report.md. A path that is not an artifact of this conversation refuses the "
    + "whole call before anything runs. An empty list is an install-only run: nothing is materialised and only "
    + "mayCreate decides whether anything the script writes is kept.\"},"
    + "\"mayCreate\":{\"type\":\"boolean\",\"description\":\"Whether files the script creates beyond paths are saved "
    + "as new artifacts. Default false: a created file is reported and dropped.\"},"
    + "\"environment\":{\"type\":\"string\",\"description\":\"Which of this conversation's environments runs it; "
    + "empty means main, the agent's own image. " + envSentence(envs)
    + " Each name is a container of its own, created on first use and kept for the "
    + "conversation, so one conversation can use several — install in one without "
    + "disturbing another. A name that is not on the list refuses rather than falling "
    + "back, because a script running without the libraries it expects fails later and "
    + "less clearly.\"}},"
    + "\"required\":[\"language\",\"source\",\"paths\"]}");
}

// The names, as a sentence the model reads — or nothing at all when the
// operator has curated no images, where naming an empty list would be worse
// than saying nothing.
function envSentence(envs: string[]): string {
  if (envs.length == 0) { return ""; }
  let names = "";
  let i: int = 0;
  while (i < envs.length) {
    if (i > 0) { names = names + (i == envs.length - 1 ? " and " : ", "); }
    names = names + envs[i];
    i = i + 1;
  }
  return "This deployment offers, by name: " + names + ".";
}

export function scriptTools(db: Db): ToolSpec[] {
  let out: ToolSpec[] = [];
  if (!scriptDockerWorks()) { return out; }
  out.push(scriptTool(scriptEnvNames(db)));
  return out;
}

// Dispatch run_script. The same contract as callArtifactTool: handled false
// for a name that is not ours or a bare run, presence checks refusing each
// missing member by name, and everything quoted back passes through wireView
// — stdout and stderr are the output of a model-written program, exactly as
// untrusted as an artifact body.
export function callScriptTool(db: Db, call: ArtifactToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.threadId == "" || call.name != "run_script") { return not; }

  if (jsonFind(call.args, "language") < 0) {
    let unnamed: FileToolResult = {
      handled: true, ok: false,
      text: "run_script needs a member named \"language\" — python, node or sh.", line: 0, changed: ""
    };
    return unnamed;
  }
  if (jsonFind(call.args, "source") < 0) {
    let unnamed: FileToolResult = {
      handled: true, ok: false,
      text: "run_script needs a member named \"source\" — the whole program to run.", line: 0, changed: ""
    };
    return unnamed;
  }
  if (jsonFind(call.args, "paths") < 0) {
    let unnamed: FileToolResult = {
      handled: true, ok: false,
      text: "run_script needs a member named \"paths\" — the artifact paths the script works on, as an array of strings.", line: 0, changed: ""
    };
    return unnamed;
  }
  let entries = jsonList(jsonRaw(call.args, "paths"));
  let paths: string[] = [];
  let p: int = 0;
  while (p < entries.length) {
    if (!entries[p].startsWith("\"")) {
      let bad: FileToolResult = {
        handled: true, ok: false,
        text: "every entry in run_script's paths must be a string naming an artifact path.", line: 0, changed: ""
      };
      return bad;
    }
    paths.push(jsonUnescape(entries[p].slice(1, entries[p].length - 1)));
    p = p + 1;
  }

  let envName = jsonText(call.args, "environment");
  let asked: ScriptRun = {
    threadId: call.threadId,
    language: jsonText(call.args, "language"),
    source: jsonText(call.args, "source"),
    paths: paths,
    // Absent reads as false — the conservative direction: nothing new is
    // saved unless the model said it may be.
    mayCreate: jsonRaw(call.args, "mayCreate") == "true",
    environment: envName,
    agentId: call.agentId,
    turnSeq: call.turnSeq,
    now: call.now,
  };
  let ran = scriptRun(db, asked);
  let answered: FileToolResult = {
    handled: true, ok: ran.ok,
    text: wireView(scriptRunAnswer(ran, envName == "" ? "main" : envName)).text, line: 0,
    // What the reconcile landed — changed versions and created files alike —
    // so the step row can say a file moved and the card can open its diff.
    changed: scriptChangedJson(ran),
  };
  return answered;
}

// The reconcile's landings as compact JSON: [{"path":"/x","version":2}, ...].
// Created files ride along — a first version diffs against nothing, but the
// chip still names what the run produced.
function scriptChangedJson(ran: ScriptRan): string {
  if (ran.changed.length == 0 && ran.created.length == 0) { return ""; }
  let out = "[";
  let first = true;
  let i: int = 0;
  while (i < ran.changed.length) {
    if (!first) { out = out + ","; }
    out = out + "{\"path\":" + JSON.stringify(ran.changed[i].path) + ",\"version\":" + `${ran.changed[i].version}` + "}";
    first = false;
    i = i + 1;
  }
  i = 0;
  while (i < ran.created.length) {
    if (!first) { out = out + ","; }
    out = out + "{\"path\":" + JSON.stringify(ran.created[i].path) + ",\"version\":" + `${ran.created[i].version}` + "}";
    first = false;
    i = i + 1;
  }
  return out + "]";
}

// The run's whole story as one reply: what happened, what the script printed,
// and what each named path came to. The model reads this instead of the run
// directory, so every list the reconcile produced is named here.
function scriptRunAnswer(ran: ScriptRan, envName: string): string {
  let out = "";
  if (ran.ok) {
    out = "The script ran in environment \"" + envName + "\".";
  } else if (ran.problem != "") {
    out = ran.problem;
  } else {
    out = "The script did not complete: it was stopped by " + ran.stopped + ".";
  }
  if (ran.recreated) {
    out = out + "\nThe environment was recreated: whatever it held between runs is gone; artifacts are unaffected.";
  }
  // The streams appear whenever the script actually ran — a refusal that
  // never reached the container has no streams to show.
  let ranAtAll = ran.ok || ran.stopped != "" || ran.stdout != "" || ran.stderr != "";
  if (ranAtAll) {
    if (ran.stdout != "") { out = out + "\nstdout:\n" + ran.stdout; } else { out = out + "\nstdout: (empty)"; }
    if (ran.stderr != "") { out = out + "\nstderr:\n" + ran.stderr; }
  }
  if (ran.changed.length > 0) { out = out + "\nchanged: " + scriptVersionList(ran.changed); }
  if (ran.created.length > 0) { out = out + "\ncreated: " + scriptVersionList(ran.created); }
  if (ran.unchanged.length > 0) { out = out + "\nunchanged: " + scriptVersionList(ran.unchanged); }
  if (ran.missing.length > 0) {
    out = out + "\ndeleted in the run directory (the artifacts keep every version): " + scriptPathList(ran.missing);
  }
  let r: int = 0;
  while (r < ran.refused.length) {
    out = out + "\nrefused: " + ran.refused[r].path + " — " + ran.refused[r].problem;
    r = r + 1;
  }
  if (!ran.ok && ran.stopped != "") {
    out = out + "\nNothing was saved: a run must complete for its files to reconcile.";
  }
  return out;
}

function scriptVersionList(list: ScriptVersioned[]): string {
  let out = "";
  let i: int = 0;
  while (i < list.length) {
    if (i > 0) { out = out + ", "; }
    out = out + list[i].path + " v" + `${list[i].version}`;
    i = i + 1;
  }
  return out;
}

function scriptPathList(list: string[]): string {
  let out = "";
  let i: int = 0;
  while (i < list.length) {
    if (i > 0) { out = out + ", "; }
    out = out + list[i];
    i = i + 1;
  }
  return out;
}

// --- skills -------------------------------------------------------------------
//
// A skill is instructions the agent loads when the task calls for them. The
// briefing lists each one as a name and a one-line description; use_skill
// answers with the body. Pay-per-use context: the description is always
// present and costs a line, the body costs nothing until a task matches.
// SKILLS.md is the design; the doctrine in one sentence is that an invariant
// that prevents a lie belongs in the prompt, and a recipe that produces an
// answer belongs in a skill.

// The skills an agent carries, by name, stably ordered for the briefing.
export function agentSkills(db: Db, agentId: string): SkillRow[] {
  // Attachment, or the public tier: a public skill answers use_skill for
  // every agent without a link row, which is what makes Docs/Sheets/Slides
  // deployment-wide instead of per-agent configuration.
  let where = "id IN (SELECT skill_id FROM agent_skills WHERE agent_id = " + placeholderAt(db, 1) + ")"
    + " OR visibility = 'public'";
  let document = listWhere(db, skillsMapping(), where, [agentId]);
  if (document == "" || document == "[]") {
    let none: SkillRow[] = [];
    return none;
  }
  let rows = JSON.parse<SkillRow[]>(document);
  // Ordered by name here rather than in SQL: listWhere takes no order, and a
  // briefing that reshuffles between turns reads as a different list. Arrays
  // are immutable, so this is a selection sort that builds the ordered list
  // rather than swapping in place — n is briefing-sized, never large.
  let out: SkillRow[] = [];
  let taken: bool[] = [];
  let t: int = 0;
  while (t < rows.length) { taken.push(false); t = t + 1; }
  let picked: int = 0;
  while (picked < rows.length) {
    let at: int = -1;
    let i: int = 0;
    while (i < rows.length) {
      if (!taken[i] && (at < 0 || rows[i].skillName < rows[at].skillName)) { at = i; }
      i = i + 1;
    }
    out.push(rows[at]);
    taken = [...taken.slice(0, at), true, ...taken.slice(at + 1)];
    picked = picked + 1;
  }
  return out;
}

// The files one skill ships, for the answer's listing and for the staging
// run-script does.
export function skillFiles(db: Db, skillId: string): SkillFileRow[] {
  let document = listWhere(db, skillFilesMapping(), "skill_id = " + placeholderAt(db, 1), [skillId]);
  if (document == "" || document == "[]") {
    let none: SkillFileRow[] = [];
    return none;
  }
  return JSON.parse<SkillFileRow[]>(document);
}

// The one skill tool. Offered only when the agent has skills — an agent with
// none is told nothing, absent rather than offered-and-failing, for the same
// reason scriptTools() vanishes without docker: a tool that can only refuse
// teaches the model a name it will keep trying.
export function skillTools(db: Db, agentId: string): ToolSpec[] {
  let none: ToolSpec[] = [];
  if (agentId == "") { return none; }
  if (agentSkills(db, agentId).length == 0) { return none; }
  let out: ToolSpec[] = [];
  out.push(toolSpec("use_skill",
    "Load the full instructions for one of your skills. Your briefing lists each skill as a name and a "
    + "one-line description; the line is for choosing, and this call is how you read the rest. When a task "
    + "matches a skill's line, load it before taking the first step the skill would govern — instructions "
    + "read mid-task cannot un-make a choice already made — and follow what comes back ahead of your own "
    + "habits for that task: the skill exists because the plain approach was tried and found wanting. "
    + "The body does not change between your calls, so load a skill once and keep working from what it "
    + "said. A skill may ship files into your run environment; the body says where they are and how to run "
    + "them — run them rather than retyping their code. A name your briefing does not list is refused; "
    + "nothing is guessed or fuzzily matched.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"name\":{\"type\":\"string\",\"description\":\"The skill to load, exactly as your briefing lists it — "
    + "character for character, including capitalization.\"}},"
    + "\"required\":[\"name\"]}"));
  return out;
}

// Skills are agent-scoped, not thread-scoped: a bare run with no thread still
// answers, so the record carries the agent and nothing else. Its own record
// rather than ArtifactToolCall, which bails on an empty threadId.
export type SkillToolCall = {
  agentId: string,
  name: string,
  args: string,
};

export function callSkillTool(db: Db, call: SkillToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.agentId == "") { return not; }

  // A skill called by its own name IS a use_skill call.
  //
  // Models reach for `search_web(query=...)` — the shape every tool they have
  // ever seen has — rather than `use_skill(name="search-web")`. Told there is
  // no such tool, a weak one repeats it: observed three times out of three on
  // a 7B, every round dead. The intent is not ambiguous, so refusing it is
  // pedantry that costs the whole answer.
  //
  // Only when the name matches a skill THIS agent carries: nothing invented
  // resolves, and a real tool never reaches here — the dispatch tries the
  // mounted tools first, so a server offering "search_web" keeps it.
  let asked = "";
  if (call.name == "use_skill") {
    // Presence-checked before anything else, the search_artifacts idiom: a
    // refusal must name the member that was absent, not complain about "".
    if (jsonFind(call.args, "name") < 0) {
      let unnamed: FileToolResult = {
        handled: true, ok: false,
        text: "use_skill needs a member named \"name\" — the skill to load, exactly as your briefing lists it.", line: 0, changed: ""
      };
      return unnamed;
    }
    asked = jsonText(call.args, "name");
  } else {
    if (!skillNamed(db, call.agentId, call.name)) { return not; }
    asked = call.name;
  }

  // A fresh read every call — the live-rows promise: an operator's edit is
  // what the very next load answers with.
  let rows = agentSkills(db, call.agentId);
  // Exact first, then the near-miss. A model asking for "search_web" when the
  // skill is "search-web" has chosen correctly and typed a separator the way
  // tool names are usually written; refusing that is pedantry with a cost —
  // observed as six exchanges of a model retrying the same underscore, being
  // told the right name each time, and finally answering from memory. The
  // fold is separators only (case, "-", "_", space), so it can never make two
  // different skills collide into one.
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].skillName == asked || sameName(rows[i].skillName, asked)) {
      let text = rows[i].body;
      let files = skillFiles(db, rows[i].id);
      if (files.length > 0) {
        // Named at the end, after the instructions that reference them, so
        // the model reads the procedure before the inventory.
        let listed = "";
        let f: int = 0;
        while (f < files.length) {
          if (f > 0) { listed = listed + ", "; }
          listed = listed + files[f].path;
          f = f + 1;
        }
        text = text + "\n\nThis skill ships files under /skills/" + rows[i].skillName + "/: "
          + listed + " — run them rather than retyping them.";
      }
      // The body is operator-written configuration, the same trust class as
      // the prompt itself — no wireView, nothing wrapped around it.
      let answered: FileToolResult = { handled: true, ok: true, text: text, line: 0, changed: "" };
      return answered;
    }
    i = i + 1;
  }

  // The refusal names what exists, so the model's next call can be right.
  let names = "";
  i = 0;
  while (i < rows.length) {
    if (i > 0) { names = names + ", "; }
    names = names + rows[i].skillName;
    i = i + 1;
  }
  let missing: FileToolResult = {
    handled: true, ok: false,
    text: "There is no skill named \"" + asked + "\". This agent has: " + names + " — use one of those names exactly.", line: 0, changed: ""
  };
  return missing;
}

// Two names that differ only in how they separate words. Lowercased, with
// "-", "_" and spaces removed: "search-web", "search_web", "Search Web" are
// one name. Nothing else is folded — a fold that reached past separators
// could quietly load a skill nobody asked for.
/* Whether this agent carries a skill by that name, folding separators. The
   guard on treating a tool call as a skill load: it has to be one of ITS
   skills, or an invented name would silently resolve to nothing useful. */
export function skillNamed(db: Db, agentId: string, name: string): bool {
  if (name == "") { return false; }
  let rows = agentSkills(db, agentId);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].skillName == name || sameName(rows[i].skillName, name)) { return true; }
    i = i + 1;
  }
  return false;
}

export function sameName(a: string, b: string): bool {
  return foldName(a) == foldName(b) && foldName(a) != "";
}

/* The environments, in the system prompt.
 *
 * The run_script schema names them too, but a tool description is read when
 * a model has already decided to call that tool — and the decision this
 * informs comes earlier: whether a task is even doable here. A model that
 * does not know a browser environment exists writes requests+BeautifulSoup
 * into the default image and fails, which is exactly what happened.
 *
 * One line per environment: the name it is called by, then what is inside.
 * Empty when the operator has curated none, because a heading over nothing
 * is furniture.
 */
export function envBriefing(db: Db): string {
  if (!scriptDockerWorks()) { return ""; }
  let names = scriptEnvNames(db);
  if (names.length == 0) { return ""; }
  let out = "run_script can run in any of these environments — pass the name as \"environment\":";
  let i: int = 0;
  while (i < names.length) {
    out = out + "\n- " + names[i];
    i = i + 1;
  }
  out = out + "\nEach is a container of its own, kept for the conversation, so one conversation"
    + " can use several. \"main\" is the agent's own image and is what an empty name means."
    + " Choose by what a task needs — fetching or driving a web page needs the browser one,"
    + " and the default image has neither a browser nor the libraries for one.";
  return out;
}

// How many skills the briefing lists in full. Past the cap the rest appear as
// names only — every skill stays loadable, and no affordance is promised that
// does not exist (the artifact overflow lesson).
export const SKILL_BRIEFING_LINES: int = 50;

export function skillBriefing(db: Db, agentId: string): string {
  let rows = agentSkills(db, agentId);
  if (rows.length == 0) { return ""; }
  let shown = rows.length < SKILL_BRIEFING_LINES ? rows.length : SKILL_BRIEFING_LINES;
  let out = "You have these skills — named instructions you can load with use_skill:";
  let i: int = 0;
  while (i < shown) {
    out = out + "\n- " + rows[i].skillName + ": " + rows[i].description;
    i = i + 1;
  }
  if (rows.length > shown) {
    let names = "";
    let n: int = shown;
    while (n < rows.length) {
      if (n > shown) { names = names + ", "; }
      names = names + rows[n].skillName;
      n = n + 1;
    }
    out = out + "\n…and also, one line each was too many: " + names + " — use_skill loads any of them.";
  }
  out = out + "\nEach line is for choosing, not for doing: when a task matches one, load the skill before starting the work.";
  // Spelled out because the failure it prevents is common and expensive: a
  // model that wants to search invents a tool called search_web, is told
  // there is no such tool, and answers from memory — confidently, about a
  // thing it cannot know. A skill is not a tool; use_skill is the only door,
  // and saying so once here is cheaper than the wrong answer.
  out = out + " There is no tool named after a skill — call use_skill with the skill's name,"
    + " and never answer from memory about anything current when a skill could have told you.";
  return out;
}

import { Db } from "../plume/driver.ts";
import { accessTokenFor, toolsOff } from "./connect.ts";
import { listWhere, placeholderAt } from "../plume/plume.ts";
import { AgentRow, McpServerRow, SkillRow, SkillFileRow, agentsMapping, mcpServersMapping, skillsMapping, skillFilesMapping } from "./schema.ts";
import { McpCall, McpTool, listTools, callTool } from "./mcp.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { reservedHere } from "./reserved.ts";
import { jsonFind, jsonList, jsonRaw, jsonText, jsonUnescape, excerptOf } from "./scan.ts";
import { normalScope } from "./knowledge.ts";
import { FileToolResult } from "./workspace.ts";
import { envEnsure, envNamed, envServePort } from "./environments.ts";
import { envMaterialise } from "./env-sync.ts";
import { EnvGranted, envGrantMint, envHostFor, envThreadOwner, envZone } from "./env-grants.ts";
import { putArtifact, getArtifact, getVersion, binaryKind, kindOf, utf8Length } from "./artifacts.ts";
import { officeText } from "./office-render.ts";
import { ArtifactSearch, searchArtifacts } from "./artifacts-search.ts";
import { editArtifact } from "./artifacts-edit.ts";
import { wireView } from "./artifacts-fence.ts";
import { SCRIPT_OUTPUT_MAX, SCRIPT_RUN_DIR, SCRIPT_WALL_SECONDS, ScriptRan, ScriptRefusal, ScriptRun, ScriptVersioned, scriptDockerWorks, scriptRun, foldName } from "./run-script.ts";

export type MountedTool = {
  name: string,
  description: string,
  schema: string,
  server: int,
};

export type Mounted = {
  tools: MountedTool[],
  servers: McpServerRow[],
  tokens: string[],
  faults: string[],
  deferred: MountedTool[],
};

const MOUNT_DIRECTLY = 12;

/* How much of a document read_artifact will put in front of the model.
 *
 * A text artifact is handed over whole, because somebody wrote it and knows
 * how big it is. A document is different: nobody sizes a PDF before attaching
 * it, and a hundred-page one extracts to more than any context we run. Sixty
 * thousand characters is roughly fifteen pages of dense text, and what is left
 * out is said in the tool's own answer. */
const READ_TEXT_MAX: int = 60000;

export function findToolsSpec(mounted: Mounted): ToolSpec {
  return toolSpec("find_tools",
    "Find tools you have access to but have not been shown yet. "
    + mountedDeferredSummary(mounted)
    + " Call this FIRST whenever a request needs one of them — search by what "
    + "you want to do (\"list issues\", \"send email\"), not by tool name. "
    + "The matching tools become callable immediately afterwards.",
    "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\","
    + "\"description\":\"What you are trying to do.\"}},\"required\":[\"query\"]}");
}

function mountedDeferredSummary(mounted: Mounted): string {
  let names: string[] = [];
  let i: int = 0;
  while (i < mounted.deferred.length) {
    let server = mounted.servers[mounted.deferred[i].server].serverName;
    if (!names.includes(server)) {
      names.push(server);
    }
    i = i + 1;
  }
  if (names.length == 0) {
    return "";
  }
  return "Waiting: " + `${stillWaiting(mounted)}` + " tools from "
    + names.join(", ") + ".";
}

export type FoundTools = {
  mounted: Mounted,
  found: MountedTool[],
};

export function findTools(mounted: Mounted, query: string, cap: int): FoundTools {
  let words = query.toLowerCase().split(" ");
  let grown: MountedTool[] = [];
  let m: int = 0;
  while (m < mounted.tools.length) {
    grown.push(mounted.tools[m]);
    m = m + 1;
  }

  let pool: MountedTool[] = [];
  let scores: int[] = [];
  let i: int = 0;
  while (i < mounted.deferred.length) {
    let t = mounted.deferred[i];
    if (mountedIndex(grown, t.name) >= 0) {
      i = i + 1;
      continue;
    }
    let name = t.name.toLowerCase();
    let hay = name + " " + t.description.toLowerCase();
    let score: int = 0;
    let w: int = 0;
    while (w < words.length) {
      let word = words[w].trim();
      if (word.length > 2) {
        if (name.includes(word)) {
          score = score + 4;
        }
        else if (hay.includes(word)) {
          score = score + 1;
        }
      }
      w = w + 1;
    }
    if (score > 0) {
      pool.push(t);
      scores.push(score);
    }
    i = i + 1;
  }

  let found: MountedTool[] = [];
  while (found.length < cap) {
    let best: int = -1;
    let k: int = 0;
    while (k < pool.length) {
      if (mountedIndex(found, pool[k].name) < 0
          && (best < 0 || scores[k] > scores[best])) {
            best = k;
          }
      k = k + 1;
    }
    if (best < 0) {
      break;
    }
    found.push(pool[best]);
    grown.push(pool[best]);
  }

  let out: Mounted = {
    tools: grown, servers: mounted.servers, tokens: mounted.tokens,
    faults: mounted.faults, deferred: mounted.deferred,
  };
  let answer: FoundTools = { mounted: out, found: found };
  return answer;
}


export function deferredBriefing(mounted: Mounted): string {
  if (stillWaiting(mounted) == 0) {
    return "";
  }
  let names: string[] = [];
  let i: int = 0;
  while (i < mounted.deferred.length) {
    let server = mounted.servers[mounted.deferred[i].server].serverName;
    if (!names.includes(server)) {
      names.push(server);
    }
    i = i + 1;
  }
  return "You are connected to " + names.join(", ") + ". Their tools are not "
    + "listed above to save room, but you have them: call find_tools with what "
    + "you are trying to do, and the tools you need become callable straight "
    + "away. Never tell someone you cannot reach " + names.join(" or ")
    + " — call find_tools first.";
}

export function stillWaiting(mounted: Mounted): int {
  let n: int = 0;
  let i: int = 0;
  while (i < mounted.deferred.length) {
    if (mountedIndex(mounted.tools, mounted.deferred[i].name) < 0) {
      n = n + 1;
    }
    i = i + 1;
  }
  return n;
}




export function agentServers(db: Db, agentId: string): McpServerRow[] {
  let where = "id IN (SELECT server_id FROM agent_mcp_servers WHERE agent_id = " + placeholderAt(db, 1) + ")";
  let document = listWhere(db, mcpServersMapping(), where, [agentId]);
  if (document == "" || document == "[]") {
    let none: McpServerRow[] = [];
    return none;
  }
  return JSON.parse<McpServerRow[]>(document);
}

export function agentChildren(db: Db, agentId: string): AgentRow[] {
  let where = "id IN (SELECT child_id FROM agent_sub_agents WHERE parent_id = " + placeholderAt(db, 1) + ")";
  let document = listWhere(db, agentsMapping(), where, [agentId]);
  if (document == "" || document == "[]") {
    let none: AgentRow[] = [];
    return none;
  }
  return JSON.parse<AgentRow[]>(document);
}

export function delegateToolName(agentName: string): string {
  let out = "ask_";
  let i: int = 0;
  while (i < agentName.length) {
    let c = agentName.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 45;
    if (ok) {
      out = out + agentName.charAt(i);
    } else {
      out = out + "_";
    }
    i = i + 1;
  }
  return out;
}

export function delegateDescription(child: AgentRow): string {
  if (child.description == "") {
    return "Ask the " + child.agentName + " agent. It answers in its own words.";
  }
  return "Ask the " + child.agentName + " agent: " + child.description;
}

export function delegateSchema(): string {
  return "{\"type\":\"object\",\"properties\":{\"question\":{\"type\":\"string\","
    + "\"description\":\"What to ask, in full. This agent cannot see your conversation, "
    + "so repeat every name, place, quantity and date the question depends on. "
    + "A question missing one of those gets an answer about something else.\"}},"
    + "\"required\":[\"question\"]}";
}

export function mountTools(db: Db, agentId: string, master: string, owner: string): Mounted {
  let tools: MountedTool[] = [];
  let deferred: MountedTool[] = [];
  let faults: string[] = [];
  let tokens: string[] = [];
  let servers = agentServers(db, agentId);

  let t: int = 0;
  while (t < servers.length) {
    let each = servers[t];
    tokens.push(accessTokenFor(db, each, owner, master));
    t = t + 1;
  }

  let s: int = 0;
  while (s < servers.length) {
    let server = servers[s];
    if (!server.enabled) {
      faults.push(server.serverName + " is disabled");
      s = s + 1;
      continue;
    }
    if (server.transport != "http") {
      faults.push(server.serverName + " speaks " + server.transport + ", which needs a subprocess this cannot spawn");
      s = s + 1;
      continue;
    }

    let token = tokens[s];
    if (server.authKind != "" && server.authKind != "none" && token == "") {
      faults.push(server.serverName + " needs a token and none is stored for it");
      s = s + 1;
      continue;
    }
    let offered = listTools(server, token);
    if (offered.length == 0) {
      faults.push(server.serverName + " listed no tools");
      s = s + 1;
      continue;
    }

    let declined = toolsOff(db, server.id);

    let i: int = 0;
    while (i < offered.length) {
      if (declined.includes(offered[i].name)) {
        i = i + 1;
        continue;
      }
      if (reservedHere(offered[i].name)) {
        // Left out rather than mounted: a provider refuses a request whose
        // tool names repeat, and it refuses the whole of it, so one shared
        // name would take the conversation down rather than one tool.
        faults.push(server.serverName + " offers \"" + offered[i].name
          + "\", which is a name this deployment already answers to, so it is not mounted");
      } else if (mountedIndex(tools, offered[i].name) >= 0) {
        faults.push(server.serverName + " also offers \"" + offered[i].name + "\", which is already mounted");
      } else {
        let t: MountedTool = {
          name: offered[i].name,
          description: offered[i].description,
          schema: offered[i].schema,
          server: s,
        };
        if (offered.length > MOUNT_DIRECTLY) {
          deferred.push(t);
        } else {
          tools.push(t);
        }
      }
      i = i + 1;
    }
    s = s + 1;
  }

  let out: Mounted = {
    tools: tools,
    servers: servers,
    tokens: tokens,
    faults: faults,
    deferred: deferred,
  };
  return out;
}

export function mountedIndex(tools: MountedTool[], name: string): int {
  let i: int = 0;
  while (i < tools.length) {
    if (tools[i].name == name) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

export function toolSpecs(mounted: Mounted): ToolSpec[] {
  let out: ToolSpec[] = [];
  let i: int = 0;
  while (i < mounted.tools.length) {
    out.push(toolSpec(mounted.tools[i].name, mounted.tools[i].description, mounted.tools[i].schema));
    i = i + 1;
  }
  return out;
}

export function callMounted(mounted: Mounted, name: string, args: string): McpCall {
  let at = mountedIndex(mounted.tools, name);
  if (at < 0) {
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

function mountedNames(mounted: Mounted): string {
  let out = "use_skill, run_script, read_artifact, write_artifact, edit_artifact";
  let i: int = 0;
  while (i < mounted.tools.length) {
    out = out + ", " + mounted.tools[i].name;
    i = i + 1;
  }
  return out;
}

export function serverOf(mounted: Mounted, name: string): string {
  let at = mountedIndex(mounted.tools, name);
  if (at < 0) {
    return "";
  }
  return mounted.servers[mounted.tools[at].server].serverName;
}

const SELF_CONTAINED: string = "An artifact may reach its siblings and nothing else. "
  + "Files you save in this same conversation are served next to each other, so a page at /index.html can link "
  + "<link rel=\"stylesheet\" href=\"css/main.css\"> or <script src=\"js/app.js\"> and they will load — save each one with its own "
  + "write_artifact call, at the path the page refers to. Images are the exception the other way: an <img> may point "
  + "at any https URL and it will load, so a photograph or a GIF from the web is allowed. Everything else from another "
  + "host is blocked — a CDN script, a Google font, a remote stylesheet is simply missing when a reader opens the page. "
  + "Draw rather than link, inline anything too small to be its own file, and prefer saving an image you were given a "
  + "URL for (fetch it in run_script) so the page keeps working when that host does not.";

export const NO_PLACEHOLDER_ARGS: string = "Never invent a value for a required argument. If a tool "
  + "needs an identifier you do not have — a team, a project, a repository, a board, a user — call the tool "
  + "that LISTS those and take the id from its answer, then make the real call. A stand-in like "
  + "\"your-team-id\", \"example\", \"<id>\" or a guessed name is not a way of asking a question: it is a call "
  + "that fails, and the person has to read an error to learn you never looked. If more than one row comes "
  + "back and nothing in the request chooses between them, ask which one. Ask for an id only when no tool you "
  + "have can find it.";

export const TEXT_CARD: string = "When your answer IS a passage the person asked you to produce "
  + "— a correction, a translation, a rewrite, a draft message — put the passage in a card so they can copy it "
  + "in one press: [TEXT]{\"title\":\"Corrected\",\"body\":\"the passage itself\"}[/TEXT]. `title` is two or "
  + "three words for what it is, and `lang` may name the language on a translation. Put ONLY the passage in "
  + "`body`, with none of your own framing, and say anything you want to say about it outside the block. Use it "
  + "only for a passage that is the answer — never for an explanation, a list, an ordinary reply, or a passage "
  + "the person wrote and you are merely quoting back.";

export const FILE_FENCE: string = "You can also create a file directly in your reply: open a code fence whose "
  + "info line names a path, like ```html path=/index.html title=Landing page — the fenced body is saved as a new "
  + "artifact and your reply keeps a one-line reference in its place. The first word after the backticks is the "
  + "language, path= takes the path as one word, and title= runs to the end of the line. A fence can only CREATE "
  + "a file that does not exist yet, and only of an inert kind: .html, .svg, .md, .json, .txt, .mmd, .puml, .dot or .vl.json. Updating a path "
  + "that already exists, and writing a script or stylesheet of any kind, must go through the write_artifact tool "
  + "— a fence that tries either is refused, and the refusal is noted. A fence without path= is ordinary quoted "
  + "code and is left alone. If you fence one new path twice in a reply, the last body is the one saved; if you "
  + "both call write_artifact on a path and fence it, the tool call wins and the fence is skipped.";

export function artifactTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  out.push(toolSpec("write_artifact",
    "Save something the user is meant to look at — a page, a diagram, a document, a data file — as an artifact of this conversation. "
    + "Writing a path that already exists appends a new version instead of replacing the old one, and the reply names the slot and version number, "
    + "which is how you refer to what you just saved when you answer. "
    + "Changing part of a file that is already here is edit_artifact's work, not this tool's: send the changed text alone, "
    + "and search_artifacts finds the line to send without reading the file. "
    + "Keep this tool for a path that does not exist yet, or a rewrite that replaces most of what is there — "
    + "a body sent whole costs its own size out of one reply's room, and a file large enough cannot be sent that way at all. "
    + "A path-carrying code fence in your Respond (```html path=/index.html) can create a new inert file the same way, but only this tool can update an existing path or write a script or stylesheet; when a reply names one path through both, this tool wins. "
    + SELF_CONTAINED,
    "{\"type\":\"object\",\"properties\":{"
    + "\"path\":{\"type\":\"string\",\"description\":\"Where it lives in this conversation, such as /report.html. Segments are letters, digits, dot and dash; the extension decides how it renders and must be one of .html, .svg, .md, .json, .txt, .mmd (a Mermaid diagram, drawn from its source), .puml (a PlantUML diagram, same), .dot (a Graphviz graph), .vl.json (a Vega-Lite chart, for showing data rather than describing it) or a source suffix.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"What to call it where artifacts are listed.\"},"
    + "\"content\":{\"type\":\"string\",\"description\":\"The whole body. This is not a patch: what you send is the new version, entire.\"},"
    + "\"note\":{\"type\":\"string\",\"description\":\"Why this version exists, in a few words. Empty is fine for a first draft.\"}},"
    + "\"required\":[\"path\",\"title\",\"content\"]}"));
  out.push(toolSpec("read_artifact",
    "Read the current version of one of this conversation's artifacts, whole. "
    + "Artifacts are self-contained — no remote scripts, styles or fonts — so what comes back is all of it, with nothing left to fetch. "
    + "This is also how you read a document somebody attached: a .pdf, .docx, .pptx or .xlsx is converted and comes back as its text, "
    + "so never open one in a script to find out what it says — that is slower, it can fail on a real document, and this tool has already done it. "
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

/* What read_artifact answers when the artifact is a document.
 *
 * It used to answer with the body, and the body of a document is base64 of its
 * own bytes. So a model asking to read an attached PDF got a wall of base64,
 * spent the context on it, and then wrote a PDF parser in a script sandbox to
 * find out what the file said — a regex over the content streams, invented
 * again on every conversation, right on the easy documents and confidently
 * wrong on the rest.
 *
 * Now the platform reads it, once, and caches the words against the version.
 * When it cannot — an image, a scan, an archive — the answer says so and
 * points at run_script, which is the one place the real bytes are useful.
 * What it never does is print base64 at a model. */
function readDocument(db: Db, artifactId: string, version: int, path: string,
                      body: string, now: string): FileToolResult {
  let words = officeText(db, {
    artifactId: artifactId, version: version, path: path, body: body, now: now,
  });
  if (!words.ok) {
    let refused: FileToolResult = {
      handled: true, ok: false,
      text: words.fault + ". " + path + " is stored as its own bytes, which are not"
        + " printed here because they are not text. To work with the file itself, name "
        + path + " in run_script's paths — it arrives in the environment under that"
        + " name — and open it there. Do not tell the person the document is empty or"
        + " says nothing: this tool did not read it.",
      line: 0, changed: "",
    };
    return refused;
  }
  let text = words.text;
  let cut = "";
  if (text.length > READ_TEXT_MAX) {
    cut = "\n\n[Cut off at " + `${READ_TEXT_MAX}` + " characters of " + `${text.length}` + "."
      + " The rest of the document is not here, so do not answer from its absence.]";
    text = excerptOf(text, READ_TEXT_MAX);
  }
  let read: FileToolResult = {
    handled: true, ok: true,
    text: path + ", read as text. Layout, images and anything drawn are not here,"
      + " so describe only what the words support.\n\n" + text + cut,
    line: 0, changed: "",
  };
  return read;
}

export type ArtifactToolCall = {
  threadId: string,
  agentId: string,
  name: string,
  args: string,
  turnSeq: int,
  now: string,
};

export function callArtifactTool(db: Db, call: ArtifactToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.threadId == "") {
    return not;
  }

  if (call.name == "write_artifact") {
    let path = normalScope(jsonText(call.args, "path"));
    let content = jsonText(call.args, "content");
    let written = putArtifact(db, {
      threadId: call.threadId,
      path: path,
      title: jsonText(call.args, "title"),
      content: content,
      note: jsonText(call.args, "note"),
      mustCreate: false,
      origin: "generated",
      turnSeq: call.turnSeq,
      now: call.now,
    });
    if (!written.ok) {
      let refused: FileToolResult = {
        handled: true,
        ok: false,
        text: written.fault,
        line: 0,
        changed: "",
      };
      return refused;
    }
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
      let broken: FileToolResult = {
        handled: true, ok: false,
        text: "Artifact " + path + " points at version " + `${artifact.currentVersion}`
          + ", which is not in its history.", line: 0, changed: ""
      };
      return broken;
    }
    if (binaryKind(kindOf(path))) {
      return readDocument(db, artifact.id, artifact.currentVersion, path, current.body, call.now);
    }
    let read: FileToolResult = {
      handled: true,
      ok: true,
      text: current.body,
      line: 0,
      changed: "",
    };
    return read;
  }

  if (call.name == "search_artifacts") {
    if (jsonFind(call.args, "query") < 0) {
      let unnamed: FileToolResult = {
        handled: true, ok: false,
        text: "search_artifacts needs a member named \"query\" — the exact text to look for.", line: 0, changed: ""
      };
      return unnamed;
    }
    let found = searchArtifacts(db, call.threadId, jsonText(call.args, "query"));
    if (!found.ok) {
      let refused: FileToolResult = {
        handled: true,
        ok: false,
        text: found.fault,
        line: 0,
        changed: "",
      };
      return refused;
    }
    let answered: FileToolResult = {
      handled: true, ok: true, text: wireView(searchAnswer(found)).text, line: 0, changed: ""
    };
    return answered;
  }

  if (call.name == "edit_artifact") {
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
      let refused: FileToolResult = {
        handled: true,
        ok: false,
        text: wireView(edited.fault).text,
        line: 0,
        changed: "",
      };
      return refused;
    }
    let changed: FileToolResult = {
      handled: true, ok: true,
      text: wireView("Edited " + normalScope(jsonText(call.args, "path")) + ": artifact " + `${edited.slot}`
        + " is now version " + `${edited.version}` + " (" + `${edited.bytes}` + " bytes)."
        + " Changed at line " + `${edited.line}` + ":\n" + edited.context).text,
      line: edited.line, changed: ""
    };
    return changed;
  }

  return not;
}

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

export function scriptEnvNames(db: Db): string[] {
  let out: string[] = [];
  let held = listWhere(db, scriptImagesMapping(), "enabled = " + placeholderAt(db, 1), ["1"]);
  if (held == "" || held == "[]") {
    return out;
  }
  let rows: ScriptImageRow[] = JSON.parse<ScriptImageRow[]>(held);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].label != "" && rows[i].image != "") {
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

function envSentence(envs: string[]): string {
  if (envs.length == 0) {
    return "";
  }
  let names = "";
  let i: int = 0;
  while (i < envs.length) {
    if (i > 0) {
      names = names + (i == envs.length - 1 ? " and " : ", ");
    }
    names = names + jsonSafe(envs[i]);
    i = i + 1;
  }
  return "This deployment offers, by name: " + names + ".";
}

export function jsonSafe(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (ch == "\"") {
      out = out + "\\\"";
    }
    else if (ch == "\\") {
      out = out + "\\\\";
    }
    else if (ch == "\n" || ch == "\r" || ch == "\t") {
      out = out + " ";
    }
    else {
      out = out + ch;
    }
    i = i + 1;
  }
  return out;
}

export function serveTool(): ToolSpec {
  return toolSpec("serve_env",
    "Put a server on the web from this conversation's environment, so the reader can look at what you are building "
    + "rather than only at what it printed. Give the command that starts it and it runs inside the container, "
    + "listening on port " + `${envServePort()}` + "; the environment is created if this conversation has none, and "
    + "started if it is stopped. What it serves is a property of the conversation and not of this call: the command "
    + "is remembered, run again whenever the container comes back, carried to whoever forks the conversation, and "
    + "shown to the reader as a button beside the chat. Call it with no command to start again what is already "
    + "remembered — which is the answer when someone asks to see it and it has gone to sleep. The container is "
    + "filled from this conversation's files before the command runs, so what you write as an artifact is what "
    + "gets served. "
    + "The environment gets a name of its own on the web and its own origin, separate from this console: nothing it "
    + "serves can read the reader's session, and nothing of the reader's credentials reaches your container. "
    + "The reply carries that address. It also carries a way in, which is good for one visit within a minute — hand "
    + "it to the reader as something to click now, and say that reopening it later needs a fresh one, because a link "
    + "that has been spent reads as broken when it is working exactly as intended. "
    + "Use this for a dev server, a preview, a documentation site: anything meant to be looked at while it runs. Use "
    + "run_script instead for work that finishes and hands back output.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"command\":{\"type\":\"string\",\"description\":\"The shell command that starts the server, run in "
    + "the container with /workspace as HOME. It must listen on port " + `${envServePort()}` + " and on 0.0.0.0, not "
    + "on localhost: a server bound to localhost inside a container is reachable by nothing. Optional once this "
    + "conversation has one: leave it out to start again what it already serves, and give it only to change that.\"},"
    + "\"image\":{\"type\":\"string\",\"description\":\"Which image to build the container from, when this "
    + "conversation has no environment yet. Optional; the conversation's usual one is used otherwise.\"},"
    + "\"name\":{\"type\":\"string\",\"description\":\"Which of this conversation's environments serves it. "
    + "Optional, and 'web' by default — the script sandbox and the dev server are better kept apart.\"}"
    + "},\"required\":[]}");
}

export function scriptTools(db: Db): ToolSpec[] {
  let out: ToolSpec[] = [];
  if (!scriptDockerWorks()) {
    return out;
  }
  out.push(scriptTool(scriptEnvNames(db)));
  // Only where there is a zone to answer on: without one there is no address to
  // give back, and a tool that cannot succeed is worse than one that is absent.
  if (envZone() != "") {
    out.push(serveTool());
  }
  return out;
}

export function callServeTool(db: Db, call: ArtifactToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.threadId == "" || call.name != "serve_env") {
    return not;
  }
  let name = jsonText(call.args, "name");
  if (name == "") {
    name = "web";
  }
  // What this conversation already serves, if anything. The command is a
  // property of the conversation rather than of the call: asked to show the
  // app again, a model that has to invent the command a second time invents a
  // different one, and the reader gets a server that is not the one they were
  // looking at.
  let held = envNamed(db, call.threadId, name);
  let command = jsonText(call.args, "command");
  if (command == "") {
    command = held.serveCmd;
  }
  if (command == "") {
    let missing: FileToolResult = {
      handled: true, ok: false,
      text: "serve_env needs a member named \"command\" — what starts the server inside the"
        + " container. This conversation has none remembered yet.",
      line: 0, changed: "",
    };
    return missing;
  }
  let owner = envThreadOwner(db, call.threadId);
  // Made first and filled before anything runs, in the order the console's own
  // route uses: a container is created empty, and this conversation's files are
  // artifacts. Starting the server against an empty workspace is how a project
  // that exists comes up as "cannot find package".
  let made = envEnsure(db, {
    threadId: call.threadId, name: name, image: jsonText(call.args, "image"),
    network: true, serve: true, command: command, start: false, now: call.now,
  });
  if (made.ok && made.created) {
    envMaterialise(db, made.slug, "/tmp/agents-env-" + made.slug);
  }
  let up = envEnsure(db, {
    threadId: call.threadId, name: name, image: jsonText(call.args, "image"),
    network: true, serve: true, command: command, start: true, now: call.now,
  });
  if (!up.ok) {
    let refused: FileToolResult = { handled: true, ok: false, text: up.fault, line: 0, changed: "" };
    return refused;
  }
  let way: EnvGranted = envGrantMint(db,
    { threadId: call.threadId, name: name, owner: owner, now: call.now });
  let said = "This conversation serves \"" + name + "\" at https://" + envHostFor(up.slug)
    + " , by running: " + command
    + "\nThat is remembered on the conversation, so it comes back with the container and"
    + " needs no command next time.";
  if (way.ok) {
    said = said + "\nA way in, good for one visit within the next minute: " + way.url;
    said = said + "\nOpening it later needs a fresh one — say so rather than letting a spent link read as broken.";
  } else {
    said = said + "\nNo way in could be minted: " + way.fault;
  }
  let done: FileToolResult = { handled: true, ok: true, text: said, line: 0, changed: "" };
  return done;
}

export function callScriptTool(db: Db, call: ArtifactToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.threadId == "" || call.name != "run_script") {
    return not;
  }

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
    changed: scriptChangedJson(ran),
  };
  return answered;
}

function scriptChangedJson(ran: ScriptRan): string {
  if (ran.changed.length == 0 && ran.created.length == 0) {
    return "";
  }
  let all: ScriptVersioned[] = [...ran.changed, ...ran.created];
  return JSON.stringify(all);
}

function scriptRunAnswer(ran: ScriptRan, envName: string): string {
  let out = "";
  if (ran.ok) {
    out = "The script ran in environment \"" + envName + "\".";
  } else if (ran.fault != "") {
    out = ran.fault;
  } else {
    out = "The script did not complete: it was stopped by " + ran.stopped + ".";
  }
  if (ran.recreated) {
    out = out + "\nThe environment was recreated: whatever it held between runs is gone; artifacts are unaffected.";
  }
  let ranAtAll = ran.ok || ran.stopped != "" || ran.stdout != "" || ran.stderr != "";
  if (ranAtAll) {
    if (ran.stdout != "") {
      out = out + "\nstdout:\n" + ran.stdout;
    } else {
      out = out + "\nstdout: (empty)";
    }
    if (ran.stderr != "") {
      out = out + "\nstderr:\n" + ran.stderr;
    }
  }
  if (ran.changed.length > 0) {
    out = out + "\nchanged: " + scriptVersionList(ran.changed);
  }
  if (ran.created.length > 0) {
    out = out + "\ncreated: " + scriptVersionList(ran.created);
  }
  if (ran.unchanged.length > 0) {
    out = out + "\nunchanged: " + scriptVersionList(ran.unchanged);
  }
  if (ran.missing.length > 0) {
    out = out + "\ndeleted in the run directory (the artifacts keep every version): " + scriptPathList(ran.missing);
  }
  let r: int = 0;
  while (r < ran.refused.length) {
    out = out + "\nrefused: " + ran.refused[r].path + " — " + ran.refused[r].fault;
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
    if (i > 0) {
      out = out + ", ";
    }
    out = out + list[i].path + " v" + `${list[i].version}`;
    i = i + 1;
  }
  return out;
}

function scriptPathList(list: string[]): string {
  let out = "";
  let i: int = 0;
  while (i < list.length) {
    if (i > 0) {
      out = out + ", ";
    }
    out = out + list[i];
    i = i + 1;
  }
  return out;
}

export function agentSkills(db: Db, agentId: string): SkillRow[] {
  let where = "id IN (SELECT skill_id FROM agent_skills WHERE agent_id = " + placeholderAt(db, 1) + ")"
    + " OR visibility = 'public'";
  let document = listWhere(db, skillsMapping(), where, [agentId]);
  if (document == "" || document == "[]") {
    let none: SkillRow[] = [];
    return none;
  }
  let rows = JSON.parse<SkillRow[]>(document);
  let out: SkillRow[] = [];
  let taken: bool[] = [];
  let t: int = 0;
  while (t < rows.length) {
    taken.push(false);
    t = t + 1;
  }
  let picked: int = 0;
  while (picked < rows.length) {
    let at: int = -1;
    let i: int = 0;
    while (i < rows.length) {
      if (!taken[i] && (at < 0 || rows[i].skillName < rows[at].skillName)) {
        at = i;
      }
      i = i + 1;
    }
    out.push(rows[at]);
    taken = [...taken.slice(0, at), true, ...taken.slice(at + 1)];
    picked = picked + 1;
  }
  return out;
}

export function skillFiles(db: Db, skillId: string): SkillFileRow[] {
  let document = listWhere(db, skillFilesMapping(), "skill_id = " + placeholderAt(db, 1), [skillId]);
  if (document == "" || document == "[]") {
    let none: SkillFileRow[] = [];
    return none;
  }
  return JSON.parse<SkillFileRow[]>(document);
}

export function skillTools(db: Db, agentId: string): ToolSpec[] {
  let none: ToolSpec[] = [];
  if (agentId == "") {
    return none;
  }
  if (agentSkills(db, agentId).length == 0) {
    return none;
  }
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

export type SkillToolCall = {
  agentId: string,
  name: string,
  args: string,
};

export function callSkillTool(db: Db, call: SkillToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.agentId == "") {
    return not;
  }

  let asked = "";
  if (call.name == "use_skill") {
    if (jsonFind(call.args, "name") < 0) {
      let unnamed: FileToolResult = {
        handled: true, ok: false,
        text: "use_skill needs a member named \"name\" — the skill to load, exactly as your briefing lists it.", line: 0, changed: ""
      };
      return unnamed;
    }
    asked = jsonText(call.args, "name");
  } else {
    // A skill may be called by its own name, but never by a name this
    // deployment already answers to. search_web and the skill search-web
    // differ by one character, and the shortcut used to hand the model its own
    // instructions back: a tool that appeared to run, in six milliseconds,
    // having searched nothing.
    if (reservedHere(call.name) || !skillNamed(db, call.agentId, call.name)) {
      return not;
    }
    asked = call.name;
  }

  let rows = agentSkills(db, call.agentId);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].skillName == asked || sameName(rows[i].skillName, asked)) {
      let text = rows[i].body;
      let files = skillFiles(db, rows[i].id);
      if (files.length > 0) {
        let listed = "";
        let f: int = 0;
        while (f < files.length) {
          if (f > 0) {
            listed = listed + ", ";
          }
          listed = listed + files[f].path;
          f = f + 1;
        }
        text = text + "\n\nThis skill ships files under /skills/" + rows[i].skillName + "/: "
          + listed + " — run them rather than retyping them.";
      }
      let answered: FileToolResult = { handled: true, ok: true, text: text, line: 0, changed: "" };
      return answered;
    }
    i = i + 1;
  }

  let names = "";
  i = 0;
  while (i < rows.length) {
    if (i > 0) {
      names = names + ", ";
    }
    names = names + rows[i].skillName;
    i = i + 1;
  }
  let missing: FileToolResult = {
    handled: true, ok: false,
    text: "There is no skill named \"" + asked + "\". This agent has: " + names + " — use one of those names exactly.", line: 0, changed: ""
  };
  return missing;
}

export function skillNamed(db: Db, agentId: string, name: string): bool {
  if (name == "") {
    return false;
  }
  let rows = agentSkills(db, agentId);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].skillName == name || sameName(rows[i].skillName, name)) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function sameName(a: string, b: string): bool {
  return foldName(a) == foldName(b) && foldName(a) != "";
}

export function envBriefing(db: Db): string {
  if (!scriptDockerWorks()) {
    return "";
  }
  let names = scriptEnvNames(db);
  if (names.length == 0) {
    return "";
  }
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

export const SKILL_BRIEFING_LINES: int = 50;

export function skillBriefing(db: Db, agentId: string): string {
  let rows = agentSkills(db, agentId);
  if (rows.length == 0) {
    return "";
  }
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
      if (n > shown) {
        names = names + ", ";
      }
      names = names + rows[n].skillName;
      n = n + 1;
    }
    out = out + "\n…and also, one line each was too many: " + names + " — use_skill loads any of them.";
  }
  out = out + "\nEach line is for choosing, not for doing: when a task matches one, load the skill before starting the work.";
  out = out + " If a skill covers what you are about to do, load it INSTEAD of writing your own"
    + " script: the skill's procedure has already met the failures yours is about to.";
  out = out + " There is no tool named after a skill — call use_skill with the skill's name,"
    + " and never answer from memory about anything current when a skill could have told you.";
  return out;
}

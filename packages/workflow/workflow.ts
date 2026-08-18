// workflow -- a graph of steps, validated and walked.
//
// The part of a workflow engine that does not know what a step does. Nodes
// and edges as data, a refusal for every way a graph can be wrong, and a walk
// that visits nodes in order carrying each one's output to the next. What a
// node DOES arrives as a function — the caller injects `step`, this package
// never imports a database, a provider or a clock, and its tests run without
// any of them.
//
// The vocabulary is nuraly's workflow canvas's, on purpose: a node typed
// "WEB_SEARCH" here is a node the canvas already has a colour and an icon
// for. The set is much smaller than the canvas's, and that is the contract —
// this package refuses what the caller cannot run, rather than the caller
// discovering it at fire time.

// A node. One flat record for every type, unused fields empty — the same
// decision TaskRow makes and for the same reason: records here are fixed
// shape, and a family of nine shapes would put a parse branch in front of
// every read.
export type WfNode = {
  id: string,
  // START, END, AGENT, LLM, CONDITION, WEB_SEARCH, KNOWLEDGE, MCP, HTTP,
  // SCRIPT, EMAIL.
  type: string,
  // What the canvas shows on the node.
  name: string,
  // Where it sits. Owned by whoever draws; the walk never reads them.
  x: number,
  y: number,
  // AGENT, LLM: what to ask, templated. CONDITION: ignored.
  instruction: string,
  // AGENT: which agent answers. "" means the workflow's own default.
  agentId: string,
  // MCP: the server row and the tool on it, and the arguments as JSON text.
  serverId: string,
  tool: string,
  args: string,
  // HTTP.
  url: string,
  method: string,
  body: string,
  // WEB_SEARCH, KNOWLEDGE: what to look for, templated.
  query: string,
  // CONDITION: how to test — "contains", "equals", "lacks" — what to look
  // for, and the text to test. EMAIL reads `subject` as the subject line. An empty subject means the previous node's
  // output, which is what a condition is almost always about. "lacks" and
  // not "matches": there is no pattern language here, and offering one that
  // silently fell back to substring search would be worse than not having it.
  test: string,
  needle: string,
  subject: string,
  // START: "" for a workflow run by hand, or words in the schedule grammar —
  // "every weekday at 08:00". The words are not validated here: the grammar
  // and the zone database live with the store, and a pure package that
  // half-checked them would disagree with the one that decides.
  schedule: string,
  // SCRIPT: the body, as written. It is compiled to wasm and run with no
  // capabilities at all — see agents/script-wasm.ts — so this text may say
  // anything and reach nothing. The source sits on the node rather than in a
  // table of its own for the reason the graph is one column: a workflow is a
  // document, and half of one is worse than none.
  //
  // OPTIONAL, and that is not a style choice. `JSON.parse<WfGraph>` requires
  // every field, and every graph stored before this field existed has no
  // "source" in it — so making it required refused those documents outright
  // and every workflow written before today stopped running, with "that is
  // not a workflow graph" as its reason. A field added to a stored document
  // has to be optional or the old documents have to be rewritten; optional is
  // the one that cannot half-finish.
  source?: string,
  // SWITCH: the values it routes on, one per line. An edge out of a switch
  // carries one of these as its `when`, or "else" for everything that
  // matched nothing — so a switch is a condition with more than two ways out
  // and the same shape underneath.
  //
  // A newline-separated string rather than a list, because WfNode is a flat
  // record with one field per idea, and the canvas's own node configuration
  // travels as scalars. Optional, for the reason `source` is.
  //
  // TELEGRAM_ASK borrows it: its cases are the OPTIONS offered to the chat,
  // sent as tap buttons. The tap comes back as a message holding exactly the
  // option's text, which is what lets a SWITCH with the same values route
  // the reply without parsing — switchBranch matches trimmed,
  // case-insensitive, so a button and a branch cannot drift apart by case.
  cases?: string,
  // TELEGRAM: which bot row this step is connected to (triggers.ts). The
  // token is NOT here and never will be — a graph is saved on every drag and
  // read back by anyone who may see the workflow, and a credential belongs in
  // the one table that encrypts it.
  //
  // Optional, for the reason `source` is; and as of the compiler's spec 481
  // that mark finally means what it says — absent parses to null instead of
  // refusing the document.
  botId?: string,
  // EMAIL: who it goes to, one address or several separated by commas,
  // templated like everything else — so a step can mail whoever an earlier
  // step named. The subject is `subject` and the message is `body`, both
  // shared with the kinds above: a node is one kind at a time, and a second
  // pair of fields meaning the same thing would only be a second thing to
  // keep in step. Who it comes FROM is not here and never will be — that is
  // the deployment's own address, and a graph that could set it would be a
  // graph that could send mail as anybody. Optional, for the reason `source`
  // is.
  to?: string,
  // HTTP: extra headers, one `Name: value` per line, values templated. For
  // everything that is NOT a secret — a content type, an accept, a version
  // pin. Optional, for the reason `source` is.
  headers?: string,
  // Which stored secrets ride along, by id, comma-separated — the botId rule
  // again: the VALUE is never here, because this document is saved on every
  // drag, served to the browser, and read aloud by show_workflow. The store
  // that owns the row also owns which header each fills and which origin each
  // may be sent to; this package only carries the references.
  //
  // On EVERY node kind rather than on HTTP alone: which steps can carry a
  // credential is the runner's business and it grows, and a field that knew
  // the answer would have to be edited every time it changed. What a step
  // DOES with an attached secret is decided where the step runs.
  secrets?: string,
  // The single-secret spelling this replaced. Read when `secrets` is empty so
  // graphs saved before the list existed keep their attachment; never
  // written. Optional for the reason `source` is.
  secretId?: string,
  // WAIT: how many seconds to pause. LOOP: how many times to run the body.
  // One field for both because a node is one kind at a time, and two spellings
  // of "how many" would only be two things to keep in step. Optional, for the
  // reason `source` is.
  amount?: string,
  // AGGREGATE: what to do with the list — "join", "count", "sum", "first" or
  // "last". Optional, for the reason `source` is.
  op?: string,
  // SUB_WORKFLOW: which workflow to run. The id of a row, never a graph
  // inline: a workflow that carried a copy of another would be a second place
  // to edit it. Optional, for the reason `source` is.
  workflowId?: string,
};

// An edge. `when` is "" for the ordinary case; a CONDITION's outgoing edges
// carry "yes" and "no" instead, and the walk follows the one the test chose.
export type WfEdge = {
  id: string,
  from: string,
  to: string,
  when: string,
};

// Where the drawing was left: pan and zoom. Carried so a saved graph reopens
// where its owner was looking, never read by anything else.
export type WfView = {
  x: number,
  y: number,
  zoom: number,
};

export type WfGraph = {
  nodes: WfNode[],
  edges: WfEdge[],
  view: WfView,
};

// What one step answered. `branch` is "" except from a CONDITION, where it
// names the edge to follow. `output` from a CONDITION is the text it tested,
// passed through, so a condition never breaks the chain of {{prev}}.
//
// `input` is what the step actually received AFTER its template was filled,
// and it is the caller's to report because only the caller knows what it
// filled. Left empty, the walk records the previous node's output instead —
// which is what {{prev}} means and is a lie the moment a step reaches for
// {{node.someOtherStep}}. A panel that shows a person "what this step was
// given" has to be given the truth or say nothing.
export type StepResult = {
  ok: bool,
  output: string,
  branch: string,
  error: string,
  input: string,
  // A step that asked a person something and cannot continue until they
  // answer. The walk stops HERE, successfully.
  suspend?: bool,
  // Where the work went, when a step did its work somewhere a person can
  // read. An AGENT step answers in a conversation — the run's own, or one of
  // its own when it names a different agent — and without this the trail
  // records that it happened but not where. Optional: no other kind of step
  // has one, and a run stored before this field must still parse.
  threadId?: string,
};

// One node's visit, as recorded. `status` is "COMPLETED" or "FAILED" — the
// canvas's own words for them, so a run's steps can be handed to the drawing
// as node statuses without a transform.
export type WfStep = {
  nodeId: string,
  type: string,
  status: string,
  ms: number,
  // The conversation this step's work is in, when it has one. See
  // StepResult.threadId.
  threadId?: string,
  // What went in and what came out. Both are kept whether the step worked or
  // not: the pair is what somebody reads to find out why it did not.
  input: string,
  output: string,
  error: string,
};

// A finished walk. `answer` is what the END node (or the last node reached)
// produced; `steps` is every visit in order, kept whether or not the walk
// succeeded — a failed run's trail is the thing somebody needs to read.
export type Walked = {
  ok: bool,
  answer: string,
  error: string,
  steps: WfStep[],
  // A walk that stopped to ASK: the id of the step waiting for a person, ""
  // for a walk that finished. The walk is over as a walk — the runner stores
  // what a resume needs and the next message from that chat continues from
  // this node's edge, with the reply as {{prev}}.
  waitingAt?: string,
  // How many nodes this walk visited. A MAP body reports it so the walk that
  // ran it can spend the run's budget rather than each iteration getting a
  // fresh one. Optional: nothing outside the walker reads it.
  visits?: int,
};

// What the walk carries between nodes. `outputs` is every finished node's
// answer by id; `prev` is the latest of them, which is what most templates
// mean.
export type WfOut = {
  nodeId: string,
  output: string,
};

export type WalkCtx = {
  input: string,
  prev: string,
  outputs: WfOut[],
};

// The limits. A graph is authored by a model as often as by a person, so the
// bound is enforced where the graph is checked, not hoped about.
export const MAX_NODES: int = 24;
export const MAX_NAME: int = 80;
export const MAX_TEXT: int = 4000;
// A script is longer than a prompt and shorter than a program. Bounded here
// because the graph is validated whole on every write, and because a compile
// is a process this deployment pays for.
export const MAX_SOURCE: int = 16384;

const KNOWN = ["START", "END", "AGENT", "LLM", "CONDITION", "WEB_SEARCH", "KNOWLEDGE", "MCP", "HTTP", "SCRIPT", "SWITCH", "TELEGRAM", "TELEGRAM_REPLY", "TELEGRAM_ASK", "EMAIL",
  "SET", "WAIT", "FILTER", "AGGREGATE", "MAP", "LOOP", "MERGE", "SUB_WORKFLOW"];

/** Whether this kind opens a body that a MERGE closes. */
export function isRepeat(kind: string): bool {
  return kind == "MAP" || kind == "LOOP";
}

// A list step runs a body once per item, and a run is a thing somebody waits
// for. Both bounds are enforced in the walk, not hoped about.
export const MAX_ITEMS: int = 50;
export const MAX_VISITS: int = 240;
// A pause a person can sit through. Longer than this is a schedule, not a
// step, and a workflow that wanted one would hold an HTTP request open.
export const MAX_WAIT_SECONDS: int = 60;

/** Whether a JSON array's element ends here: at depth zero, outside a string. */
function splitsHere(ch: string, depth: int, inside: bool): bool {
  return ch == "," && depth == 0 && !inside;
}

/** The items in a piece of text.
 *
 *  A JSON array is read as its elements, each kept as the text it was written
 *  as — a plain string unquoted, an object or a nested array whole, so a MAP
 *  body can dig into `{{prev.name}}`. Anything else is read as lines, blanks
 *  dropped, which is what a model that was asked for a list usually answers.
 *
 *  Hand-split rather than `JSON.parse<string[]>`: a list of objects is the
 *  common case and a typed parse refuses it outright. */
export function itemsOf(text: string): string[] {
  let said = text.trim();
  let out: string[] = [];
  if (said.startsWith("[") && said.endsWith("]")) {
    let body = said.slice(1, said.length - 1);
    let depth: int = 0;
    let inside = false;
    let escaped = false;
    let one = "";
    let i: int = 0;
    while (i < body.length) {
      let ch = body.charAt(i);
      if (escaped) {
        escaped = false;
        one = one + ch;
      } else if (ch == "\\") {
        escaped = true;
        one = one + ch;
      } else if (ch == "\"") {
        inside = !inside;
        one = one + ch;
      } else if (!inside && (ch == "[" || ch == "{")) {
        depth = depth + 1;
        one = one + ch;
      } else if (!inside && (ch == "]" || ch == "}")) {
        depth = depth - 1;
        one = one + ch;
      } else if (splitsHere(ch, depth, inside)) {
        if (one.trim() != "") { out.push(unquoted(one.trim())); }
        one = "";
      } else {
        one = one + ch;
      }
      i = i + 1;
    }
    if (one.trim() != "") { out.push(unquoted(one.trim())); }
    return out;
  }
  let lines = said.split("\n");
  let n: int = 0;
  while (n < lines.length) {
    if (lines[n].trim() != "") { out.push(lines[n].trim()); }
    n = n + 1;
  }
  return out;
}

/** A JSON string element as the text it holds; anything else untouched. */
function unquoted(said: string): string {
  if (!said.startsWith("\"") || !said.endsWith("\"") || said.length < 2) { return said; }
  let inner = said.slice(1, said.length - 1);
  let out = "";
  let i: int = 0;
  while (i < inner.length) {
    let ch = inner.charAt(i);
    if (ch == "\\" && i + 1 < inner.length) {
      let next = inner.charAt(i + 1);
      if (next == "n") { out = out + "\n"; } else if (next == "t") { out = out + "\t"; } else { out = out + next; }
      i = i + 2;
    } else {
      out = out + ch;
      i = i + 1;
    }
  }
  return out;
}

/** The list, back as the JSON array a later step reads with `{{prev}}`. */
export function asJsonList(items: string[]): string {
  let out = "[";
  let i: int = 0;
  while (i < items.length) {
    if (i > 0) { out = out + ","; }
    out = out + JSON.stringify(items[i]);
    i = i + 1;
  }
  return out + "]";
}

/** Whether a value passes a "contains", "equals" or "lacks" test.
 *
 *  The same reading a CONDITION gives, so a FILTER that keeps what a
 *  condition would have let through cannot drift from it. */
export function matches(how: string, needle: string, value: string): bool {
  // `how`, not `test`: the compiler reads a parameter of that name as the
  // test keyword. WfNode.test is the field; these are its values.
  let has = value.toLowerCase().includes(needle.toLowerCase());
  if (how == "contains") { return has; }
  if (how == "lacks") { return !has; }
  if (how == "equals") { return value.trim() == needle.trim(); }
  return false;
}

/** A number read off a piece of text, or 0 when it says nothing numeric. */
function numberIn(said: string): number {
  // Read by hand rather than with parseFloat: this package is compiled with
  // everything else, and pinning that function's result here changed what it
  // answered somewhere across the tree.
  let text = said.trim();
  let negative = text.startsWith("-");
  if (negative || text.startsWith("+")) { text = text.slice(1); }
  let whole = "";
  let frac = "";
  let dotted = false;
  let done = false;
  let i: int = 0;
  while (i < text.length && !done) {
    let ch = text.charAt(i);
    if (ch == "." && !dotted) {
      dotted = true;
    } else if (ch >= "0" && ch <= "9") {
      if (dotted) { frac = frac + ch; } else { whole = whole + ch; }
    } else {
      done = true;
    }
    i = i + 1;
  }
  let units: number = whole == "" ? 0.0 : ((parseInt(whole, 10) ?? 0) + 0.0);
  let value: number = units;
  if (frac != "") {
    let scale: number = 1.0;
    let f: int = 0;
    while (f < frac.length) { scale = scale * 10.0; f = f + 1; }
    let below: number = (parseInt(frac, 10) ?? 0) + 0.0;
    value = value + below / scale;
  }
  return negative ? 0.0 - value : value;
}

/** A list reduced to one value.
 *
 *  "join" is the default because it is what somebody means by "put it back
 *  together"; the rest are the questions a list gets asked. An unknown
 *  operation joins rather than failing — the graph is checked at write time,
 *  and a run is a bad place to learn about a typo. */
export function aggregated(op: string, items: string[]): string {
  if (op == "count") { return `${items.length}`; }
  if (op == "first") { return items.length == 0 ? "" : items[0]; }
  if (op == "last") { return items.length == 0 ? "" : items[items.length - 1]; }
  if (op == "sum") {
    let total: number = 0.0;
    let i: int = 0;
    while (i < items.length) {
      total = total + numberIn(items[i]);
      i = i + 1;
    }
    return `${total}`;
  }
  return items.join("\n");
}

/** Whether this is where a walk begins.
 *
 *  A workflow has exactly one, and it is either START — run by hand or by the
 *  clock — or TELEGRAM, run by a message arriving. They are the same idea
 *  wearing different clothes: the entry decides what {{input}} is, and
 *  everything after it cannot tell which one it was.
 *
 *  Modelling the trigger as an entry rather than as a step BEFORE the entry is
 *  what keeps this small. A node that fed the START step would need a rule for
 *  what happens when the clock fires a graph whose trigger did not, and there
 *  is no such rule anybody would guess. */
export function isEntry(kind: string): bool {
  // `kind`, not `type`: the compiler refuses a parameter named `type` with
  // "name shadows primitive" and says to report it. Reported, and the name
  // reads better here anyway — WfNode.type is the field, its values are kinds.
  return kind == "START" || kind == "TELEGRAM";
}

// What an unmatched value takes. Not a case somebody writes: it is the way
// out that exists whether or not they thought about it.
export const SWITCH_ELSE: string = "else";
// The label on the edge a failure takes. Named rather than spelled twice:
// the walk follows it and `refuse` allows it, and they cannot disagree.
export const ERROR_EDGE: string = "error";
// A switch with fifty ways out is a table, and a drawing is the wrong place
// for a table.
export const MAX_CASES: int = 12;

/** The values a switch routes on, in order, blanks dropped. */
// A step may carry a few credentials, not a keyring. The bound is here
// because the graph is validated whole on every write.
export const MAX_SECRETS_PER_STEP: int = 4;

/** The secrets attached to a step, by id, in order, blanks dropped.
 *
 *  Falls back to the single `secretId` this replaced, so a graph saved before
 *  the list existed still sends what it was sending. */
export function secretIds(node: WfNode): string[] {
  let out: string[] = [];
  let said = node.secrets ?? "";
  if (said.trim() == "") {
    let one = node.secretId ?? "";
    if (one.trim() != "") { out.push(one.trim()); }
    return out;
  }
  let i: int = 0;
  let piece = "";
  while (i < said.length) {
    let ch = said.charAt(i);
    if (ch == "," || ch == "\n" || ch == "\r") {
      if (piece.trim() != "") { out.push(piece.trim()); }
      piece = "";
    } else {
      piece = piece + ch;
    }
    i = i + 1;
  }
  if (piece.trim() != "") { out.push(piece.trim()); }
  return out;
}

/** An HTTP step's plain header lines, in order, blanks dropped — the same
 *  reading `casesOf` gives a switch, for the same reason: a flat record
 *  carries a list as lines, and one function decides what a line is. */
export function headerLines(node: WfNode): string[] {
  let out: string[] = [];
  let said = node.headers ?? "";
  let i: int = 0;
  let one = "";
  while (i < said.length) {
    let ch = said.charAt(i);
    if (ch == "\n" || ch == "\r") {
      if (one.trim() != "") { out.push(one.trim()); }
      one = "";
    } else {
      one = one + ch;
    }
    i = i + 1;
  }
  if (one.trim() != "") { out.push(one.trim()); }
  return out;
}

export function casesOf(node: WfNode): string[] {
  let out: string[] = [];
  let said = node.cases ?? "";
  let i: int = 0;
  let one = "";
  while (i < said.length) {
    let ch = said.charAt(i);
    if (ch == "\n" || ch == "\r") {
      if (one.trim() != "") { out.push(one.trim()); }
      one = "";
    } else {
      one = one + ch;
    }
    i = i + 1;
  }
  if (one.trim() != "") { out.push(one.trim()); }
  return out;
}

/** Which way a switch sends a value: the first case it matches, or "else".
 *
 *  Matching is exact, ignoring case and surrounding space. Not "contains":
 *  a switch whose cases are "yes" and "yes, urgently" would send both to the
 *  first, and the reader would have to know the order to predict it. */
export function switchBranch(node: WfNode, value: string): string {
  let want = value.trim().toLowerCase();
  let all = casesOf(node);
  let i: int = 0;
  while (i < all.length) {
    if (all[i].toLowerCase() == want) { return all[i]; }
    i = i + 1;
  }
  return SWITCH_ELSE;
}

export const OUTCOME_MARK: string = "OUTCOME:";

/** What a step is asked to append when its node carries outcomes, and "" when
 *  it carries none.
 *
 *  A node with outcomes is a branch point, and this is how it says which way
 *  it went. The answer itself still flows on untouched — the outcome is
 *  chosen alongside it, not parsed out of the prose. That is the thing a
 *  Switch after an agent got wrong: it made the answer double as a routing
 *  token, which is why switch subjects end up begging a model to reply in one
 *  word. */
export function outcomeAsk(node: WfNode): string {
  let all = casesOf(node);
  if (all.length == 0) {
    return "";
  }
  return "\n\nWhen you have answered, end with one final line naming which of"
    + " these the answer is, and nothing else on that line:\n"
    + OUTCOME_MARK + " <" + all.join(" | ") + ">";
}

export type WfOutcome = {
  /** The answer with the outcome line taken off. */
  text: string,
  /** What it named, before it is matched against the cases. "" if it named
   *  nothing, which is the model ignoring the instruction and lands on else. */
  picked: string,
};

/** The outcome read off the end of an answer, and the answer without it.
 *
 *  Only the last non-empty line is considered, so an answer that discusses
 *  the word OUTCOME in passing does not accidentally route on it. */
export function outcomeFrom(said: string): WfOutcome {
  let lines = said.split("\n");
  let last: int = lines.length - 1;
  while (last >= 0 && lines[last].trim() == "") {
    last = last - 1;
  }
  if (last < 0) {
    let none: WfOutcome = { text: said, picked: "" };
    return none;
  }
  let line = lines[last].trim();
  if (!line.toUpperCase().startsWith(OUTCOME_MARK)) {
    let plain: WfOutcome = { text: said, picked: "" };
    return plain;
  }
  let picked = line.slice(OUTCOME_MARK.length).trim();
  // Models like to wrap the value in the brackets the instruction showed.
  while (picked.startsWith("<") || picked.startsWith("`") || picked.startsWith("\"")) {
    picked = picked.slice(1);
  }
  while (picked.endsWith(">") || picked.endsWith("`") || picked.endsWith("\"") || picked.endsWith(".")) {
    picked = picked.slice(0, picked.length - 1);
  }
  let kept: string[] = [];
  let i: int = 0;
  while (i < last) {
    kept.push(lines[i]);
    i = i + 1;
  }
  let out: WfOutcome = { text: kept.join("\n").trim(), picked: picked.trim() };
  return out;
}

export function knownType(kind: string): bool {
  let i: int = 0;
  while (i < KNOWN.length) {
    if (KNOWN[i] == kind) { return true; }
    i = i + 1;
  }
  return false;
}

export function emptyNode(): WfNode {
  let none: WfNode = {
    id: "", type: "", name: "", x: 0.0, y: 0.0,
    instruction: "", agentId: "",
    serverId: "", tool: "", args: "",
    url: "", method: "", body: "",
    query: "", test: "", needle: "", subject: "", schedule: "", source: "",
  };
  return none;
}

export function emptyGraph(): WfGraph {
  let view: WfView = { x: 0.0, y: 0.0, zoom: 1.0 };
  let none: WfGraph = { nodes: [], edges: [], view: view };
  return none;
}

/** The graph's single entry — its START, or its TELEGRAM node — or an empty
 *  node. Named for the START it used to only ever be. */
export function startOf(graph: WfGraph): WfNode {
  let i: int = 0;
  while (i < graph.nodes.length) {
    if (isEntry(graph.nodes[i].type)) { return graph.nodes[i]; }
    i = i + 1;
  }
  return emptyNode();
}

function nodeAt(graph: WfGraph, id: string): WfNode {
  let i: int = 0;
  while (i < graph.nodes.length) {
    if (graph.nodes[i].id == id) { return graph.nodes[i]; }
    i = i + 1;
  }
  return emptyNode();
}

/** How many edges leave this node. */
function fanOut(graph: WfGraph, id: string): int {
  let n: int = 0;
  let i: int = 0;
  while (i < graph.edges.length) {
    if (graph.edges[i].from == id) { n = n + 1; }
    i = i + 1;
  }
  return n;
}

function peeledAlready(peeled: string[], id: string): bool {
  let i: int = 0;
  while (i < peeled.length) {
    if (peeled[i] == id) { return true; }
    i = i + 1;
  }
  return false;
}

/** Whether the edges contain a cycle: peel any node whose incoming edges all
 *  come from nodes already peeled, until nothing more can be; anything left
 *  is on a cycle. Kahn's algorithm, written over an append-only list because
 *  arrays here cannot be assigned into. Quadratic-and-change, which at
 *  MAX_NODES is nothing. */
function hasCycle(graph: WfGraph): bool {
  let peeled: string[] = [];
  let moved = true;
  while (moved) {
    moved = false;
    let n: int = 0;
    while (n < graph.nodes.length) {
      let id = graph.nodes[n].id;
      if (!peeledAlready(peeled, id)) {
        let held = false;
        let e: int = 0;
        while (e < graph.edges.length) {
          if (graph.edges[e].to == id && !peeledAlready(peeled, graph.edges[e].from)) {
            held = true;
          }
          e = e + 1;
        }
        if (!held) {
          peeled.push(id);
          moved = true;
        }
      }
      n = n + 1;
    }
  }
  return peeled.length < graph.nodes.length;
}

/** Everything wrong with a node's own fields, or "".
 *
 *  `ready` is what separates a drawing from a workflow. Off, this asks only
 *  that the node is a node — a known kind, an id, within its bounds — which is
 *  what a half-finished drawing has to satisfy to be stored at all. On, it
 *  also asks that somebody has said what the step does. */
function refuseNode(node: WfNode, ready: bool): string {
  if (node.id == "") { return "a node has no id"; }
  if (!knownType(node.type)) {
    return "\"" + node.type + "\" is not a step this can run — the kinds are "
      + "AGENT, LLM, CONDITION, WEB_SEARCH, KNOWLEDGE, MCP, HTTP, SCRIPT, SWITCH, "
      + "and one END beside one START or TELEGRAM";
  }
  if (node.name.length > MAX_NAME) { return "\"" + node.name.slice(0, 20) + "...\" is too long a name"; }
  if (node.instruction.length > MAX_TEXT || node.body.length > MAX_TEXT
    || node.args.length > MAX_TEXT || node.query.length > MAX_TEXT) {
    return (node.name == "" ? node.id : node.name) + " carries more text than a step may (" + `${MAX_TEXT}` + " characters)";
  }
  let label = node.name == "" ? node.id : node.name;
  // Every kind, because the field is on every kind. Whether a secret is
  // MEANINGFUL on a given step is the runner's to say; how many may be
  // attached, and that none is listed twice, is the graph's.
  let held = secretIds(node);
  if (held.length > MAX_SECRETS_PER_STEP) {
    return label + " carries " + `${held.length}` + " secrets — the most one step may carry is " + `${MAX_SECRETS_PER_STEP}`;
  }
  let d: int = 0;
  while (d < held.length) {
    let e = d + 1;
    while (e < held.length) {
      if (held[e] == held[d]) { return label + " lists the same secret twice"; }
      e = e + 1;
    }
    d = d + 1;
  }
  if (!ready) { return ""; }
  if (node.type == "AGENT" && node.instruction.trim() == "") { return label + " needs an instruction — what should the agent do?"; }
  if (node.type == "LLM" && node.instruction.trim() == "") { return label + " needs an instruction — what should the model be asked?"; }
  // TELEGRAM_REPLY: what to say. Telegram-specific on purpose, the way the
  // trigger is: "reply" with no channel behind it would be a promise this
  // engine cannot keep for a run the clock started. The one step whose whole
  // job is a sentence, so an empty one is a step that sends nothing and
  // looks like a broken bot.
  if (node.type == "TELEGRAM_REPLY" && node.instruction.trim() == "") { return label + " needs the message to send — {{prev}} sends the previous step's answer"; }
  if (node.type == "TELEGRAM_ASK" && node.instruction.trim() == "") { return label + " needs the question to ask — the person's reply becomes {{prev}}"; }
  if (node.type == "WEB_SEARCH" && node.query.trim() == "") { return label + " needs a query to search for"; }
  if (node.type == "KNOWLEDGE" && node.query.trim() == "") { return label + " needs a query to look up"; }
  if (node.type == "MCP" && (node.serverId == "" || node.tool == "")) { return label + " needs a server and a tool on it"; }
  if (node.type == "SWITCH") {
    let all = casesOf(node);
    if (all.length == 0) { return label + " has no cases — what is it choosing between?"; }
    if (all.length > MAX_CASES) {
      return label + " has " + `${all.length}` + " cases — the most a switch may have is " + `${MAX_CASES}`;
    }
    let i: int = 0;
    while (i < all.length) {
      if (all[i].toLowerCase() == SWITCH_ELSE) {
        return label + " lists \"else\" as a case, and else is the way out for everything that matched nothing";
      }
      let j = i + 1;
      while (j < all.length) {
        if (all[j].toLowerCase() == all[i].toLowerCase()) {
          return label + " lists \"" + all[i] + "\" twice — which edge would run?";
        }
        j = j + 1;
      }
      i = i + 1;
    }
  }
  if (node.type == "SCRIPT") {
    let body = node.source ?? "";
    if (body.trim() == "") { return label + " has no script in it yet"; }
    if (body.length > MAX_SOURCE) {
      return label + " is " + `${body.length}` + " characters of script — the most one step may carry is " + `${MAX_SOURCE}`;
    }
  }
  if (node.type == "EMAIL") {
    // Templated fields cannot be checked for shape here — "{{input}}" is a
    // valid address until it is filled — so this asks only that each one is
    // there. Whether the filled text is an address is the runner's answer,
    // and it refuses the whole step rather than sending half of it.
    if ((node.to ?? "").trim() == "") { return label + " has nobody to send to"; }
    if (node.subject.trim() == "") { return label + " has no subject line"; }
    if (node.body.trim() == "") { return label + " has no message in it yet"; }
    if ((node.to ?? "").length > MAX_NAME * 4) {
      return label + " names more addresses than a step may carry";
    }
  }
  if (node.type == "HTTP") {
    if (!node.url.startsWith("http://") && !node.url.startsWith("https://")) { return label + " needs a full http(s) url"; }
    let m = node.method;
    if (m != "GET" && m != "POST" && m != "PUT" && m != "DELETE" && m != "PATCH") {
      return label + ": \"" + m + "\" is not a method — GET, POST, PUT, DELETE or PATCH";
    }
    let lines = headerLines(node);
    if ((node.headers ?? "").length > MAX_TEXT) {
      return label + " carries more headers than a step may (" + `${MAX_TEXT}` + " characters)";
    }
    let h: int = 0;
    while (h < lines.length) {
      let colon = lines[h].indexOf(":");
      let name = colon < 0 ? "" : lines[h].slice(0, colon).trim();
      if (name == "" || name.indexOf(" ") >= 0) {
        return label + ": \"" + lines[h].slice(0, 40) + "\" is not a header — one \"Name: value\" per line";
      }
      h = h + 1;
    }
  }
  if (node.type == "CONDITION") {
    if (node.test != "contains" && node.test != "equals" && node.test != "lacks") {
      return label + ": a condition tests \"contains\", \"equals\" or \"lacks\"";
    }
    if (node.needle == "") { return label + " needs something to look for"; }
  }
  if (node.type == "FILTER") {
    if (node.test != "contains" && node.test != "equals" && node.test != "lacks") {
      return label + ": a filter keeps what \"contains\", \"equals\" or \"lacks\" something";
    }
    if (node.needle == "") { return label + " needs something to look for"; }
  }
  if (node.type == "SET" && node.instruction.trim() == "") {
    return label + " has nothing to set — write the value, and {{prev}} for what came before";
  }
  if (node.type == "AGGREGATE") {
    let how = (node.op ?? "").trim();
    if (how != "" && how != "join" && how != "count" && how != "sum" && how != "first" && how != "last") {
      return label + ": \"" + how + "\" is not something to do with a list — join, count, sum, first or last";
    }
  }
  if (node.type == "WAIT") {
    let held = parseInt((node.amount ?? "").trim(), 10) ?? 0;
    if (held < 1) { return label + " needs to know how many seconds to wait"; }
    if (held > MAX_WAIT_SECONDS) {
      return label + " waits " + `${held}` + " seconds — the longest a step may pause is "
        + `${MAX_WAIT_SECONDS}` + ", and longer than that is a schedule rather than a step";
    }
  }
  if (node.type == "LOOP") {
    let turns = parseInt((node.amount ?? "").trim(), 10) ?? 0;
    if (turns < 1) { return label + " needs to know how many times to run"; }
    if (turns > MAX_ITEMS) {
      return label + " would run " + `${turns}` + " times — the most a repeat may run is " + `${MAX_ITEMS}`;
    }
  }
  if (node.type == "SUB_WORKFLOW" && (node.workflowId ?? "").trim() == "") {
    return label + " needs to know which workflow to run";
  }
  return "";
}

/** Every `{{...}}` in a piece of text, in order. */
function tokensIn(text: string): string[] {
  let found: string[] = [];
  let i: int = 0;
  while (i < text.length) {
    let open = text.indexOf("{{", i);
    if (open < 0) { return found; }
    let close = text.indexOf("}}", open);
    if (close < 0) { return found; }
    found.push(text.slice(open + 2, close).trim());
    i = close + 2;
  }
  return found;
}

/** Whether the edges lead from `from` to `to`. Breadth-first over an
 *  append-only list, the shape hasCycle uses and for the same reason. */
function reaches(graph: WfGraph, from: string, to: string): bool {
  let seen: string[] = [];
  seen.push(from);
  let at: int = 0;
  while (at < seen.length) {
    let here = seen[at];
    let e: int = 0;
    while (e < graph.edges.length) {
      if (graph.edges[e].from == here) {
        let next = graph.edges[e].to;
        if (next == to) { return true; }
        if (!peeledAlready(seen, next)) { seen.push(next); }
      }
      e = e + 1;
    }
    at = at + 1;
  }
  return false;
}

/** Everything wrong with the `{{node.X}}` references in one node, or "".
 *
 *  Only `node.` is checked, and that is a deliberate line. An unrecognised
 *  token is left standing by `fill` on purpose — somebody asking a model to
 *  write a template needs to be able to type braces — but `{{node.something}}`
 *  states an intention that either resolves or does not, and until now a
 *  wrong one travelled all the way into a provider's prompt as literal text.
 *  The reader saw {{node.serach}} in the output and had no idea why.
 *
 *  Upstream, not merely present: a step cannot use what a step after it has
 *  not produced yet. The walk would leave that token standing at fire time,
 *  which is the same silence one write earlier. */
function refuseRefs(graph: WfGraph, node: WfNode): string {
  let fields: string[] = [node.instruction, node.query, node.url, node.body, node.args, node.subject];
  let label = node.name == "" ? node.id : node.name;
  let f: int = 0;
  while (f < fields.length) {
    let tokens = tokensIn(fields[f]);
    let t: int = 0;
    while (t < tokens.length) {
      let token = tokens[t];
      if (token.startsWith("node.")) {
        let rest = token.slice(5);
        // The named step is the longest id that the token begins with; the
        // remainder, if any, is a path into what it answered and is nobody's
        // business until the run.
        let named = "";
        let n: int = 0;
        while (n < graph.nodes.length) {
          let id = graph.nodes[n].id;
          if ((rest == id || rest.startsWith(id + ".")) && id.length > named.length) { named = id; }
          n = n + 1;
        }
        if (rest != "" && named == "") {
          return label + " uses {{" + token + "}}, and there is no step called \"" + rest + "\"";
        }
        if (named != "" && named == node.id) {
          return label + " uses its own answer, which does not exist yet when it runs";
        }
        if (named != "" && !reaches(graph, named, node.id)) {
          return label + " uses {{" + token + "}}, but that step does not run before it — "
            + "connect them, or use a step that does";
        }
      }
      t = t + 1;
    }
    f = f + 1;
  }
  return "";
}

/** Whether a repeat opens somewhere before this MERGE. Walks back along the
 *  plain edges, which is the only shape a body has. */
function opensBefore(graph: WfGraph, id: string): bool {
  let at = id;
  let hops: int = 0;
  while (hops <= MAX_NODES) {
    let back = "";
    let i: int = 0;
    while (i < graph.edges.length) {
      if (graph.edges[i].to == at && graph.edges[i].when == "") { back = graph.edges[i].from; }
      i = i + 1;
    }
    if (back == "") { return false; }
    if (isRepeat(nodeAt(graph, back).type)) { return true; }
    at = back;
    hops = hops + 1;
  }
  return false;
}

/** Everything wrong with a graph somebody just described, or "".
 *
 *  Run where it can still be fixed — on every write — rather than at fire
 *  time. A model authors these as often as a person does, so each refusal is
 *  a sentence the model can act on in its next call. */
export function refuse(graph: WfGraph): string {
  return refuseGraphAt(graph, true);
}

/** What a DRAWING must satisfy, which is much less.
 *
 *  A step somebody has dropped but not filled in yet is the ordinary state of
 *  a graph being drawn, and refusing it means the whole drawing cannot be
 *  stored — so the work is lost on a reload and nobody is told why. This asks
 *  only that the document is a graph: known kinds, unique ids, within its
 *  bounds, edges that arrive somewhere. Whether each step is ready is asked at
 *  publish, which is the moment it starts to matter. */
export function refuseDraft(graph: WfGraph): string {
  return refuseGraphAt(graph, false);
}

function refuseGraphAt(graph: WfGraph, ready: bool): string {
  if (graph.nodes.length == 0) { return "a workflow with no steps has nothing to run"; }
  if (graph.nodes.length > MAX_NODES) {
    return "that is " + `${graph.nodes.length}` + " steps — the most a workflow may have is " + `${MAX_NODES}`;
  }
  let starts: int = 0;
  let i: int = 0;
  while (i < graph.nodes.length) {
    let bad = refuseNode(graph.nodes[i], ready);
    if (bad != "") { return bad; }
    if (isEntry(graph.nodes[i].type)) { starts = starts + 1; }
    let j = i + 1;
    while (j < graph.nodes.length) {
      if (graph.nodes[j].id == graph.nodes[i].id) { return "two steps share the id " + graph.nodes[i].id; }
      j = j + 1;
    }
    i = i + 1;
  }
  if (ready && starts == 0) { return "a workflow needs a START step — where does it begin?"; }
  if (starts > 1) { return "a workflow begins in one place, not " + `${starts}` + " — a START step or a Telegram step, not both"; }
  // No END requirement. A walk ends at any step with nothing wired after it,
  // and what that step answered IS the workflow's answer — the walk has said
  // so all along ("the walk is over and what it has is the answer"). END was
  // ceremony on top: a node that did nothing, sent nothing since the reply
  // step took over speaking, and existed to satisfy this line. Stored graphs
  // that carry one keep working — it walks as a no-op — it is simply no
  // longer demanded, drawn by default, or the thing the answer hides behind.

  // A workflow that begins at a message must SAY something back. The END
  // step records the walk's answer but sends nothing — sending is what a
  // TELEGRAM_REPLY step is for, visibly, on the drawing — so a triggered
  // graph with no reply step is a bot that reads and never answers, and the
  // person who finds that out is the one on the phone. Refused here, where
  // the sentence can say what to add, rather than discovered there.
  if (ready && startOf(graph).type == "TELEGRAM") {
    let speaks = false;
    let r: int = 0;
    while (r < graph.nodes.length) {
      if (graph.nodes[r].type == "TELEGRAM_REPLY" || graph.nodes[r].type == "TELEGRAM_ASK") { speaks = true; }
      r = r + 1;
    }
    if (!speaks) { return "a workflow started by a message needs a Telegram reply step — without one the chat never hears back"; }
  }
  // An ASK without a chat is a question into the void: the walk would stop
  // and nothing could ever answer. It belongs behind a Telegram trigger.
  if (startOf(graph).type != "TELEGRAM") {
    let q: int = 0;
    while (q < graph.nodes.length) {
      if (graph.nodes[q].type == "TELEGRAM_ASK") {
        return "an Ask step waits for a chat's reply, so the workflow must begin at a Telegram trigger";
      }
      q = q + 1;
    }
  }

  // A repeat and its MERGE are one construct drawn as two nodes, so each is
  // refused without the other, and a body may not open a second repeat: the
  // walk gathers one list at a time and nesting would have no place to put
  // the inner one.
  let g: int = 0;
  while (g < graph.nodes.length) {
    let one = graph.nodes[g];
    let named = one.name == "" ? one.id : one.name;
    if (isRepeat(one.type)) {
      let closing = mergeAfter(graph, one.id);
      if (ready && closing == "") {
        return named + " has no MERGE after it, so what it works through has nowhere to gather";
      }
      let inside = nextId(graph, one.id, "");
      let hops: int = 0;
      while (inside != "" && inside != closing && hops <= MAX_NODES) {
        if (isRepeat(nodeAt(graph, inside).type)) {
          return named + " repeats around another repeat, and one list at a time is all this gathers";
        }
        inside = nextId(graph, inside, "");
        hops = hops + 1;
      }
    }
    if (ready && one.type == "MERGE" && !opensBefore(graph, one.id)) {
      return named + " gathers results, but nothing before it works through a list";
    }
    g = g + 1;
  }

  let e: int = 0;
  while (e < graph.edges.length) {
    let edge = graph.edges[e];
    let from = nodeAt(graph, edge.from);
    let to = nodeAt(graph, edge.to);
    if (from.id == "") { return "an edge leaves a step that does not exist: " + edge.from; }
    if (to.id == "") { return "an edge arrives at a step that does not exist: " + edge.to; }
    if (edge.from == edge.to) { return (from.name == "" ? from.id : from.name) + " connects to itself"; }
    if (isEntry(to.type)) {
      // Named for what it is. A graph that begins at START keeps the sentence
      // it always had; one that begins at a trigger gets the word somebody
      // drew on the board.
      return to.type == "START" ? "nothing connects INTO the START step"
        : "nothing connects INTO a trigger — it is where the workflow begins";
    }
    if (from.type == "END") { return "nothing connects OUT of an END step"; }
    // A step that carries outcomes branches on them, the same way a switch
    // branches on its cases. Anything else with a labelled edge is a drawing
    // mistake, and the sentence names what may branch.
    let branches = from.type == "CONDITION" || from.type == "SWITCH" || casesOf(from).length > 0;
    // Any step may be drawn a way out of a failure, so the error edge is not
    // branching in the sense the rest of this is: it is the road not taken.
    if (edge.when == ERROR_EDGE && !isEntry(from.type) && from.type != "MERGE") { }
    else if (edge.when != "" && !branches) {
      return "only a CONDITION, a SWITCH, or a step with outcomes branches — the edge out of "
        + (from.name == "" ? from.id : from.name) + " cannot carry \"" + edge.when + "\"";
    }
    if (edge.when != "" && edge.when != ERROR_EDGE && from.type != "CONDITION" && from.type != "SWITCH") {
      // Its outcomes, or else. A label that is neither is an edge left behind
      // by an outcome somebody renamed, and it would never be taken.
      let known = edge.when == SWITCH_ELSE;
      let all = casesOf(from);
      let c: int = 0;
      while (c < all.length) {
        if (all[c] == edge.when) { known = true; }
        c = c + 1;
      }
      if (!known) {
        return "\"" + edge.when + "\" is not an outcome of "
          + (from.name == "" ? from.id : from.name) + " — its outcomes are "
          + all.join(", ") + ", or \"" + SWITCH_ELSE + "\"";
      }
    }
    if (from.type == "CONDITION") {
      if (edge.when == "") { return "each edge out of a condition says which way — \"yes\" or \"no\""; }
      if (edge.when != "yes" && edge.when != "no") {
        return "\"" + edge.when + "\" is not a branch — a condition's edges are \"yes\" and \"no\"";
      }
    }
    if (from.type == "SWITCH") {
      if (edge.when == "") {
        return "each edge out of " + (from.name == "" ? from.id : from.name)
          + " says which case it is for, or \"else\"";
      }
      if (edge.when != SWITCH_ELSE) {
        // An edge for a case nobody declared is an edge that can never run,
        // and the drawing gives no hint of it — so it is refused at the write
        // rather than discovered as a branch that never fires.
        let known = false;
        let all = casesOf(from);
        let c: int = 0;
        while (c < all.length) {
          if (all[c] == edge.when) { known = true; }
          c = c + 1;
        }
        if (!known) {
          return (from.name == "" ? from.id : from.name) + " has no case \"" + edge.when
            + "\" — its cases are the lines in its own list";
        }
      }
    }
    let d = e + 1;
    while (d < graph.edges.length) {
      if (graph.edges[d].from == edge.from && graph.edges[d].when == edge.when) {
        return (from.name == "" ? from.id : from.name) + " has two \""
          + (edge.when == "" ? "next" : edge.when) + "\" edges — which one runs?";
      }
      d = d + 1;
    }
    e = e + 1;
  }
  if (hasCycle(graph)) { return "the steps loop back on themselves — a workflow runs forward and ends"; }
  // References last: they are checked against the edges, so the edges have to
  // have been found sound first — and a cyclic graph would make "does it run
  // before me" a question with no answer.
  let r: int = 0;
  while (r < graph.nodes.length) {
    let wrong = refuseRefs(graph, graph.nodes[r]);
    if (wrong != "") { return wrong; }
    r = r + 1;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Reaching into a step's answer
// ---------------------------------------------------------------------------
//
// An HTTP step answers a whole JSON document and a person wants one field of
// it. Without a path the only way to use `status` is to hand a model the
// entire body and ask it to read the field out — a model call to do what a
// substring does, and one that can get it wrong.
//
// This is a level-by-level walk, deliberately unlike agents/scan.ts, which
// answers the FIRST match of a key at ANY depth. That is the right shape for
// reading a provider's reply, whose nesting is the provider's business, and
// the wrong shape for a path: `{{node.h.error}}` must mean the error at the
// top of that answer, not an `error` buried three levels down inside some
// unrelated member. A path that is wrong should miss.
//
// It lives here rather than being imported because this package depends on
// nothing — that is what lets its tests run without a database, a provider or
// a clock — and a reader is seventy lines.

export type Dug = {
  ok: bool,
  text: string,
};

function jsBlank(ch: string): bool {
  return ch == " " || ch == "\n" || ch == "\t" || ch == "\r";
}

/** The text of the value that starts at `from`, quotes and braces included. */
function valueAt(doc: string, from: int): string {
  let i = from;
  while (i < doc.length && jsBlank(doc.charAt(i))) { i = i + 1; }
  if (i >= doc.length) { return ""; }
  let start = i;
  let first = doc.charAt(i);
  if (first == "\"") {
    i = i + 1;
    while (i < doc.length) {
      let ch = doc.charAt(i);
      if (ch == "\\") { i = i + 2; continue; }
      if (ch == "\"") { return doc.slice(start, i + 1); }
      i = i + 1;
    }
    return "";
  }
  if (first == "{" || first == "[") {
    let depth: int = 0;
    let inString = false;
    while (i < doc.length) {
      let ch = doc.charAt(i);
      if (inString) {
        if (ch == "\\") { i = i + 2; continue; }
        if (ch == "\"") { inString = false; }
        i = i + 1;
        continue;
      }
      if (ch == "\"") { inString = true; i = i + 1; continue; }
      if (ch == "{" || ch == "[") { depth = depth + 1; }
      if (ch == "}" || ch == "]") {
        depth = depth - 1;
        if (depth == 0) { return doc.slice(start, i + 1); }
      }
      i = i + 1;
    }
    return "";
  }
  while (i < doc.length) {
    let ch = doc.charAt(i);
    if (ch == "," || ch == "}" || ch == "]" || jsBlank(ch)) { return doc.slice(start, i); }
    i = i + 1;
  }
  return doc.slice(start, doc.length);
}

/** The value of `key` at the TOP level of the object `doc`, or ok:false. */
function memberOf(doc: string, key: string): Dug {
  let missing: Dug = { ok: false, text: "" };
  let i: int = 0;
  while (i < doc.length && jsBlank(doc.charAt(i))) { i = i + 1; }
  if (i >= doc.length || doc.charAt(i) != "{") { return missing; }
  i = i + 1;
  while (i < doc.length) {
    while (i < doc.length && (jsBlank(doc.charAt(i)) || doc.charAt(i) == ",")) { i = i + 1; }
    if (i >= doc.length || doc.charAt(i) == "}") { return missing; }
    if (doc.charAt(i) != "\"") { return missing; }
    let name = "";
    let j = i + 1;
    while (j < doc.length) {
      let ch = doc.charAt(j);
      if (ch == "\\") { name = name + doc.slice(j + 1, j + 2); j = j + 2; continue; }
      if (ch == "\"") { break; }
      name = name + ch;
      j = j + 1;
    }
    if (j >= doc.length) { return missing; }
    let after = j + 1;
    while (after < doc.length && jsBlank(doc.charAt(after))) { after = after + 1; }
    if (after >= doc.length || doc.charAt(after) != ":") { return missing; }
    let held = valueAt(doc, after + 1);
    if (name == key) {
      let got: Dug = { ok: true, text: held };
      return got;
    }
    // Past this member's value, on to the next.
    let value = valueAt(doc, after + 1);
    let at = doc.indexOf(value, after + 1);
    i = at < 0 ? doc.length : at + value.length;
  }
  return missing;
}

/** The nth element of the array `doc`, or ok:false. */
function elementOf(doc: string, n: int): Dug {
  let missing: Dug = { ok: false, text: "" };
  let i: int = 0;
  while (i < doc.length && jsBlank(doc.charAt(i))) { i = i + 1; }
  if (i >= doc.length || doc.charAt(i) != "[") { return missing; }
  i = i + 1;
  let seen: int = 0;
  while (i < doc.length) {
    while (i < doc.length && (jsBlank(doc.charAt(i)) || doc.charAt(i) == ",")) { i = i + 1; }
    if (i >= doc.length || doc.charAt(i) == "]") { return missing; }
    let value = valueAt(doc, i);
    if (value == "") { return missing; }
    if (seen == n) {
      let got: Dug = { ok: true, text: value };
      return got;
    }
    seen = seen + 1;
    i = i + value.length;
  }
  return missing;
}

/** A quoted string as its characters; anything else as it stands. */
function plain(value: string): string {
  if (value.length < 2 || value.charAt(0) != "\"") { return value; }
  let out = "";
  let i: int = 1;
  while (i < value.length - 1) {
    let ch = value.charAt(i);
    if (ch == "\\" && i + 1 < value.length - 1) {
      let next = value.charAt(i + 1);
      if (next == "n") { out = out + "\n"; }
      else if (next == "t") { out = out + "\t"; }
      else if (next == "r") { out = out + "\r"; }
      else { out = out + next; }
      i = i + 2;
      continue;
    }
    out = out + ch;
    i = i + 1;
  }
  return out;
}

/** The value at a dotted path inside JSON text.
 *
 *  `body.items.0.name` — a segment that is all digits indexes an array, any
 *  other segment names a member. A miss at any level is a miss, never a
 *  guess: the caller leaves the token standing so the person can see their
 *  path was wrong rather than reading an empty space. */
export function dig(document: string, path: string): Dug {
  let missing: Dug = { ok: false, text: "" };
  if (path == "") { return missing; }
  let here = document;
  let rest = path;
  while (rest != "") {
    let dot = rest.indexOf(".");
    let part = dot < 0 ? rest : rest.slice(0, dot);
    rest = dot < 0 ? "" : rest.slice(dot + 1);
    if (part == "") { return missing; }
    let digits = true;
    let d: int = 0;
    while (d < part.length) {
      let ch = part.charAt(d);
      if (ch < "0" || ch > "9") { digits = false; }
      d = d + 1;
    }
    let step = digits ? elementOf(here, parseInt(part, 10) ?? 0) : memberOf(here, part);
    if (!step.ok) { return missing; }
    here = step.text;
  }
  let found: Dug = { ok: true, text: plain(here) };
  return found;
}

/** `{{input}}`, `{{prev}}` and `{{node.<id>}}`, filled from the walk so far —
 *  and any of the last two followed by a path into the JSON it answered,
 *  `{{node.fetch.body.status}}`.
 *
 *  An unknown token is left standing rather than silently emptied: a template
 *  that names a node wrongly should look wrong in the output it produced, not
 *  vanish into text that reads as though nothing was meant to be there. The
 *  same rule covers a path that misses. */
export function fill(text: string, ctx: WalkCtx): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let open = text.indexOf("{{", i);
    if (open < 0) {
      out = out + text.slice(i);
      return out;
    }
    let close = text.indexOf("}}", open);
    if (close < 0) {
      out = out + text.slice(i);
      return out;
    }
    out = out + text.slice(i, open);
    let token = text.slice(open + 2, close).trim();
    if (token == "input") {
      out = out + ctx.input;
    } else if (token == "prev") {
      out = out + ctx.prev;
    } else if (token.startsWith("prev.")) {
      let inside = dig(ctx.prev, token.slice(5));
      out = out + (inside.ok ? inside.text : text.slice(open, close + 2));
    } else if (token.startsWith("node.")) {
      let rest = token.slice(5);
      let found = false;
      let o: int = 0;
      while (o < ctx.outputs.length) {
        let id = ctx.outputs[o].nodeId;
        if (!found && rest == id) {
          out = out + ctx.outputs[o].output;
          found = true;
        } else if (!found && rest.startsWith(id + ".")) {
          // The id ends where the path begins. Tested against the ids in
          // hand rather than split on the first dot, because an id is
          // whatever the drawing called it and may well hold one.
          let inside = dig(ctx.outputs[o].output, rest.slice(id.length + 1));
          if (inside.ok) {
            out = out + inside.text;
            found = true;
          }
        }
        o = o + 1;
      }
      if (!found) { out = out + text.slice(open, close + 2); }
    } else {
      out = out + text.slice(open, close + 2);
    }
    i = close + 2;
  }
  return out;
}

/** The edge to follow out of `from`, given the branch its step chose. */
function nextId(graph: WfGraph, from: string, branch: string): string {
  let i: int = 0;
  while (i < graph.edges.length) {
    if (graph.edges[i].from == from && graph.edges[i].when == branch) {
      return graph.edges[i].to;
    }
    i = i + 1;
  }
  return "";
}

function failedWalk(why: string, steps: WfStep[]): Walked {
  let done: Walked = { ok: false, answer: "", error: why, steps: steps };
  return done;
}

/** The walk: from START, along the edges, one step at a time.
 *
 *  `step` is what a node does and is the caller's; `clock` is milliseconds
 *  and is the caller's too, so a test can hand in a counter and assert on
 *  durations without waiting for any. A step that answers `ok: false` ends
 *  the walk with its reason and everything already recorded — the trail of a
 *  failed run is the point of keeping one.
 *
 *  `watch` hears the trail as it grows: once before each step runs — with
 *  the node underway as `at` — and once after, with `at` empty. A caller
 *  that persists what it hears gives anything polling the run a live
 *  drawing; a caller that wants none of that passes a function that does
 *  nothing. It is a parameter of the walk rather than something the caller
 *  wraps around `step`, because the trail is the WALKER's record, and a
 *  closure out here may not grow a list of its own (captured mutation is
 *  refused by the language, and rightly).
 *
 *  The walk trusts `refuse` ran at write time but does not depend on it: a
 *  visit counter bounds the loop, so a graph that lied its way into the
 *  database walks MAX_NODES steps and stops rather than running forever. */
export function walk(graph: WfGraph, input: string,
                     step: (node: WfNode, ctx: WalkCtx) => StepResult,
                     clock: () => number,
                     watch: (steps: WfStep[], at: WfNode) => void): Walked {
  let steps: WfStep[] = [];
  let start = startOf(graph);
  if (start.id == "") { return failedWalk("this workflow has no START step", steps); }
  let outs: WfOut[] = [];
  let ctx: WalkCtx = { input: input, prev: input, outputs: outs };
  return walkOn(graph, input, start, ctx, steps, step, clock, watch, "", MAX_VISITS);
}

/** The walk, resumed past an ASK step: the person answered, and their reply
 *  is what the asking node is now considered to have said — {{prev}} and
 *  {{node.<ask>}} both resolve to it downstream. `priorOuts` is the first
 *  half's outputs, so references to steps before the question keep working
 *  across the gap. The steps answered are the RESUMED half only; the runner
 *  appends them to the trail it stored at suspension. */
export function walkFrom(graph: WfGraph, input: string, askId: string, reply: string,
                         priorOuts: WfOut[],
                         step: (node: WfNode, ctx: WalkCtx) => StepResult,
                         clock: () => number,
                         watch: (steps: WfStep[], at: WfNode) => void): Walked {
  let steps: WfStep[] = [];
  let outs: WfOut[] = [];
  let i: int = 0;
  while (i < priorOuts.length) {
    if (priorOuts[i].nodeId != askId) { outs.push(priorOuts[i]); }
    i = i + 1;
  }
  let said: WfOut = { nodeId: askId, output: reply };
  outs.push(said);
  let to = nextId(graph, askId, "");
  if (to == "") {
    // The question was the last step drawn. The reply is the answer, and
    // there is nothing left to walk.
    let done: Walked = { ok: true, answer: reply, error: "", steps: steps };
    return done;
  }
  let at = nodeAt(graph, to);
  if (at.id == "") { return failedWalk("the step after the question is gone — the workflow changed while waiting", steps); }
  let ctx: WalkCtx = { input: input, prev: reply, outputs: outs };
  return walkOn(graph, input, at, ctx, steps, step, clock, watch, "", MAX_VISITS);
}

/** The MERGE that closes a repeat, found by following the plain edges out of
 *  it. "" when nothing after it merges, which `refuse` already rejected. */
function mergeAfter(graph: WfGraph, from: string): string {
  let at = nextId(graph, from, "");
  let hops: int = 0;
  while (at != "" && hops <= MAX_NODES) {
    if (nodeAt(graph, at).type == "MERGE") { return at; }
    at = nextId(graph, at, "");
    hops = hops + 1;
  }
  return "";
}

/** What a LOOP iterates: its turns, numbered from one, as a list. A loop is a
 *  map over a count, so it walks the same body machinery. */
function turnsOf(node: WfNode): string[] {
  let want = parseInt((node.amount ?? "").trim(), 10) ?? 0;
  let out: string[] = [];
  let i: int = 1;
  while (i <= want) {
    out.push(`${i}`);
    i = i + 1;
  }
  return out;
}

/** One visit, written down. */
function record(at: WfNode, did: StepResult, prev: string, took: number): WfStep {
  let one: WfStep = {
    nodeId: at.id, type: at.type,
    status: did.ok ? "COMPLETED" : "FAILED",
    ms: took,
    input: did.input == "" ? prev : did.input,
    output: did.output, error: did.error,
    threadId: did.threadId ?? "",
  };
  return one;
}

function stepDone(output: string): StepResult {
  let r: StepResult = { ok: true, output: output, branch: "", error: "", input: "" };
  return r;
}

function walkOn(graph: WfGraph, input: string, first: WfNode, ctx0: WalkCtx, steps: WfStep[],
                step: (node: WfNode, ctx: WalkCtx) => StepResult,
                clock: () => number,
                watch: (steps: WfStep[], at: WfNode) => void,
                stopAt: string, budget: int): Walked {
  // A list of our own: WalkCtx is a record and records are immutable, so the
  // walk grows this and rebuilds the record around it each step.
  let outs: WfOut[] = [];
  let seed: int = 0;
  while (seed < ctx0.outputs.length) { outs.push(ctx0.outputs[seed]); seed = seed + 1; }
  let ctx: WalkCtx = { input: ctx0.input, prev: ctx0.prev, outputs: outs };
  let at = first;
  let visited: int = 0;
  let last = ctx0.prev;
  while (visited < budget) {
    if (at.id == stopAt && stopAt != "") {
      let upto: Walked = { ok: true, answer: last, error: "", steps: steps, visits: visited };
      return upto;
    }
    visited = visited + 1;
    // A repeat is control flow, not work: the walker runs its body once per
    // item rather than asking the caller what the node does.
    if (isRepeat(at.type)) {
      let listed = at.type == "LOOP" ? turnsOf(at)
        : itemsOf(at.query.trim() == "" ? ctx.prev : fill(at.query, ctx));
      let opened = at;
      watch(steps, opened);
      let t0 = clock();
      steps.push(record(opened, stepDone(asJsonList(listed)), ctx.prev, clock() - t0));
      watch(steps, emptyNode());
      if (listed.length > MAX_ITEMS) {
        return failedWalk((opened.name == "" ? opened.id : opened.name) + " has "
          + `${listed.length}` + " items to work through — the most one step may take is "
          + `${MAX_ITEMS}`, steps);
      }
      let closing = mergeAfter(graph, opened.id);
      if (closing == "") {
        return failedWalk((opened.name == "" ? opened.id : opened.name)
          + " has no MERGE after it, so its results have nowhere to gather", steps);
      }
      let bodyStart = nextId(graph, opened.id, "");
      let collected: string[] = [];
      let i: int = 0;
      while (i < listed.length) {
        if (bodyStart == "" || bodyStart == closing) {
          collected.push(listed[i]);
        } else {
          // Each turn gets the outputs of everything before the repeat and
          // its own item as {{prev}}. What a turn produced stays in the turn.
          let turnCtx: WalkCtx = { input: input, prev: listed[i], outputs: outs };
          // Its own list, copied back afterwards. A list handed to a call does
          // not carry what the call pushed onto it, and a turn that left no
          // trail is a run nobody can read.
          let turnSteps: WfStep[] = [];
          let ran = walkOn(graph, input, nodeAt(graph, bodyStart), turnCtx, turnSteps, step, clock,
            watch, closing, budget - visited);
          let k: int = 0;
          while (k < ran.steps.length) { steps.push(ran.steps[k]); k = k + 1; }
          visited = visited + (ran.visits ?? 0);
          if (!ran.ok) { return failedWalk(ran.error, steps); }
          if ((ran.waitingAt ?? "") != "") {
            return failedWalk("a step inside " + (opened.name == "" ? opened.id : opened.name)
              + " stopped to ask a question, and a repeat cannot wait for an answer", steps);
          }
          collected.push(ran.answer);
        }
        i = i + 1;
      }
      let merged = nodeAt(graph, closing);
      watch(steps, merged);
      let m0 = clock();
      let gathered = asJsonList(collected);
      steps.push(record(merged, stepDone(gathered), ctx.prev, clock() - m0));
      watch(steps, emptyNode());
      let mine: WfOut = { nodeId: merged.id, output: gathered };
      outs.push(mine);
      ctx = { input: input, prev: gathered, outputs: outs };
      last = gathered;
      let onward = nextId(graph, merged.id, "");
      if (onward == "") {
        let done: Walked = { ok: true, answer: gathered, error: "", steps: steps, visits: visited };
        return done;
      }
      at = nodeAt(graph, onward);
      if (at.id == "") { return failedWalk("an edge points at a step that does not exist: " + onward, steps); }
      continue;
    }
    watch(steps, at);
    let t0 = clock();
    let did = step(at, ctx);
    let took = clock() - t0;
    steps.push(record(at, did, ctx.prev, took));
    watch(steps, emptyNode());
    if (!did.ok) {
      // A step somebody drew a way out of does not end the run: the failure
      // travels down the edge labelled "error" as {{prev}}, which is the only
      // thing a recovery step has to work with.
      let rescue = nextId(graph, at.id, ERROR_EDGE);
      if (rescue == "") {
        return failedWalk((at.name == "" ? at.type : at.name) + ": " + did.error, steps);
      }
      ctx = { input: input, prev: did.error, outputs: outs };
      last = did.error;
      at = nodeAt(graph, rescue);
      if (at.id == "") { return failedWalk("an edge points at a step that does not exist: " + rescue, steps); }
      continue;
    }
    let out: WfOut = { nodeId: at.id, output: did.output };
    outs.push(out);
    ctx = { input: input, prev: did.output, outputs: outs };
    last = did.output;
    if (did.suspend ?? false) {
      // Stopped to ask a person. Successful as far as it went; the runner
      // stores the context and the next message resumes past this node.
      let paused: Walked = { ok: true, answer: did.output, error: "", steps: steps, waitingAt: at.id, visits: visited };
      return paused;
    }
    if (at.type == "END") {
      let done: Walked = { ok: true, answer: did.output, error: "", steps: steps, visits: visited };
      return done;
    }
    let to = nextId(graph, at.id, did.branch);
    if (to == "") {
      // A branch nothing was drawn for, or a node somebody left dangling: the
      // walk is over and what it has is the answer.
      //
      // This looked like a trap worth closing while outcomes were being added
      // — a node that gains outcomes keeps an edge labelled "", matches no
      // outcome, and ends the run early looking successful. It is not: a
      // CONDITION with only "yes" wired is how a graph says "if no, we are
      // done", and it is tested. The fix for the outcome case belongs in the
      // editor, which knows an edge is about to be orphaned and can relabel
      // it, rather than here, where it would break drawings that are correct.
      let done: Walked = { ok: true, answer: did.output, error: "", steps: steps, visits: visited };
      return done;
    }
    at = nodeAt(graph, to);
    if (at.id == "") { return failedWalk("an edge points at a step that does not exist: " + to, steps); }
  }
  return failedWalk("the walk did not finish within " + `${budget}` + " steps", steps);
}

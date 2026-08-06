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
  // START, END, AGENT, LLM, CONDITION, WEB_SEARCH, KNOWLEDGE, MCP, HTTP.
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
  // for, and the text to test. An empty subject means the previous node's
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
export type StepResult = {
  ok: bool,
  output: string,
  branch: string,
  error: string,
};

// One node's visit, as recorded. `status` is "COMPLETED" or "FAILED" — the
// canvas's own words for them, so a run's steps can be handed to the drawing
// as node statuses without a transform.
export type WfStep = {
  nodeId: string,
  type: string,
  status: string,
  ms: number,
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

const KNOWN = ["START", "END", "AGENT", "LLM", "CONDITION", "WEB_SEARCH", "KNOWLEDGE", "MCP", "HTTP"];

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
    query: "", test: "", needle: "", subject: "", schedule: "",
  };
  return none;
}

export function emptyGraph(): WfGraph {
  let view: WfView = { x: 0.0, y: 0.0, zoom: 1.0 };
  let none: WfGraph = { nodes: [], edges: [], view: view };
  return none;
}

/** The graph's single START, or an empty node. */
export function startOf(graph: WfGraph): WfNode {
  let i: int = 0;
  while (i < graph.nodes.length) {
    if (graph.nodes[i].type == "START") { return graph.nodes[i]; }
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

/** Everything wrong with a node's own fields, or "". */
function refuseNode(node: WfNode): string {
  if (node.id == "") { return "a node has no id"; }
  if (!knownType(node.type)) {
    return "\"" + node.type + "\" is not a step this can run — the kinds are "
      + "AGENT, LLM, CONDITION, WEB_SEARCH, KNOWLEDGE, MCP, HTTP, and one START and END";
  }
  if (node.name.length > MAX_NAME) { return "\"" + node.name.slice(0, 20) + "...\" is too long a name"; }
  if (node.instruction.length > MAX_TEXT || node.body.length > MAX_TEXT
    || node.args.length > MAX_TEXT || node.query.length > MAX_TEXT) {
    return (node.name == "" ? node.id : node.name) + " carries more text than a step may (" + `${MAX_TEXT}` + " characters)";
  }
  let label = node.name == "" ? node.id : node.name;
  if (node.type == "AGENT" && node.instruction.trim() == "") { return label + " needs an instruction — what should the agent do?"; }
  if (node.type == "LLM" && node.instruction.trim() == "") { return label + " needs an instruction — what should the model be asked?"; }
  if (node.type == "WEB_SEARCH" && node.query.trim() == "") { return label + " needs a query to search for"; }
  if (node.type == "KNOWLEDGE" && node.query.trim() == "") { return label + " needs a query to look up"; }
  if (node.type == "MCP" && (node.serverId == "" || node.tool == "")) { return label + " needs a server and a tool on it"; }
  if (node.type == "HTTP") {
    if (!node.url.startsWith("http://") && !node.url.startsWith("https://")) { return label + " needs a full http(s) url"; }
    let m = node.method;
    if (m != "GET" && m != "POST" && m != "PUT" && m != "DELETE" && m != "PATCH") {
      return label + ": \"" + m + "\" is not a method — GET, POST, PUT, DELETE or PATCH";
    }
  }
  if (node.type == "CONDITION") {
    if (node.test != "contains" && node.test != "equals" && node.test != "lacks") {
      return label + ": a condition tests \"contains\", \"equals\" or \"lacks\"";
    }
    if (node.needle == "") { return label + " needs something to look for"; }
  }
  return "";
}

/** Everything wrong with a graph somebody just described, or "".
 *
 *  Run where it can still be fixed — on every write — rather than at fire
 *  time. A model authors these as often as a person does, so each refusal is
 *  a sentence the model can act on in its next call. */
export function refuse(graph: WfGraph): string {
  if (graph.nodes.length == 0) { return "a workflow with no steps has nothing to run"; }
  if (graph.nodes.length > MAX_NODES) {
    return "that is " + `${graph.nodes.length}` + " steps — the most a workflow may have is " + `${MAX_NODES}`;
  }
  let starts: int = 0;
  let ends: int = 0;
  let i: int = 0;
  while (i < graph.nodes.length) {
    let bad = refuseNode(graph.nodes[i]);
    if (bad != "") { return bad; }
    if (graph.nodes[i].type == "START") { starts = starts + 1; }
    if (graph.nodes[i].type == "END") { ends = ends + 1; }
    let j = i + 1;
    while (j < graph.nodes.length) {
      if (graph.nodes[j].id == graph.nodes[i].id) { return "two steps share the id " + graph.nodes[i].id; }
      j = j + 1;
    }
    i = i + 1;
  }
  if (starts == 0) { return "a workflow needs a START step — where does it begin?"; }
  if (starts > 1) { return "a workflow has one START, not " + `${starts}`; }
  if (ends == 0) { return "a workflow needs an END step — what is the answer?"; }

  let e: int = 0;
  while (e < graph.edges.length) {
    let edge = graph.edges[e];
    let from = nodeAt(graph, edge.from);
    let to = nodeAt(graph, edge.to);
    if (from.id == "") { return "an edge leaves a step that does not exist: " + edge.from; }
    if (to.id == "") { return "an edge arrives at a step that does not exist: " + edge.to; }
    if (edge.from == edge.to) { return (from.name == "" ? from.id : from.name) + " connects to itself"; }
    if (to.type == "START") { return "nothing connects INTO the START step"; }
    if (from.type == "END") { return "nothing connects OUT of an END step"; }
    if (edge.when != "" && edge.when != "yes" && edge.when != "no") {
      return "\"" + edge.when + "\" is not a branch — a condition's edges are \"yes\" and \"no\"";
    }
    if (edge.when != "" && from.type != "CONDITION") {
      return "only a CONDITION step branches — the edge out of "
        + (from.name == "" ? from.id : from.name) + " cannot carry \"" + edge.when + "\"";
    }
    if (edge.when == "" && from.type == "CONDITION") {
      return "each edge out of a condition says which way — \"yes\" or \"no\"";
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
  return "";
}

/** `{{input}}`, `{{prev}}` and `{{node.<id>}}`, filled from the walk so far.
 *
 *  An unknown token is left standing rather than silently emptied: a template
 *  that names a node wrongly should look wrong in the output it produced, not
 *  vanish into text that reads as though nothing was meant to be there. */
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
    } else if (token.startsWith("node.")) {
      let id = token.slice(5);
      let found = false;
      let o: int = 0;
      while (o < ctx.outputs.length) {
        if (ctx.outputs[o].nodeId == id) {
          out = out + ctx.outputs[o].output;
          found = true;
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
  let at = start;
  let visited: int = 0;
  while (visited <= MAX_NODES) {
    visited = visited + 1;
    watch(steps, at);
    let t0 = clock();
    let did = step(at, ctx);
    let took = clock() - t0;
    let one: WfStep = {
      nodeId: at.id, type: at.type,
      status: did.ok ? "COMPLETED" : "FAILED",
      ms: took, output: did.output, error: did.error,
    };
    steps.push(one);
    watch(steps, emptyNode());
    if (!did.ok) {
      return failedWalk((at.name == "" ? at.type : at.name) + ": " + did.error, steps);
    }
    let out: WfOut = { nodeId: at.id, output: did.output };
    outs.push(out);
    ctx = { input: input, prev: did.output, outputs: outs };
    if (at.type == "END") {
      let done: Walked = { ok: true, answer: did.output, error: "", steps: steps };
      return done;
    }
    let to = nextId(graph, at.id, did.branch);
    if (to == "") {
      // A branch nothing was drawn for, or a node somebody left dangling:
      // the walk is over and what it has is the answer.
      let done: Walked = { ok: true, answer: did.output, error: "", steps: steps };
      return done;
    }
    at = nodeAt(graph, to);
    if (at.id == "") { return failedWalk("an edge points at a step that does not exist: " + to, steps); }
  }
  return failedWalk("the walk did not finish within " + `${MAX_NODES}` + " steps", steps);
}

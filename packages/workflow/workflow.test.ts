// The graph, tested without a database, a provider or a clock — which is the
// reason the package exists in this shape.
//
//   cd packages/workflow && lumen test workflow.test.ts
//
// The step function each walk uses is a fixture: it answers a string built
// from the node's id, so ordering and carry-forward can be read off the
// answer. The clock is a counter, so durations are asserted exactly.

import { MAX_ITEMS, MAX_NODES, StepResult, WalkCtx, WfEdge, WfGraph, WfNode, WfOut, WfStep, aggregated, asJsonList, casesOf, dig, emptyGraph, headerLines, emptyNode, fill, itemsOf, matches, outcomeAsk, outcomeFrom, refuse, startOf, switchBranch, walk, walkFrom } from "./workflow.ts";

// A node with everything empty but what the test is about. Records are
// immutable, so a fixture is built whole.
function node(id: string, kind: string): WfNode {
  let n: WfNode = {
    id: id, type: kind, name: "", x: 0.0, y: 0.0,
    instruction: kind == "AGENT" || kind == "LLM" ? "do the thing" : "",
    agentId: "",
    serverId: kind == "MCP" ? "s1" : "", tool: kind == "MCP" ? "t" : "", args: "",
    url: kind == "HTTP" ? "https://example.com" : "",
    method: kind == "HTTP" ? "GET" : "", body: "",
    query: kind == "WEB_SEARCH" || kind == "KNOWLEDGE" ? "what changed" : "",
    test: kind == "CONDITION" || kind == "FILTER" ? "contains" : "",
    needle: kind == "CONDITION" || kind == "FILTER" ? "urgent" : "",
    subject: "", schedule: "", source: "",
    amount: kind == "WAIT" || kind == "LOOP" ? "2" : "",
    workflowId: kind == "SUB_WORKFLOW" ? "w1" : "",
  };
  if (kind == "SET") {
    let said: WfNode = {
      id: n.id, type: n.type, name: n.name, x: n.x, y: n.y,
      instruction: "the answer is {{prev}}", agentId: n.agentId,
      serverId: n.serverId, tool: n.tool, args: n.args,
      url: n.url, method: n.method, body: n.body,
      query: n.query, test: n.test, needle: n.needle,
      subject: n.subject, schedule: n.schedule, source: n.source,
      amount: n.amount, workflowId: n.workflowId,
    };
    return said;
  }
  return n;
}

// The same node with a different instruction — records are immutable, so it
// is the whole thing again.
function withText(n: WfNode, said: string): WfNode {
  let out: WfNode = {
    id: n.id, type: n.type, name: n.name, x: n.x, y: n.y,
    instruction: said, agentId: n.agentId,
    serverId: n.serverId, tool: n.tool, args: n.args,
    url: n.url, method: n.method, body: n.body,
    query: n.query, test: n.test, needle: n.needle,
    subject: n.subject, schedule: n.schedule, source: n.source,
  };
  return out;
}

// The same node carrying outcomes. Whole again, for the same reason.
function withCases(n: WfNode, said: string): WfNode {
  let out: WfNode = {
    id: n.id, type: n.type, name: n.name, x: n.x, y: n.y,
    instruction: n.instruction, agentId: n.agentId,
    serverId: n.serverId, tool: n.tool, args: n.args,
    url: n.url, method: n.method, body: n.body,
    query: n.query, test: n.test, needle: n.needle,
    subject: n.subject, schedule: n.schedule, source: n.source,
    cases: said,
  };
  return out;
}

function edge(id: string, from: string, to: string, when: string): WfEdge {
  let e: WfEdge = { id: id, from: from, to: to, when: when };
  return e;
}

function graphOf(nodes: WfNode[], edges: WfEdge[]): WfGraph {
  let g = emptyGraph();
  let built: WfGraph = { nodes: nodes, edges: edges, view: g.view };
  return built;
}

/** START -> AGENT -> END, the smallest real workflow. */
function chain(): WfGraph {
  return graphOf(
    [node("s", "START"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
}

// A step that answers its node id, with the prev carried in brackets — so a
// walk's answer spells out the order it took.
function echo(n: WfNode, ctx: WalkCtx): StepResult {
  let r: StepResult = { ok: true, output: n.id + "(" + ctx.prev + ")", branch: "", error: "", input: ctx.prev };
  return r;
}

// A counter standing in for milliseconds.
let ticks: number = 0;
function tick(): number {
  ticks = ticks + 1.0;
  return ticks;
}

// A watcher that hears nothing — most tests want the walk, not the feed.
function deaf(steps: WfStep[], at: WfNode): void { }

// And one that writes down what it heard. Module state and a named function,
// as `ticks` is, because a closure may not grow a captured list.
let heard: string[] = [];
function ear(steps: WfStep[], at: WfNode): void {
  heard.push(`${steps.length}` + (at.id == "" ? "-done" : "-at:" + at.id));
}

test("a well-formed graph is not refused", () => {
  expect(refuse(chain()) == "");
});

test("what is refused, and with a sentence rather than a code", () => {
  expect(refuse(emptyGraph()) != "");                                    // nothing to run
  expect(refuse(graphOf([node("a", "AGENT"), node("z", "END")], [])) != "");   // no START
  expect(refuse(graphOf([node("s", "START"), node("s2", "START"), node("z", "END")], [])) != "");  // two STARTs
  // No END is not refused any more: a walk ends where the edges stop, and
  // the last step's output is the answer.
  expect(refuse(graphOf([node("s", "START"), node("a", "AGENT")], [edge("e1", "s", "a", "")])) == "");
  expect(refuse(graphOf([node("s", "START"), node("x", "KAFKA"), node("z", "END")], [])).indexOf("KAFKA") >= 0);
  expect(refuse(graphOf([node("s", "START"), node("s", "AGENT"), node("z", "END")], [])).indexOf("share") >= 0);

  // Edges that cannot be followed.
  let dangling = graphOf([node("s", "START"), node("z", "END")], [edge("e", "s", "ghost", "")]);
  expect(refuse(dangling).indexOf("ghost") >= 0);
  let into = graphOf([node("s", "START"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "s", "")]);
  expect(refuse(into).indexOf("START") >= 0);
  let split = graphOf([node("s", "START"), node("a", "AGENT"), node("b", "LLM"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "s", "b", "")]);
  expect(refuse(split).indexOf("two") >= 0);
});

test("a condition branches and nothing else does", () => {
  let both = graphOf(
    [node("s", "START"), node("c", "CONDITION"), node("a", "AGENT"), node("b", "LLM"), node("z", "END")],
    [edge("e1", "s", "c", ""), edge("e2", "c", "a", "yes"), edge("e3", "c", "b", "no"),
     edge("e4", "a", "z", ""), edge("e5", "b", "z", "")]);
  expect(refuse(both) == "");

  // A plain node may not branch; a condition's edges must say which way.
  let branchy = graphOf([node("s", "START"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "a", "yes"), edge("e2", "a", "z", "")]);
  expect(refuse(branchy).indexOf("CONDITION") >= 0);
  let unsaid = graphOf([node("s", "START"), node("c", "CONDITION"), node("z", "END")],
    [edge("e1", "s", "c", ""), edge("e2", "c", "z", "")]);
  expect(refuse(unsaid).indexOf("yes") >= 0);
});

test("a step with outcomes may branch, and only on its own outcomes", () => {
  let deciding = withCases(node("a", "AGENT"), "urgent\nroutine");
  let drawn = graphOf(
    [node("s", "START"), deciding, node("p", "LLM"), node("q", "LLM"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "p", "urgent"),
     edge("e3", "a", "q", "routine"), edge("e4", "p", "z", ""), edge("e5", "q", "z", "")]);
  expect(refuse(drawn) == "");

  // A label that is none of its outcomes is an edge left behind by a rename,
  // and would simply never be taken — so it is named rather than ignored.
  let stale = graphOf(
    [node("s", "START"), deciding, node("p", "LLM"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "p", "whenever"), edge("e3", "p", "z", "")]);
  expect(refuse(stale).indexOf("whenever") >= 0);

  // else is always available, as it is for a switch.
  let fallback = graphOf(
    [node("s", "START"), deciding, node("p", "LLM"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "p", "else"), edge("e3", "p", "z", "")]);
  expect(refuse(fallback) == "");

  // And a step with no outcomes still may not branch — the rule that was
  // there before outcomes existed.
  let plain = graphOf([node("s", "START"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "yes")]);
  expect(refuse(plain).indexOf("outcomes") >= 0);
});

test("a cycle is refused before it can run forever", () => {
  let loop = graphOf(
    [node("s", "START"), node("a", "AGENT"), node("b", "LLM"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "b", ""), edge("e3", "b", "a", "")]);
  expect(refuse(loop).indexOf("loop") >= 0);
});

test("too many steps is a refusal, not a slow surprise", () => {
  let nodes: WfNode[] = [node("s", "START"), node("z", "END")];
  let i: int = 0;
  while (i < MAX_NODES) {
    nodes.push(node("n" + `${i}`, "LLM"));
    i = i + 1;
  }
  expect(refuse(graphOf(nodes, [])).indexOf(`${MAX_NODES}`) >= 0);
});

test("a step missing what its kind needs is named in the refusal", () => {
  let empty = emptyNode();
  let mute: WfNode = {
    id: "a", type: "AGENT", name: "Morning brief", x: 0.0, y: 0.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "", test: "", needle: "",
    subject: "", schedule: empty.schedule, source: empty.source,
  };
  let bad = refuse(graphOf([node("s", "START"), mute, node("z", "END")], []));
  expect(bad.indexOf("Morning brief") >= 0);
  expect(bad.indexOf("instruction") >= 0);
});

test("the walk visits in order and carries each answer forward", () => {
  ticks = 0;
  let done = walk(chain(), "go", echo, tick, deaf);
  expect(done.ok);
  // START saw the input; AGENT saw START's answer; END saw AGENT's.
  expect(done.answer == "z(a(s(go)))");
  expect(done.steps.length == 3);
  expect(done.steps[0].nodeId == "s");
  expect(done.steps[1].nodeId == "a");
  expect(done.steps[2].nodeId == "z");
  expect(done.steps[0].status == "COMPLETED");
  // The counter clock: each step took exactly one tick.
  expect(done.steps[1].ms == 1.0);
});

test("a failing middle step ends the walk with its reason and its trail", () => {
  let sour = (n: WfNode, ctx: WalkCtx): StepResult => {
    if (n.type == "AGENT") {
      let r: StepResult = { ok: false, output: "", branch: "", error: "the provider timed out", input: ctx.prev };
      return r;
    }
    return echo(n, ctx);
  };
  ticks = 0;
  let done = walk(chain(), "go", sour, tick, deaf);
  expect(!done.ok);
  expect(done.error.indexOf("timed out") >= 0);
  // The START that ran is recorded; so is the failure itself.
  expect(done.steps.length == 2);
  expect(done.steps[1].status == "FAILED");
});

test("a condition's branch decides which edge the walk follows", () => {
  let fork = graphOf(
    [node("s", "START"), node("c", "CONDITION"), node("a", "AGENT"), node("b", "LLM"), node("z", "END")],
    [edge("e1", "s", "c", ""), edge("e2", "c", "a", "yes"), edge("e3", "c", "b", "no"),
     edge("e4", "a", "z", ""), edge("e5", "b", "z", "")]);
  let no = (n: WfNode, ctx: WalkCtx): StepResult => {
    if (n.type == "CONDITION") {
      let r: StepResult = { ok: true, output: ctx.prev, branch: "no", error: "", input: ctx.prev };
      return r;
    }
    return echo(n, ctx);
  };
  ticks = 0;
  let done = walk(fork, "go", no, tick, deaf);
  expect(done.ok);
  // It went s -> c -> b -> z, never a.
  expect(done.answer == "z(b(s(go)))");
  expect(done.steps.length == 4);
  expect(done.steps[2].nodeId == "b");
});

test("a branch nothing was drawn for ends the walk with what it has", () => {
  let fork = graphOf(
    [node("s", "START"), node("c", "CONDITION"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "c", ""), edge("e2", "c", "a", "yes"), edge("e4", "a", "z", "")]);
  let no = (n: WfNode, ctx: WalkCtx): StepResult => {
    if (n.type == "CONDITION") {
      let r: StepResult = { ok: true, output: ctx.prev, branch: "no", error: "", input: ctx.prev };
      return r;
    }
    return echo(n, ctx);
  };
  ticks = 0;
  let done = walk(fork, "go", no, tick, deaf);
  expect(done.ok);
  expect(done.answer == "s(go)");
  expect(done.steps.length == 2);
});

test("a node with outcomes asks for one, and a node without asks for nothing", () => {
  let plain = node("a", "AGENT");
  expect(outcomeAsk(plain) == "");

  let branching = withCases(node("b", "AGENT"), "urgent\nroutine");
  let asked = outcomeAsk(branching);
  expect(asked.indexOf("OUTCOME:") > 0);
  expect(asked.indexOf("urgent | routine") > 0);
});

test("an outcome is read off the last line, and the answer keeps the rest", () => {
  let said = outcomeFrom("The build is broken and the cause is a missing lockfile.\nOUTCOME: urgent");
  expect(said.picked == "urgent");
  expect(said.text == "The build is broken and the cause is a missing lockfile.");

  // What models actually send: the brackets from the instruction, a trailing
  // full stop, a blank line after.
  expect(outcomeFrom("done\nOUTCOME: <routine>").picked == "routine");
  expect(outcomeFrom("done\nOUTCOME: `urgent`.").picked == "urgent");
  expect(outcomeFrom("done\nOUTCOME: urgent\n\n").picked == "urgent");
  expect(outcomeFrom("done\noutcome: urgent").picked == "urgent");

  // The word in passing is not a decision: only the last line counts.
  let prose = outcomeFrom("The OUTCOME: label is what it prints.\nNothing else.");
  expect(prose.picked == "");
  expect(prose.text.indexOf("Nothing else.") > 0);

  // An answer that names nothing keeps every word of itself.
  let none = outcomeFrom("just an answer");
  expect(none.picked == "" && none.text == "just an answer");
});

test("an outcome routes by the rule a switch already uses", () => {
  let n = withCases(node("b", "AGENT"), "urgent\nroutine");
  // Case and space are forgiven, because a model will not match exactly.
  expect(switchBranch(n, outcomeFrom("x\nOUTCOME:  Urgent ").picked) == "urgent");
  // And anything else — a made-up outcome, or none at all — is else, so a
  // model ignoring the instruction routes somewhere rather than nowhere.
  expect(switchBranch(n, outcomeFrom("x\nOUTCOME: whenever").picked) == "else");
  expect(switchBranch(n, outcomeFrom("no marker here").picked) == "else");
});

test("templates fill from the walk, and an unknown token stays visible", () => {
  let out1: WfOut = { nodeId: "search", output: "three results" };
  let ctx: WalkCtx = { input: "the question", prev: "the last answer", outputs: [out1] };
  expect(fill("about {{input}}", ctx) == "about the question");
  expect(fill("given {{prev}}, decide", ctx) == "given the last answer, decide");
  expect(fill("from {{ node.search }}", ctx) == "from three results");
  expect(fill("keep {{node.missing}} as is", ctx) == "keep {{node.missing}} as is");
  expect(fill("no tokens at all", ctx) == "no tokens at all");
  expect(fill("unclosed {{prev", ctx) == "unclosed {{prev");
});

test("startOf finds the one START and answers empty when there is none", () => {
  expect(startOf(chain()).id == "s");
  expect(startOf(emptyGraph()).id == "");
});

test("the watcher hears the step underway, then the trail without it", () => {
  let blank: string[] = [];
  heard = blank;
  ticks = 0;
  let done = walk(chain(), "go", echo, tick, ear);
  expect(done.ok);
  // Before s: 0 finished; after s: 1 finished and nothing underway — and so
  // on down the chain.
  expect(heard.length == 6);
  expect(heard[0] == "0-at:s");
  expect(heard[1] == "1-done");
  expect(heard[2] == "1-at:a");
  expect(heard[5] == "3-done");
});

test("a step's trail says what it was GIVEN, not only what it answered", () => {
  ticks = 0;
  let done = walk(chain(), "go", echo, tick, deaf);
  expect(done.ok);
  expect(done.steps.length == 3);
  // START is handed the run's input; every step after it the one before.
  expect(done.steps[0].input == "go");
  expect(done.steps[1].input == "s(go)");
  expect(done.steps[2].input == "a(s(go))");
});

test("a step that says nothing about its input gets the chain's, not silence", () => {
  // The reason StepResult carries `input` at all: a step whose template
  // reaches for {{node.somethingElse}} was NOT handed the previous output,
  // and a panel deriving it from the chain would show a person text the step
  // never saw. Here the caller reports the truth and the walk keeps it; the
  // quiet step below falls back to the chain, which is what {{prev}} means.
  let quiet = (n: WfNode, ctx: WalkCtx): StepResult => {
    if (n.id == "a") {
      let told: StepResult = { ok: true, output: "answered", branch: "", error: "",
                               input: "the FIRST step's output, not the previous one" };
      return told;
    }
    let plain: StepResult = { ok: true, output: n.id + "!", branch: "", error: "", input: "" };
    return plain;
  };
  ticks = 0;
  let done = walk(chain(), "go", quiet, tick, deaf);
  expect(done.ok);
  expect(done.steps[1].input == "the FIRST step's output, not the previous one");
  // The quiet ones still say something: what the chain handed them.
  expect(done.steps[0].input == "go");
  expect(done.steps[2].input == "answered");
});

test("a path reaches into a step's answer, and a wrong one misses", () => {
  let body = "{\"version\":\"0.2.0\",\"docker\":true,\"counts\":{\"docs\":12},"
    + "\"items\":[{\"name\":\"first\"},{\"name\":\"second\"}]}";
  expect(dig(body, "version").text == "0.2.0");
  expect(dig(body, "docker").text == "true");
  expect(dig(body, "counts.docs").text == "12");
  expect(dig(body, "items.1.name").text == "second");
  expect(dig(body, "counts").text == "{\"docs\":12}");
  // A miss at any level is a miss.
  expect(!dig(body, "nope").ok);
  expect(!dig(body, "counts.nope").ok);
  expect(!dig(body, "items.9.name").ok);
  expect(!dig(body, "version.deeper").ok);
  // And a key that exists further down is NOT found at the top: a path is
  // exact, unlike agents/scan.ts, which searches every depth.
  expect(!dig(body, "docs").ok);
});

test("templates reach into what a step answered", () => {
  let outs: WfOut[] = [];
  let one: WfOut = { nodeId: "h", output: "{\"status\":\"ok\",\"body\":{\"n\":7}}" };
  outs.push(one);
  let ctx: WalkCtx = { input: "go", prev: one.output, outputs: outs };
  expect(fill("it said {{node.h.status}}", ctx) == "it said ok");
  expect(fill("deep {{node.h.body.n}}", ctx) == "deep 7");
  expect(fill("prev too {{prev.status}}", ctx) == "prev too ok");
  // The whole answer still works, and a path nobody has stays visible so the
  // person can see what they wrote rather than a gap where it was.
  expect(fill("{{node.h}}", ctx) == one.output);
  expect(fill("{{node.h.missing}}", ctx) == "{{node.h.missing}}");
  expect(fill("{{prev.missing}}", ctx) == "{{prev.missing}}");
});

test("a reference to a step that is not there, or not before this one, is refused", () => {
  // s -> c, and the condition's two arms — a and b — cannot see each other
  // however sound each is on its own. Branching through a CONDITION because
  // two plain edges out of one step is already refused: which one runs?
  let g = graphOf(
    [node("s", "START"), node("c", "CONDITION"), node("a", "AGENT"),
     node("b", "AGENT"), node("z", "END")],
    [edge("e1", "s", "c", ""), edge("e2", "c", "a", "yes"), edge("e3", "c", "b", "no"),
     edge("e4", "a", "z", ""), edge("e5", "b", "z", "")]);
  expect(refuse(g) == "");

  // Upstream is fine, and so is a path into it.
  let uses = graphOf(
    [node("s", "START"), withText(node("a", "AGENT"), "read {{node.s}}"),
     node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(uses) == "");
  let path = graphOf(
    [node("s", "START"), withText(node("a", "AGENT"), "read {{node.s.body.n}}"),
     node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(path) == "");

  // A step nobody has.
  let ghost = graphOf(
    [node("s", "START"), withText(node("a", "AGENT"), "read {{node.serach}}"),
     node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(ghost).includes("serach"));

  // A step that exists but does not run first — the other arm of the branch.
  let sideways = graphOf(
    [node("s", "START"), node("c", "CONDITION"),
     withText(node("a", "AGENT"), "read {{node.b}}"),
     node("b", "AGENT"), node("z", "END")],
    [edge("e1", "s", "c", ""), edge("e2", "c", "a", "yes"), edge("e3", "c", "b", "no"),
     edge("e4", "a", "z", ""), edge("e5", "b", "z", "")]);
  expect(refuse(sideways).includes("does not run before it"));

  // And a step reaching for itself.
  let selfish = graphOf(
    [node("s", "START"), withText(node("a", "AGENT"), "read {{node.a}}"),
     node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(selfish).includes("its own answer"));

  // A token that is not a node reference is still left alone: somebody asking
  // a model to write a template has to be able to type braces.
  let quoting = graphOf(
    [node("s", "START"), withText(node("a", "AGENT"), "write {{placeholder}} for me"),
     node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(quoting) == "");
});

test("a switch sends a value down the case it matches, or else", () => {
  let sw = node("w", "SWITCH");
  let cases: WfNode = {
    id: sw.id, type: sw.type, name: sw.name, x: sw.x, y: sw.y,
    instruction: sw.instruction, agentId: sw.agentId,
    serverId: sw.serverId, tool: sw.tool, args: sw.args,
    url: sw.url, method: sw.method, body: sw.body,
    query: sw.query, test: sw.test, needle: sw.needle,
    subject: sw.subject, schedule: sw.schedule, source: sw.source,
    cases: "urgent\nroutine\n",
  };
  expect(casesOf(cases).length == 2);
  expect(switchBranch(cases, "urgent") == "urgent");
  // Case and surrounding space do not decide a route.
  expect(switchBranch(cases, "  ROUTINE ") == "routine");
  // Anything else has one way out, and it exists whether or not somebody
  // thought about it.
  expect(switchBranch(cases, "something else entirely") == "else");
  // Not "contains": a value that merely holds a case is not that case.
  expect(switchBranch(cases, "not urgent at all") == "else");
});

test("a switch's edges must name its own cases", () => {
  let sw = node("w", "SWITCH");
  let withCases: WfNode = {
    id: sw.id, type: sw.type, name: "Triage", x: sw.x, y: sw.y,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "", test: "", needle: "",
    subject: "", schedule: "", source: "", cases: "urgent\nroutine",
  };
  let good = graphOf(
    [node("s", "START"), withCases, node("a", "AGENT"), node("b", "AGENT"), node("z", "END")],
    [edge("e1", "s", "w", ""), edge("e2", "w", "a", "urgent"),
     edge("e3", "w", "b", "routine"), edge("e4", "w", "z", "else"),
     edge("e5", "a", "z", ""), edge("e6", "b", "z", "")]);
  expect(refuse(good) == "");

  // An edge for a case nobody declared can never run, and the drawing gives
  // no hint of it.
  let ghost = graphOf(
    [node("s", "START"), withCases, node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "w", ""), edge("e2", "w", "a", "later"), edge("e3", "a", "z", "")]);
  expect(refuse(ghost).includes("no case"));

  // And an edge out of a switch that says nothing is a way out nobody can
  // predict.
  let mute = graphOf(
    [node("s", "START"), withCases, node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "w", ""), edge("e2", "w", "a", ""), edge("e3", "a", "z", "")]);
  expect(refuse(mute).includes("which case"));
});

test("a workflow begins in exactly one place, and a trigger is one of them", () => {
  // A Telegram trigger stands in for the START step rather than sitting
  // before it: it is where the walk begins and what decides the input.
  // With a reply step, because a triggered graph must say something back —
  // the rule of its own further down this file.
  let onMessage = graphOf([node("t", "TELEGRAM"), node("a", "AGENT"),
    withText(node("say", "TELEGRAM_REPLY"), "{{prev}}"), node("z", "END")],
    [edge("e1", "t", "a", ""), edge("e2", "a", "say", ""), edge("e3", "say", "z", "")]);
  expect(refuse(onMessage) == "");
  expect(startOf(onMessage).id == "t");

  // Both is not "belt and braces", it is two answers to "what makes this
  // run" — and the walk would have to pick one silently.
  let two = graphOf([node("s", "START"), node("t", "TELEGRAM"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(two).indexOf("one place") >= 0);

  // Nothing wires INTO a trigger, and the refusal says trigger rather than
  // START, because START is not what is on the board.
  let backwards = graphOf([node("t", "TELEGRAM"), node("a", "AGENT"),
    withText(node("say", "TELEGRAM_REPLY"), "{{prev}}"), node("z", "END")],
    [edge("e1", "t", "a", ""), edge("e2", "a", "t", "")]);
  expect(refuse(backwards).indexOf("trigger") >= 0);
});

test("a telegram reply is a step in the middle, not a second ending", () => {
  // It sits mid-chain like any step: one way in, one way out, and the walk
  // continues past it.
  let g = graphOf([node("t", "TELEGRAM"),
    withText(node("say", "TELEGRAM_REPLY"), "on it — searching now"),
    node("a", "AGENT"), node("z", "END")],
    [edge("e1", "t", "say", ""), edge("e2", "say", "a", ""), edge("e3", "a", "z", "")]);
  expect(refuse(g) == "");

  // An empty message is refused with the field named: a reply that sends
  // nothing looks like a broken bot from the phone.
  let mute = graphOf([node("t", "TELEGRAM"), node("say", "TELEGRAM_REPLY"), node("z", "END")],
    [edge("e1", "t", "say", ""), edge("e2", "say", "z", "")]);
  expect(refuse(mute).indexOf("message to send") >= 0);
});

test("a workflow that begins at a message must say something back", () => {
  // END records the answer; a TELEGRAM_REPLY sends it. A triggered graph
  // with no reply step is a bot that reads and never answers.
  let deaf = graphOf([node("t", "TELEGRAM"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "t", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(deaf).indexOf("Telegram reply") >= 0);

  // The same graph run by hand needs no reply step: there is no chat.
  let byHand = graphOf([node("s", "START"), node("a", "AGENT"), node("z", "END")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "z", "")]);
  expect(refuse(byHand) == "");
});

// A step function that suspends at an ASK and echoes everywhere else — the
// runner's adapter in miniature.
function askOrEcho(n: WfNode, ctx: WalkCtx): StepResult {
  if (n.type == "TELEGRAM_ASK") {
    let paused: StepResult = { ok: true, output: "asked", branch: "", error: "", input: ctx.prev, suspend: true };
    return paused;
  }
  return echo(n, ctx);
}

test("an ask stops the walk successfully, and the reply resumes past it", () => {
  ticks = 0;
  let g = graphOf([node("t", "TELEGRAM"),
    withText(node("q", "TELEGRAM_ASK"), "create it? yes/no"),
    node("d", "AGENT"),
    withText(node("say", "TELEGRAM_REPLY"), "{{prev}}")],
    [edge("e1", "t", "q", ""), edge("e2", "q", "d", ""), edge("e3", "d", "say", "")]);
  expect(refuse(g) == "");

  // The first half: walks to the question and stops there, OK.
  let paused = walk(g, "make me an issue", askOrEcho, tick, deaf);
  expect(paused.ok);
  expect((paused.waitingAt ?? "") == "q");
  expect(paused.steps.length == 2);

  // The second half: the person said yes, and the step after the question
  // reads the REPLY as {{prev}} — not the question, not the old chain.
  let outs: WfOut[] = [];
  let t0: WfOut = { nodeId: "t", output: "t(make me an issue)" };
  outs.push(t0);
  let resumed = walkFrom(g, "make me an issue", "q", "yes", outs, askOrEcho, tick, deaf);
  expect(resumed.ok);
  expect((resumed.waitingAt ?? "") == "");
  expect(resumed.steps[0].nodeId == "d");
  expect(resumed.steps[0].input == "yes");
  expect(resumed.answer == "say(d(yes))");
});

test("an ask needs a telegram trigger in front of it", () => {
  let stray = graphOf([node("s", "START"),
    withText(node("q", "TELEGRAM_ASK"), "sure?"), node("z", "END")],
    [edge("e1", "s", "q", ""), edge("e2", "q", "z", "")]);
  expect(refuse(stray).indexOf("Telegram trigger") >= 0);
});

test("an http step's headers are Name: value lines, and anything else is refused", () => {
  // A node with headers, built whole — records are immutable.
  let plain = node("h", "HTTP");
  let good: WfNode = {
    id: plain.id, type: plain.type, name: plain.name, x: plain.x, y: plain.y,
    instruction: plain.instruction, agentId: plain.agentId,
    serverId: plain.serverId, tool: plain.tool, args: plain.args,
    url: plain.url, method: plain.method, body: plain.body,
    query: plain.query, test: plain.test, needle: plain.needle,
    subject: plain.subject, schedule: plain.schedule, source: plain.source,
    headers: "Accept: application/json\nX-Api-Version: {{input}}",
  };
  let g1 = graphOf([node("s", "START"), good, node("z", "END")],
    [edge("e1", "s", "h", ""), edge("e2", "h", "z", "")]);
  expect(refuse(g1) == "");
  expect(headerLines(good).length == 2);
  expect(headerLines(good)[0] == "Accept: application/json");

  let bad: WfNode = {
    id: plain.id, type: plain.type, name: plain.name, x: plain.x, y: plain.y,
    instruction: plain.instruction, agentId: plain.agentId,
    serverId: plain.serverId, tool: plain.tool, args: plain.args,
    url: plain.url, method: plain.method, body: plain.body,
    query: plain.query, test: plain.test, needle: plain.needle,
    subject: plain.subject, schedule: plain.schedule, source: plain.source,
    headers: "just some words with no colon",
  };
  let g2 = graphOf([node("s", "START"), bad, node("z", "END")],
    [edge("e1", "s", "h", ""), edge("e2", "h", "z", "")]);
  expect(refuse(g2).indexOf("Name: value") >= 0);

  // A node stored before headers existed parses to none, not a refusal.
  expect(headerLines(plain).length == 0);
});

/** An EMAIL node, whole, since the record is flat. */
function mailNode(id: string, to: string, subject: string, body: string): WfNode {
  let n: WfNode = {
    id: id, type: "EMAIL", name: "Tell them", x: 0.0, y: 0.0,
    instruction: "", agentId: "",
    serverId: "", tool: "", args: "",
    url: "", method: "", body: body,
    query: "", test: "", needle: "",
    subject: subject, schedule: "", source: "",
    to: to,
  };
  return n;
}

test("a mail step names somebody, a subject and a message, or it is refused", () => {
  let good = graphOf([node("s", "START"),
    mailNode("m", "{{input}}", "Your report", "Here it is.\n\n{{prev}}"), node("z", "END")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "z", "")]);
  // Templated fields are addresses only once they are filled, so the graph
  // asks that they are there and the runner asks what they say.
  expect(refuse(good) == "");

  let nobody = graphOf([node("s", "START"),
    mailNode("m", "  ", "Your report", "Here it is."), node("z", "END")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "z", "")]);
  expect(refuse(nobody).indexOf("nobody to send to") > 0);

  let untitled = graphOf([node("s", "START"),
    mailNode("m", "a@b.com", "", "Here it is."), node("z", "END")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "z", "")]);
  expect(refuse(untitled).indexOf("no subject line") > 0);

  let empty = graphOf([node("s", "START"),
    mailNode("m", "a@b.com", "Your report", ""), node("z", "END")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "z", "")]);
  expect(refuse(empty).indexOf("no message") > 0);
});

// --- working through a list -------------------------------------------------

/** A step that puts its node id in front of what it was given, so a body's
 *  turns can be told apart by what each one answered. */
function tag(n: WfNode, ctx: WalkCtx): StepResult {
  let r: StepResult = { ok: true, output: n.id + ":" + ctx.prev, branch: "", error: "", input: ctx.prev };
  return r;
}

/** The same node reading its list from somewhere named. */
function withQuery(n: WfNode, said: string): WfNode {
  let out: WfNode = {
    id: n.id, type: n.type, name: n.name, x: n.x, y: n.y,
    instruction: n.instruction, agentId: n.agentId,
    serverId: n.serverId, tool: n.tool, args: n.args,
    url: n.url, method: n.method, body: n.body,
    query: said, test: n.test, needle: n.needle,
    subject: n.subject, schedule: n.schedule, source: n.source,
    amount: n.amount, workflowId: n.workflowId,
  };
  return out;
}

/** START -> MAP -> body -> MERGE -> (nothing). */
function mapping(body: WfNode[], edges: WfEdge[]): WfGraph {
  let nodes: WfNode[] = [node("s", "START"), withQuery(node("m", "MAP"), "{{input}}")];
  let i: int = 0;
  while (i < body.length) { nodes.push(body[i]); i = i + 1; }
  nodes.push(node("g", "MERGE"));
  let all: WfEdge[] = [edge("e1", "s", "m", "")];
  let j: int = 0;
  while (j < edges.length) { all.push(edges[j]); j = j + 1; }
  return graphOf(nodes, all);
}

test("a map runs its body once per item and gathers what each turn answered", () => {
  let g = mapping([node("a", "AGENT")],
    [edge("e2", "m", "a", ""), edge("e3", "a", "g", "")]);
  expect(refuse(g) == "");

  let ran = walk(g, "[\"one\",\"two\",\"three\"]", tag, tick, deaf);
  expect(ran.ok);
  expect(ran.answer == "[\"a:one\",\"a:two\",\"a:three\"]");
});

test("a map over nothing runs its body no times and gathers an empty list", () => {
  let g = mapping([node("a", "AGENT")],
    [edge("e2", "m", "a", ""), edge("e3", "a", "g", "")]);
  let ran = walk(g, "[]", tag, tick, deaf);
  expect(ran.ok);
  expect(ran.answer == "[]");
  // The MAP and the MERGE are both visited; the body is not.
  let seen: string[] = [];
  let i: int = 0;
  while (i < ran.steps.length) { seen.push(ran.steps[i].nodeId); i = i + 1; }
  expect(seen.join(",") == "s,m,g");
});

test("what a turn produced stays in the turn, and the gathered list carries on", () => {
  let g = graphOf(
    [node("s", "START"), withQuery(node("m", "MAP"), "{{input}}"), node("a", "AGENT"),
     node("g", "MERGE"), node("after", "LLM")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "a", ""), edge("e3", "a", "g", ""),
     edge("e4", "g", "after", "")]);
  let ran = walk(g, "[\"x\",\"y\"]", tag, tick, deaf);
  expect(ran.ok);
  expect(ran.answer == "after:[\"a:x\",\"a:y\"]");
});

test("a loop runs its body a fixed number of times", () => {
  let g = graphOf(
    [node("s", "START"), node("l", "LOOP"), node("a", "AGENT"), node("g", "MERGE")],
    [edge("e1", "s", "l", ""), edge("e2", "l", "a", ""), edge("e3", "a", "g", "")]);
  expect(refuse(g) == "");
  let ran = walk(g, "go", tag, tick, deaf);
  expect(ran.ok);
  expect(ran.answer == "[\"a:1\",\"a:2\"]");
});

test("a repeat without a merge, and a merge without a repeat, are both refused", () => {
  let orphanMap = graphOf(
    [node("s", "START"), node("m", "MAP"), node("a", "AGENT")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "a", "")]);
  expect(refuse(orphanMap).indexOf("MERGE") >= 0);

  let orphanMerge = graphOf(
    [node("s", "START"), node("a", "AGENT"), node("g", "MERGE")],
    [edge("e1", "s", "a", ""), edge("e2", "a", "g", "")]);
  expect(refuse(orphanMerge).indexOf("list") >= 0);
});

test("a repeat may not be drawn inside another repeat", () => {
  let nested = graphOf(
    [node("s", "START"), node("m", "MAP"), node("m2", "MAP"), node("a", "AGENT"),
     node("g2", "MERGE"), node("g", "MERGE")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "m2", ""), edge("e3", "m2", "a", ""),
     edge("e4", "a", "g2", ""), edge("e5", "g2", "g", "")]);
  expect(refuse(nested).indexOf("repeat") >= 0);
});

test("a list longer than a step may take stops the run rather than working through it", () => {
  let g = mapping([node("a", "AGENT")],
    [edge("e2", "m", "a", ""), edge("e3", "a", "g", "")]);
  let many = "";
  let i: int = 0;
  while (i <= MAX_ITEMS) {
    if (i > 0) { many = many + "\n"; }
    many = many + `${i}`;
    i = i + 1;
  }
  let ran = walk(g, many, tag, tick, deaf);
  expect(!ran.ok);
  expect(ran.error.indexOf("items") >= 0);
});

// --- a way out of a failure -------------------------------------------------

/** A step that fails when it is the node called "boom". */
function brittle(n: WfNode, ctx: WalkCtx): StepResult {
  if (n.id == "boom") {
    let no: StepResult = { ok: false, output: "", branch: "", error: "the provider said no", input: ctx.prev };
    return no;
  }
  return tag(n, ctx);
}

test("a failure with nowhere to go ends the run, and the trail keeps the reason", () => {
  let g = graphOf(
    [node("s", "START"), node("boom", "AGENT"), node("after", "LLM")],
    [edge("e1", "s", "boom", ""), edge("e2", "boom", "after", "")]);
  let ran = walk(g, "go", brittle, tick, deaf);
  expect(!ran.ok);
  expect(ran.error.indexOf("the provider said no") >= 0);
  expect(ran.steps[ran.steps.length - 1].status == "FAILED");
});

test("a failure takes the error edge when one is drawn, and the run carries on", () => {
  let g = graphOf(
    [node("s", "START"), node("boom", "AGENT"), node("after", "LLM"), node("rescue", "LLM")],
    [edge("e1", "s", "boom", ""), edge("e2", "boom", "after", ""),
     edge("e3", "boom", "rescue", "error")]);
  expect(refuse(g) == "");

  let ran = walk(g, "go", brittle, tick, deaf);
  expect(ran.ok);
  // The reason is what the recovery step was handed.
  expect(ran.answer == "rescue:the provider said no");
  // And the step that failed is still recorded as having failed.
  expect(ran.steps[1].status == "FAILED");
});

test("an error edge may leave any step, but nothing leaves an entry by one", () => {
  let fromEntry = graphOf(
    [node("s", "START"), node("a", "AGENT"), node("r", "LLM")],
    [edge("e1", "s", "a", ""), edge("e2", "s", "r", "error")]);
  expect(refuse(fromEntry) != "");
});

// --- the steps a runner performs -------------------------------------------

test("what a filter, an aggregate and a wait are refused for", () => {
  let noNeedle = node("f", "FILTER");
  let blank: WfNode = {
    id: noNeedle.id, type: noNeedle.type, name: "", x: 0.0, y: 0.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "", test: "contains", needle: "",
    subject: "", schedule: "", source: "",
  };
  let g = graphOf([node("s", "START"), blank], [edge("e1", "s", "f", "")]);
  expect(refuse(g).indexOf("look for") >= 0);

  let badOp: WfNode = {
    id: "ag", type: "AGGREGATE", name: "", x: 0.0, y: 0.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "", test: "", needle: "",
    subject: "", schedule: "", source: "", op: "average",
  };
  let g2 = graphOf([node("s", "START"), badOp], [edge("e1", "s", "ag", "")]);
  expect(refuse(g2).indexOf("average") >= 0);

  let longWait: WfNode = {
    id: "w", type: "WAIT", name: "", x: 0.0, y: 0.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "", test: "", needle: "",
    subject: "", schedule: "", source: "", amount: "600",
  };
  let g3 = graphOf([node("s", "START"), longWait], [edge("e1", "s", "w", "")]);
  expect(refuse(g3).indexOf("schedule") >= 0);
});

test("a set step, a sub-workflow and a wait are all a graph may hold", () => {
  let g = graphOf(
    [node("s", "START"), node("v", "SET"), node("w", "WAIT"), node("sub", "SUB_WORKFLOW")],
    [edge("e1", "s", "v", ""), edge("e2", "v", "w", ""), edge("e3", "w", "sub", "")]);
  expect(refuse(g) == "");
});

// --- reading and reducing a list -------------------------------------------
test("a JSON array reads as its elements, a plain list as its lines", () => {
  expect(itemsOf("[\"a\",\"b\"]").join("|") == "a|b");
  expect(itemsOf("[{\"n\":1},{\"n\":2}]").join("|") == "{\"n\":1}|{\"n\":2}");
  expect(itemsOf("one\n\ntwo\n").join("|") == "one|two");
  expect(itemsOf("  ").length == 0);
  expect(itemsOf("[]").length == 0);
  expect(itemsOf("[\"a, b\",\"c\"]").join("|") == "a, b|c");
});

test("a list goes back out as JSON a later step can read", () => {
  let one: string[] = ["a", "b"];
  expect(asJsonList(one) == "[\"a\",\"b\"]");
  let none: string[] = [];
  expect(asJsonList(none) == "[]");
});

test("filtering reads a value the way a condition does", () => {
  expect(matches("contains", "urgent", "VERY URGENT"));
  expect(!matches("lacks", "urgent", "very urgent"));
  expect(matches("equals", " yes ", "yes"));
  expect(!matches("nonsense", "a", "a"));
});

test("a list reduces to one value, and joins when nobody said how", () => {
  let three: string[] = ["2", "3", "4"];
  expect(aggregated("count", three) == "3");
  expect(aggregated("sum", three) == "9");
  expect(aggregated("first", three) == "2");
  expect(aggregated("last", three) == "4");
  expect(aggregated("join", three) == "2\n3\n4");
  expect(aggregated("", three) == "2\n3\n4");
  let none: string[] = [];
  expect(aggregated("first", none) == "");
});

test("a map with nothing named works through what the step before it answered", () => {
  let g = graphOf(
    [node("s", "START"), node("m", "MAP"), node("a", "AGENT"), node("g", "MERGE")],
    [edge("e1", "s", "m", ""), edge("e2", "m", "a", ""), edge("e3", "a", "g", "")]);
  // The START step answers "s:(...)", and a map with no query reads that.
  let ran = walk(g, "ignored", echo, tick, deaf);
  expect(ran.ok);
  expect(ran.answer == "[\"a(s(ignored))\"]");
});

test("every turn of a body is written into the trail, in order", () => {
  let g = mapping([node("a", "AGENT")],
    [edge("e2", "m", "a", ""), edge("e3", "a", "g", "")]);
  let ran = walk(g, "[\"one\",\"two\"]", tag, tick, deaf);
  expect(ran.ok);
  let seen: string[] = [];
  let i: int = 0;
  while (i < ran.steps.length) { seen.push(ran.steps[i].nodeId); i = i + 1; }
  // START, the map, the body once per item, then the gather.
  expect(seen.join(",") == "s,m,a,a,g");
  expect(ran.steps[2].output == "a:one");
  expect(ran.steps[3].output == "a:two");
});

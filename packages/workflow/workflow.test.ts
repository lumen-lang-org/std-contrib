// The graph, tested without a database, a provider or a clock — which is the
// reason the package exists in this shape.
//
//   cd packages/workflow && lumen test workflow.test.ts
//
// The step function each walk uses is a fixture: it answers a string built
// from the node's id, so ordering and carry-forward can be read off the
// answer. The clock is a counter, so durations are asserted exactly.

import { MAX_NODES, StepResult, WalkCtx, WfEdge, WfGraph, WfNode, WfOut, WfStep, dig, emptyGraph, emptyNode, fill, refuse, startOf, walk } from "./workflow.ts";

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
    test: kind == "CONDITION" ? "contains" : "",
    needle: kind == "CONDITION" ? "urgent" : "",
    subject: "", schedule: "", source: "",
  };
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
  expect(refuse(graphOf([node("s", "START"), node("a", "AGENT")], [])) != "");  // no END
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

// Running a workflow: the walk from `packages/workflow`, with each node's
// body supplied from the modules this deployment already runs on.
//
// The nodes are adapters, not executors. An AGENT step is `runInThreadWith`
// — the same function a person's message goes through, tool loop and all. An
// LLM step is one `complete`. WEB_SEARCH is webrag's `retrieveWeb`, KNOWLEDGE
// is knowledge's `retrieve`, MCP is mcp's `callTool`, HTTP is `http.request`.
// Nothing about providers, credentials, retries or tool schemas lives here,
// which is the point: a second copy of any of those would be the one that
// misses the fix.
//
// One run opens one conversation, and every AGENT step that does not name a
// different agent answers inside it — so a workflow's trail reads top to
// bottom in the sidebar like a conversation somebody had, because that is
// what it is. An AGENT step that names another agent opens a thread of its
// own under that agent: a thread belongs to one agent, and pretending
// otherwise would file one agent's words under another's name.

import { Db } from "../plume/driver.ts";
import { findById, persist } from "../plume/plume.ts";
import { StepResult, WalkCtx, WfNode, WfStep, Walked, emptyNode, fill, walk } from "../workflow/workflow.ts";
import { WorkflowRow, WorkflowRunRow, parseGraph, workflowRunsMapping } from "./workflow-store.ts";
import { AgentRow, McpServerRow, ModelConfigRow, ModelRow, agentsMapping, mcpServersMapping, modelConfigsMapping, modelsMapping } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { accessTokenFor } from "./connect.ts";
import { complete, replyText } from "./provider.ts";
import { ThreadAsk, inheritedPick, openThread, runInThreadWith } from "./threads.ts";
import { tracerFor } from "./trace.ts";
import { retrieveWeb, asWebContext } from "./webrag.ts";
import { agentScopes, asContext, embeddingModel, retrieve, retrievalFor } from "./knowledge.ts";
import { callTool } from "./mcp.ts";
import { ScriptGiven, ScriptOut, ensureBuilt, runScript } from "./script-wasm.ts";

// What one web search step may pull in. Smaller than a chat turn's budget:
// a workflow chains steps, and each one's output is the next one's input.
const WEB_TOP_K: int = 6;
const WEB_MAX_CHARS: int = 6000;
const KNOW_TOP_K: int = 6;

function stepOk(output: string): StepResult {
  let r: StepResult = { ok: true, output: output, branch: "", error: "", input: "" };
  return r;
}

function stepBranch(output: string, branch: string): StepResult {
  let r: StepResult = { ok: true, output: output, branch: branch, error: "", input: "" };
  return r;
}

function stepFailed(why: string): StepResult {
  let r: StepResult = { ok: false, output: "", branch: "", error: why, input: "" };
  return r;
}

/** The same answer, saying what the step was actually given.
 *
 *  Set out here rather than inside each adapter because the filling happens
 *  in `step` below — the adapter is handed text that is already resolved and
 *  no longer knows it was a template. A record cannot be edited in place, so
 *  this is the whole record again with the one field filled in. */
function withInput(r: StepResult, said: string): StepResult {
  let told: StepResult = { ok: r.ok, output: r.output, branch: r.branch, error: r.error, input: said };
  return told;
}

// What a run needs beyond the row: whose it is, what goes into {{input}},
// and the master key that opens credentials. A record for the reason every
// call record here is one — four strings in a row is a swap nobody catches.
export type WorkflowAsk = {
  owner: string,
  input: string,
  master: string,
  nowMs: number,
};

export type WorkflowDone = {
  ok: bool,
  runId: string,
  threadId: string,
  answer: string,
  error: string,
};

/** The CONDITION step: a string test, decided here because it touches
 *  nothing but the text it is given. */
function decide(node: WfNode, ctx: WalkCtx): StepResult {
  let subject = node.subject == "" ? ctx.prev : fill(node.subject, ctx);
  let has = subject.toLowerCase().includes(node.needle.toLowerCase());
  let verdict = false;
  if (node.test == "contains") { verdict = has; }
  if (node.test == "lacks") { verdict = !has; }
  if (node.test == "equals") { verdict = subject.trim() == node.needle.trim(); }
  // The tested text passes through, so a condition never breaks {{prev}} —
  // a branch is a turn in the road, not a step that produced something.
  return stepBranch(ctx.prev, verdict ? "yes" : "no");
}

/** The LLM step: one model call, no tools, on the workflow's agent's model. */
function askModel(db: Db, agent: AgentRow, master: string, prompt: string): StepResult {
  let configDoc = findById(db, modelConfigsMapping(db), agent.modelConfigId);
  if (configDoc == "") { return stepFailed("agent " + agent.agentName + " has no model config"); }
  let config: ModelConfigRow = JSON.parse<ModelConfigRow>(configDoc);
  let modelDoc = findById(db, modelsMapping(), config.modelId);
  if (modelDoc == "") { return stepFailed("no model " + config.modelId); }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) { return stepFailed(model.label + " is disabled"); }
  let key = credentialFor(db, model.provider, master);
  if (key == "") { return stepFailed("no usable credential for " + model.provider); }
  let asked = complete(model, config,
    "You are one step in a workflow. Answer the instruction directly — your answer is handed "
    + "to the next step as text, so no preamble and no closing remarks.",
    prompt, key);
  if (!asked.ok) { return stepFailed(asked.error); }
  return stepOk(replyText(model.provider, asked.text).trim());
}

/** The KNOWLEDGE step: the agent's own document retrieval, as a step. */
function lookUp(db: Db, agent: AgentRow, master: string, question: string): StepResult {
  let want = retrievalFor(db, agent.id);
  if (want.embeddingModelId == "" || !want.enabled) {
    return stepFailed(agent.agentName + " has no document retrieval set up — a KNOWLEDGE step needs it");
  }
  if (db.name != "postgres") {
    return stepFailed("retrieval needs PostgreSQL; this runs on " + db.name);
  }
  let embedder = embeddingModel(db, want.embeddingModelId);
  if (embedder.id == "") { return stepFailed("no usable embedding model " + want.embeddingModelId); }
  let granted = agentScopes(db, agent.id);
  if (granted.length == 0) { return stepFailed(agent.agentName + " has no scopes granted, so there is nothing to read"); }
  let key = credentialFor(db, embedder.provider, master);
  if (key == "") { return stepFailed("no credential for " + embedder.provider); }
  let found = retrieve(db, embedder, granted, question, KNOW_TOP_K, key);
  if (!found.ok) { return stepFailed(found.error); }
  if (found.found.length == 0) { return stepOk("Nothing in the documents matches: " + question); }
  return stepOk(asContext(found.found));
}

/** The MCP step: one named tool on a server the deployment holds. */
function reachOut(db: Db, node: WfNode, owner: string, master: string, args: string): StepResult {
  let doc = findById(db, mcpServersMapping(), node.serverId);
  if (doc == "") { return stepFailed("no connector " + node.serverId + " — it may have been removed"); }
  let server: McpServerRow = JSON.parse<McpServerRow>(doc);
  if (!server.enabled) { return stepFailed(server.serverName + " is switched off"); }
  let token = accessTokenFor(db, server, owner, master);
  if (server.authKind != "" && server.authKind != "none" && token == "") {
    return stepFailed(server.serverName + " needs a token and none is stored for it");
  }
  let called = callTool(server, node.tool, args == "" ? "{}" : args, token);
  if (!called.ok) { return stepFailed(called.error); }
  return stepOk(called.text);
}

/** What a SCRIPT step is handed: the run's input, the previous answer, and
 *  every earlier answer by node id. The runner writes one file per value —
 *  the granted directory is the API the prelude reads, so nothing here has
 *  to escape anything into a document. */
function scriptGiven(ctx: WalkCtx): ScriptGiven {
  let outs: ScriptOut[] = [];
  let i: int = 0;
  while (i < ctx.outputs.length) {
    let one: ScriptOut = { id: ctx.outputs[i].nodeId, output: ctx.outputs[i].output };
    outs.push(one);
    i = i + 1;
  }
  let given: ScriptGiven = { input: ctx.input, prev: ctx.prev, outputs: outs };
  return given;
}

/** The SCRIPT step: compile once per source, then run with nothing granted.
 *
 *  The compile happens on the first run of a given source and is cached by
 *  its hash for every run after — including runs of other workflows that
 *  happen to hold the same text. */
function runScriptStep(node: WfNode, ctx: WalkCtx, runId: string): StepResult {
  let built = ensureBuilt(node.source);
  if (!built.ok) { return stepFailed(built.error); }
  let dir = "/tmp/joule-script-run/" + runId + "-" + node.id;
  let ran = runScript(built.path, scriptGiven(ctx), dir);
  if (!ran.ok) { return stepFailed(ran.error); }
  return stepOk(ran.output);
}

/** The HTTP step. GET sends no body; everything else sends the filled one. */
function fetchStep(node: WfNode, ctx: WalkCtx): StepResult {
  let url = fill(node.url, ctx);
  let headers = new Map<string, string>();
  headers.set("Content-Type", "application/json");
  let body = node.method == "GET" ? "" : fill(node.body, ctx);
  let res = http.request(url, node.method, body, headers);
  if (res.status == 0) { return stepFailed("no answer from " + url); }
  if (res.status < 200 || res.status > 299) {
    return stepFailed(url + " answered " + `${res.status}` + ": " + res.body.slice(0, 300));
  }
  return stepOk(res.body);
}

/** Run one workflow: open its conversation, walk its graph, record the run.
 *
 *  The row is written twice — "running" before the walk and the outcome after
 *  — so a run that dies mid-walk leaves a row saying so rather than nothing.
 *  Whether the workflow's own schedule and failure count move is the CALLER's
 *  write (`markWorkflowRan` / `markWorkflowFailed`): the scheduler owns the
 *  claim, and a run fired by hand must not touch the schedule at all. */
export function runWorkflow(db: Db, row: WorkflowRow, ask: WorkflowAsk): WorkflowDone {
  let parsed = parseGraph(row.graph);
  if (!parsed.ok) {
    let refused: WorkflowDone = { ok: false, runId: "", threadId: "", answer: "", error: parsed.error };
    return refused;
  }
  let agentDoc = findById(db, agentsMapping(), row.agentId);
  if (agentDoc == "") {
    let refused: WorkflowDone = { ok: false, runId: "", threadId: "", answer: "", error: "no agent " + row.agentId + " to run as" };
    return refused;
  }
  let agent: AgentRow = JSON.parse<AgentRow>(agentDoc);

  let threadId = openThread(db, { agentId: row.agentId, owner: ask.owner, now: `${ask.nowMs}` });
  if (threadId == "") {
    let refused: WorkflowDone = { ok: false, runId: "", threadId: "", answer: "", error: "the conversation could not be opened" };
    return refused;
  }

  let runId = crypto.randomUUID();
  let opened: WorkflowRunRow = {
    id: runId, workflowId: row.id, owner: ask.owner,
    status: "running", input: ask.input, answer: "", error: "",
    threadId: threadId, steps: "[]",
    startedAt: `${ask.nowMs}`, endedAt: "",
  };
  persist(db, workflowRunsMapping(), JSON.stringify(opened));

  // The trail, written as it happens and not only at the end: the console
  // polls the running row and paints these onto the canvas, so a person
  // watching sees the search pulse, finish, and hand to the agent — in the
  // canvas's own status vocabulary (RUNNING / COMPLETED / FAILED), which is
  // why no translation happens anywhere between here and the drawing. The
  // walker owns the trail and calls this before and after every step; the
  // step underway is synthesised into the write rather than stored, so
  // nothing here grows a list of its own (a captured list may not be
  // mutated, and the walker already keeps the authoritative one).
  let paint = (sofar: WfStep[], at: WfNode): void => {
    let all: WfStep[] = [];
    let i: int = 0;
    while (i < sofar.length) { all.push(sofar[i]); i = i + 1; }
    if (at.id != "") {
      let underway: WfStep = { nodeId: at.id, type: at.type, status: "RUNNING", ms: 0, input: "", output: "", error: "" };
      all.push(underway);
    }
    let progress: WorkflowRunRow = {
      id: runId, workflowId: row.id, owner: ask.owner,
      status: "running", input: ask.input, answer: "", error: "",
      threadId: threadId, steps: JSON.stringify(all),
      startedAt: `${ask.nowMs}`, endedAt: "",
    };
    persist(db, workflowRunsMapping(), JSON.stringify(progress));
  };

  let step = (node: WfNode, ctx: WalkCtx): StepResult => {
    if (node.type == "START") { return withInput(stepOk(ctx.input), ctx.input); }
    if (node.type == "END") { return withInput(stepOk(ctx.prev), ctx.prev); }
    if (node.type == "CONDITION") {
      let tested = node.subject == "" ? ctx.prev : fill(node.subject, ctx);
      return withInput(decide(node, ctx), tested);
    }
    if (node.type == "LLM") {
      let said = fill(node.instruction, ctx);
      return withInput(askModel(db, agent, ask.master, said), said);
    }
    if (node.type == "WEB_SEARCH") {
      let asked = fill(node.query, ctx);
      let found = retrieveWeb(asked, WEB_TOP_K, WEB_MAX_CHARS);
      if (!found.ok) { return withInput(stepFailed(found.error), asked); }
      if (found.found.length == 0) { return withInput(stepOk("The web index has nothing for: " + found.query), asked); }
      return withInput(stepOk(asWebContext(found.found)), asked);
    }
    if (node.type == "KNOWLEDGE") {
      let asked = fill(node.query, ctx);
      return withInput(lookUp(db, agent, ask.master, asked), asked);
    }
    if (node.type == "MCP") {
      let args = fill(node.args, ctx);
      return withInput(reachOut(db, node, ask.owner, ask.master, args), node.tool + " " + args);
    }
    if (node.type == "SCRIPT") {
      // The script's own input is the walk so far, so what it was handed is
      // recorded as that rather than as the source it is made of.
      // What it was handed, said the way the panel shows every other step:
      // the chain's previous answer is the honest summary of the envelope.
      return withInput(runScriptStep(node, ctx, runId), ctx.prev);
    }
    if (node.type == "HTTP") {
      let url = fill(node.url, ctx);
      let body = node.method == "GET" ? "" : fill(node.body, ctx);
      return withInput(fetchStep(node, ctx), node.method + " " + url + (body == "" ? "" : "\n" + body));
    }
    if (node.type == "AGENT") {
      let said = fill(node.instruction, ctx);
      // The step's own thread when it names another agent; the run's when not.
      let inThread = threadId;
      if (node.agentId != "" && node.agentId != row.agentId) {
        inThread = openThread(db, { agentId: node.agentId, owner: ask.owner, now: `${Date.now() as number}` });
        if (inThread == "") { return withInput(stepFailed("no conversation could be opened for agent " + node.agentId), said); }
      }
      let turn: ThreadAsk = {
        userText: said,
        master: ask.master,
        tracer: tracerFor(db, ask.master),
        pick: inheritedPick(),
        think: false,
      };
      let answered = runInThreadWith(db, inThread, turn);
      if (!answered.run.ok) { return withInput(stepFailed(answered.run.error), said); }
      return withInput(stepOk(answered.text), said);
    }
    return stepFailed("\"" + node.type + "\" is not a step this deployment can run");
  };

  let clock = (): number => Date.now() as number;
  let walked = walk(parsed.graph, ask.input, step, clock, paint);

  let closed: WorkflowRunRow = {
    id: runId, workflowId: row.id, owner: ask.owner,
    status: walked.ok ? "ok" : "failed",
    input: ask.input, answer: walked.answer, error: walked.error,
    threadId: threadId, steps: JSON.stringify(walked.steps),
    startedAt: `${ask.nowMs}`, endedAt: `${Date.now() as number}`,
  };
  persist(db, workflowRunsMapping(), JSON.stringify(closed));

  let done: WorkflowDone = {
    ok: walked.ok, runId: runId, threadId: threadId,
    answer: walked.answer, error: walked.error,
  };
  return done;
}

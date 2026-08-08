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
import { existsById, findById, persist } from "../plume/plume.ts";
import { StepResult, WalkCtx, WfNode, WfOut, WfStep, Walked, emptyNode, fill, switchBranch, walk, walkFrom } from "../workflow/workflow.ts";
import { WorkflowRow, WorkflowRunRow, parseGraph, workflowRunsMapping } from "./workflow-store.ts";
import { AgentRow, McpServerRow, ModelConfigRow, ModelRow, agentsMapping, configAndModel, mcpServersMapping, modelConfigsMapping, modelsMapping } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { accessTokenFor } from "./connect.ts";
import { Turn, complete, replyText } from "./provider.ts";
import { ThreadAsk, inheritedPick, openThread, runInThreadWith, threadTurns, threadsMapping } from "./threads.ts";
import { tracerFor } from "./trace.ts";
import { queueOutbound, queueOutboundWith } from "./triggers.ts";
import { RunContext, runAgentAt } from "./run.ts";
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
  let told: StepResult = { ok: r.ok, output: r.output, branch: r.branch, error: r.error,
    input: said, threadId: r.threadId ?? "" };
  return told;
}

/** The same answer, saying which conversation it was written in. */
function inThread(r: StepResult, thread: string): StepResult {
  let told: StepResult = { ok: r.ok, output: r.output, branch: r.branch, error: r.error,
    input: r.input, threadId: thread };
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
  // A conversation to continue rather than a fresh one. Empty for a run
  // started by hand or by the clock — those are one-shot and a new
  // conversation each time is right. A trigger passes the one it keeps for
  // the chat that wrote in, which is what makes "and what about tomorrow?"
  // mean anything.
  threadId?: string,
  // Where a TELEGRAM_REPLY step speaks to, when a message started this run.
  // Empty for the clock and the Run button — the step then has nowhere to
  // send and says so on its row instead of failing the walk.
  botId?: string,
  chatId?: string,
};

export type WorkflowDone = {
  ok: bool,
  runId: string,
  threadId: string,
  answer: string,
  error: string,
  // A walk stopped at an ASK: the asking node and the outputs so far
  // (JSON), handed out because WHERE to keep them is the trigger's
  // business, not the walk's.
  waitingAt?: string,
  outputsSoFar?: string,
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

/** The SWITCH step: many ways out, chosen by matching a value.
 *
 *  Decided here for the same reason the condition is — it touches nothing but
 *  the text it is given — and the tested text passes through untouched, so a
 *  switch never breaks the chain of {{prev}}. */
function route(node: WfNode, ctx: WalkCtx): StepResult {
  let subject = node.subject == "" ? ctx.prev : fill(node.subject, ctx);
  return stepBranch(ctx.prev, switchBranch(node, subject));
}

/** The LLM step: one model call, no tools, on the workflow's agent's model. */
function askModel(db: Db, agent: AgentRow, master: string, prompt: string): StepResult {
  // configAndModel, not a typed parse of the mapping's document: the mapping
  // carries a `model` RELATION, so findById answers a document with a field
  // ModelConfigRow does not declare, and JSON.parse refuses unknown fields by
  // design (spec 252). This parsed the relation-bearing doc directly and
  // every LLM step died of it — as an uncaught throw, which killed the whole
  // scheduler pass and stranded the run at 'running' until the lease let
  // somebody else claim it. One step's defect must never again be every
  // message's outage; the runner split below is the other half of that.
  let held = configAndModel(db, agent.modelConfigId);
  if (held.problem != "") { return stepFailed(agent.agentName + ": " + held.problem); }
  let config = held.config;
  let model = held.model;
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
  let built = ensureBuilt(node.source ?? "");
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

  let carried = ask.threadId ?? "";
  // Continued, or opened. `existsById` rather than trust: a thread deleted
  // from the console must not make every later message from that chat fail.
  let threadId = carried != "" && existsById(db, threadsMapping(), carried)
    ? carried
    : openThread(db, { agentId: row.agentId, owner: ask.owner, now: `${ask.nowMs}` });
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
      let underway: WfStep = { nodeId: at.id, type: at.type, status: "RUNNING", ms: 0, input: "", output: "", error: "", threadId: "" };
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

  let step = stepFnFor(db, row, agent, ask, runId, threadId);
  let clock = (): number => Date.now() as number;
  let walked = walk(parsed.graph, ask.input, step, clock, paint);
  return closeWalk(db, row, ask.owner, runId, threadId, ask.input, `${ask.nowMs}`, walked, walked.steps);
}

function stepFnFor(db: Db, row: WorkflowRow, agent: AgentRow, ask: WorkflowAsk, runId: string, threadId: string): (node: WfNode, ctx: WalkCtx) => StepResult {
  return (node: WfNode, ctx: WalkCtx): StepResult => {
    // The entry, whichever kind it is: the walk begins here and hands on
    // whatever started it — the run's input, or the message that arrived.
    if (node.type == "START" || node.type == "TELEGRAM") { return withInput(stepOk(ctx.input), ctx.input); }
    if (node.type == "END") { return withInput(stepOk(ctx.prev), ctx.prev); }
    if (node.type == "CONDITION") {
      let tested = node.subject == "" ? ctx.prev : fill(node.subject, ctx);
      return withInput(decide(node, ctx), tested);
    }
    if (node.type == "SWITCH") {
      let tested = node.subject == "" ? ctx.prev : fill(node.subject, ctx);
      return withInput(route(node, ctx), tested);
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
    if (node.type == "TELEGRAM_ASK") {
      let asking = fill(node.instruction, ctx);
      let bot = ask.botId ?? "";
      let chat = ask.chatId ?? "";
      if (bot == "" || chat == "") {
        // The save-time rule keeps asks behind telegram triggers, so this is
        // the run-by-hand case, and the honest sentence is this one.
        return withInput(stepFailed("nobody can answer - this run was not started by a chat"), asking);
      }
      // The node's cases are its OFFERED ANSWERS, sent as tap buttons; the
      // tap arrives as a message holding the option's exact text, which a
      // SWITCH with the same values routes without parsing.
      queueOutboundWith(db, bot, chat, runId, asking, node.cases ?? "", Date.now() as number);
      let paused: StepResult = { ok: true, output: asking, branch: "", error: "", input: asking, suspend: true };
      return paused;
    }
    if (node.type == "TELEGRAM_REPLY") {
      let saying = fill(node.instruction, ctx);
      let bot = ask.botId ?? "";
      let chat = ask.chatId ?? "";
      if (bot == "" || chat == "") {
        // The clock or the Run button started this walk: there is no chat to
        // speak to. A pass-through rather than a failure, so one graph can
        // serve both doors — the reply simply has no audience today, and the
        // step row says exactly that.
        return withInput(stepOk(ctx.prev), "(no chat to reply to) " + saying);
      }
      // Queued now, mid-walk, not gathered at the end: the whole point of an
      // intermediate reply is that "searching…" arrives while the search is
      // still running. The poller drains the queue on its next pass.
      queueOutbound(db, bot, chat, runId, saying, Date.now() as number);
      // {{prev}} passes through untouched — the CONDITION rule, for the same
      // reason: a step that talks to the person must not break the chain the
      // next step reads. What was said is on the row as its input.
      return withInput(stepOk(ctx.prev), saying);
    }
    if (node.type == "AGENT") {
      let said = fill(node.instruction, ctx);
      if (node.agentId != "" && node.agentId != row.agentId) {
        // A step that names another agent runs it the way delegation does
        // (run.ts, the `child.id` branch): a FRESH conversation — replaying
        // the run's transcript into a specialist would ask it to answer
        // questions it was never part of — but the RUN's thread as its
        // workspace, because it is doing the run's work on the run's
        // material.
        //
        // This used to open a thread per step per run and answer through it,
        // which had two costs the fresh-thread comment above does not buy:
        // every file the step wrote landed in a conversation nothing else
        // could see (an artifact's identity is threadId:path), and a bot's
        // chat minted a throwaway thread per message that no sweeper takes.
        // The delegation pattern is the same isolation without either.
        let alone: Turn[] = [];
        let noChunks: string[] = [];
        let noPath: string[] = [];
        // The thread's turn count is the round every artifact write is
        // stamped with — the same number runInThreadWith passes for its own
        // writes — so files this step makes sit under the round that is
        // walking, not under TURN_SEQ_NONE where the panel's by-turn view
        // cannot place them.
        let atSeq = threadTurns(db, threadId).length;
        let below: RunContext = {
          depth: 0, path: noPath, tracer: tracerFor(db, ask.master),
          parentSpan: "", prior: alone, threadId: threadId,
          excludeChunks: noChunks,
          // The step's agent runs its operator's own model, never the
          // walk's — the delegation rule, for the delegation reason.
          modelConfigId: "",
          baseSeq: atSeq,
          owner: ask.owner,
          think: false,
        };
        let asked = runAgentAt(db, node.agentId, said, ask.master, below);
        // The run's thread, because that is where this step's files went and
        // the only page a person can follow the link to. The words shown on
        // the step row are its own input and output, so nothing is lost by
        // the transcript not being a sidebar conversation of its own.
        if (!asked.ok) { return inThread(withInput(stepFailed(asked.error), said), threadId); }
        return inThread(withInput(stepOk(asked.text), said), threadId);
      }
      let turn: ThreadAsk = {
        userText: said,
        master: ask.master,
        tracer: tracerFor(db, ask.master),
        pick: inheritedPick(),
        think: false,
      };
      let answered = runInThreadWith(db, threadId, turn);
      if (!answered.run.ok) { return inThread(withInput(stepFailed(answered.run.error), said), threadId); }
      return inThread(withInput(stepOk(answered.text), said), threadId);
    }
    return stepFailed("\"" + node.type + "\" is not a step this deployment can run");
  };
}

/** What a resume carries: the pending row's memory, plus this message. */
export type ResumeAsk = {
  runId: string,
  threadId: string,
  graph: string,
  nodeId: string,
  input: string,
  outputs: string,
  stepsSoFar: string,
  startedAt: string,
  reply: string,
  master: string,
  nowMs: number,
  botId: string,
  chatId: string,
};

/** The second half of an asked run: the person answered, and the walk
 *  continues from the question's edge with the reply as {{prev}}. It walks
 *  the GRAPH BYTES that were suspended — not whatever the workflow has
 *  become since — and appends to the suspended run's own row, so the canvas
 *  replays one run, whole. */
export function resumeWorkflow(db: Db, row: WorkflowRow, held: ResumeAsk): WorkflowDone {
  let parsed = parseGraph(held.graph);
  if (!parsed.ok) {
    let refused: WorkflowDone = { ok: false, runId: held.runId, threadId: held.threadId, answer: "", error: parsed.error };
    return refused;
  }
  let agentDoc = findById(db, agentsMapping(), row.agentId);
  if (agentDoc == "") {
    let refused: WorkflowDone = { ok: false, runId: held.runId, threadId: held.threadId, answer: "", error: "no agent " + row.agentId + " to run as" };
    return refused;
  }
  let agent: AgentRow = JSON.parse<AgentRow>(agentDoc);
  let runId = held.runId;
  let threadId = held.threadId;
  let ask: WorkflowAsk = {
    owner: row.owner, input: held.input, master: held.master,
    nowMs: held.nowMs, threadId: threadId, botId: held.botId, chatId: held.chatId,
  };
  let firstHalf: WfStep[] = JSON.parse<WfStep[]>(held.stepsSoFar);
  let paint = (steps: WfStep[], at: WfNode): void => {
    let all: WfStep[] = [];
    let f: int = 0;
    while (f < firstHalf.length) { all.push(firstHalf[f]); f = f + 1; }
    let g: int = 0;
    while (g < steps.length) { all.push(steps[g]); g = g + 1; }
    if (at.id != "") {
      let underway: WfStep = { nodeId: at.id, type: at.type, status: "RUNNING", ms: 0, input: "", output: "", error: "", threadId: "" };
      all.push(underway);
    }
    let live: WorkflowRunRow = {
      id: runId, workflowId: row.id, owner: row.owner,
      status: "running", input: held.input, answer: "", error: "",
      threadId: threadId, steps: JSON.stringify(all),
      startedAt: held.startedAt, endedAt: "",
    };
    persist(db, workflowRunsMapping(), JSON.stringify(live));
  };
  let step = stepFnFor(db, row, agent, ask, runId, threadId);
  let clock = (): number => Date.now() as number;
  let priorOuts: WfOut[] = JSON.parse<WfOut[]>(held.outputs);
  let walked = walkFrom(parsed.graph, held.input, held.nodeId, held.reply, priorOuts, step, clock, paint);

  let all: WfStep[] = [];
  let f: int = 0;
  while (f < firstHalf.length) { all.push(firstHalf[f]); f = f + 1; }
  let g: int = 0;
  while (g < walked.steps.length) { all.push(walked.steps[g]); g = g + 1; }
  return closeWalk(db, row, row.owner, runId, threadId, held.input, held.startedAt, walked, all);
}

/** The end of either half of a walk: the run row written with the right
 *  status — 'waiting' for a run stopped mid-question, which the resume
 *  reopens and finishes — and the outputs bundled for the pending row when
 *  there is one. `all` is the WHOLE trail (a resume prepends the first
 *  half), because the canvas replays one run, not two halves. */
function closeWalk(db: Db, row: WorkflowRow, owner: string, runId: string, threadId: string,
                   input: string, startedAt: string, walked: Walked, all: WfStep[]): WorkflowDone {
  let waiting = walked.waitingAt ?? "";
  let closed: WorkflowRunRow = {
    id: runId, workflowId: row.id, owner: owner,
    status: waiting != "" ? "waiting" : walked.ok ? "ok" : "failed",
    input: input, answer: walked.answer, error: walked.error,
    threadId: threadId, steps: JSON.stringify(all),
    startedAt: startedAt, endedAt: waiting != "" ? "" : `${Date.now() as number}`,
  };
  persist(db, workflowRunsMapping(), JSON.stringify(closed));
  let outsSoFar = "[]";
  if (waiting != "") {
    let outs: WfOut[] = [];
    let w: int = 0;
    while (w < all.length) {
      let one: WfOut = { nodeId: all[w].nodeId, output: all[w].output };
      outs.push(one);
      w = w + 1;
    }
    outsSoFar = JSON.stringify(outs);
  }
  let done: WorkflowDone = {
    ok: walked.ok, runId: runId, threadId: threadId,
    answer: walked.answer, error: walked.error,
    waitingAt: waiting, outputsSoFar: outsSoFar,
  };
  return done;
}

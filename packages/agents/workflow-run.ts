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

// What one web search step may pull in. Smaller than a chat turn's budget:
// a workflow chains steps, and each one's output is the next one's input.
const WEB_TOP_K: int = 6;
const WEB_MAX_CHARS: int = 6000;
const KNOW_TOP_K: int = 6;

function stepOk(output: string): StepResult {
  let r: StepResult = { ok: true, output: output, branch: "", error: "" };
  return r;
}

function stepBranch(output: string, branch: string): StepResult {
  let r: StepResult = { ok: true, output: output, branch: branch, error: "" };
  return r;
}

function stepFailed(why: string): StepResult {
  let r: StepResult = { ok: false, output: "", branch: "", error: why };
  return r;
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
      let underway: WfStep = { nodeId: at.id, type: at.type, status: "RUNNING", ms: 0, output: "", error: "" };
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
    if (node.type == "START") { return stepOk(ctx.input); }
    if (node.type == "END") { return stepOk(ctx.prev); }
    if (node.type == "CONDITION") { return decide(node, ctx); }
    if (node.type == "LLM") { return askModel(db, agent, ask.master, fill(node.instruction, ctx)); }
    if (node.type == "WEB_SEARCH") {
      let found = retrieveWeb(fill(node.query, ctx), WEB_TOP_K, WEB_MAX_CHARS);
      if (!found.ok) { return stepFailed(found.error); }
      if (found.found.length == 0) { return stepOk("The web index has nothing for: " + found.query); }
      return stepOk(asWebContext(found.found));
    }
    if (node.type == "KNOWLEDGE") { return lookUp(db, agent, ask.master, fill(node.query, ctx)); }
    if (node.type == "MCP") { return reachOut(db, node, ask.owner, ask.master, fill(node.args, ctx)); }
    if (node.type == "HTTP") { return fetchStep(node, ctx); }
    if (node.type == "AGENT") {
      // The step's own thread when it names another agent; the run's when not.
      let inThread = threadId;
      if (node.agentId != "" && node.agentId != row.agentId) {
        inThread = openThread(db, { agentId: node.agentId, owner: ask.owner, now: `${Date.now() as number}` });
        if (inThread == "") { return stepFailed("no conversation could be opened for agent " + node.agentId); }
      }
      let turn: ThreadAsk = {
        userText: fill(node.instruction, ctx),
        master: ask.master,
        tracer: tracerFor(db, ask.master),
        pick: inheritedPick(),
        think: false,
      };
      let answered = runInThreadWith(db, inThread, turn);
      if (!answered.run.ok) { return stepFailed(answered.run.error); }
      return stepOk(answered.text);
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

import { Db } from "../plume/driver.ts";
import { existsById, findById, persist } from "../plume/plume.ts";
import { MailAsk } from "../mail/mail.ts";
import { sendMail } from "./mail-send.ts";
import { StepResult, WalkCtx, WfNode, WfOut, WfStep, Walked, aggregated, asJsonList, casesOf, emptyNode, fill, headerLines, itemsOf, matches, outcomeAsk, outcomeFrom, refuse, secretIds, switchBranch, walk, walkFrom } from "../workflow/workflow.ts";
import { WorkflowRow, WorkflowRunRow, parseGraph, runsToday, workflowRunsMapping, workflowsMapping } from "./workflow-store.ts";
import { runsPerOwnerDay } from "./caps.ts";
import { AgentRow, McpServerRow, ModelConfigRow, ModelRow, agentsMapping, configAndModel, mcpServersMapping, modelConfigsMapping, modelsMapping } from "./schema.ts";
import { credentialFor, destinationOf } from "./credentials.ts";
import { SecretService } from "./routes/identity/secrets/secret.service.ts";
import { accessTokenFor } from "./connect.ts";
import { Turn, complete, replyText } from "./provider.ts";
import { ThreadAsk, inheritedPick, openThread, runInThreadWith, threadTurns, threadsMapping } from "./threads.ts";
import { tracerFor } from "./trace.ts";
import { fileBlock, queueOutbound, queueOutboundFile, queueOutboundWith } from "./triggers.ts";
import { RunContext, runAgentAt } from "./run.ts";
import { agentScopes, asContext, embeddingModel, retrieve, retrievalFor } from "./knowledge.ts";
import { callTool } from "./mcp.ts";
import { ScriptGiven, ScriptOut, ensureBuilt, runScript } from "./script-wasm.ts";

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

function withInput(r: StepResult, said: string): StepResult {
  let told: StepResult = { ok: r.ok, output: r.output, branch: r.branch, error: r.error,
    input: said, threadId: r.threadId ?? "" };
  return told;
}

function inThread(r: StepResult, thread: string): StepResult {
  let told: StepResult = { ok: r.ok, output: r.output, branch: r.branch, error: r.error,
    input: r.input, threadId: thread };
  return told;
}

export type WorkflowAsk = {
  owner: string,
  input: string,
  master: string,
  nowMs: number,
  threadId?: string,
  botId?: string,
  chatId?: string,
  // How many workflows deep this run already is. A sub-workflow raises it, and
  // MAX_DEPTH is what stops two workflows that call each other. Optional: a
  // run asked for from outside starts at the top and says nothing.
  depth?: int,
};

// A workflow may call a workflow, but not forever. Three is a parent, a child
// and a grandchild, which is as far as a drawing stays readable.
const MAX_DEPTH: int = 3;
// Named, because the scheduler reads it back: a day's budget spent is not a
// broken workflow, and must not count toward pausing one.
export const OVER_DAILY_RUNS: string = "that is enough runs for today";
// A pause is a step, and a step holds the run open. The graph refuses more
// than MAX_WAIT_SECONDS; this is the same bound in the place that sleeps.
const MAX_WAIT_MS: int = 60000;

export type WorkflowDone = {
  ok: bool,
  runId: string,
  threadId: string,
  answer: string,
  error: string,
  waitingAt?: string,
  outputsSoFar?: string,
};

function decide(node: WfNode, ctx: WalkCtx): StepResult {
  let subject = node.subject == "" ? ctx.prev : fill(node.subject, ctx);
  let has = subject.toLowerCase().includes(node.needle.toLowerCase());
  let verdict = false;
  if (node.test == "contains") {
    verdict = has;
  }
  if (node.test == "lacks") {
    verdict = !has;
  }
  if (node.test == "equals") {
    verdict = subject.trim() == node.needle.trim();
  }
  return stepBranch(ctx.prev, verdict ? "yes" : "no");
}

function route(node: WfNode, ctx: WalkCtx): StepResult {
  let subject = node.subject == "" ? ctx.prev : fill(node.subject, ctx);
  return stepBranch(ctx.prev, switchBranch(node, subject));
}

/** What a step answers when its node carries outcomes.
 *
 *  The text flows on as it always did; the branch is the outcome named on the
 *  last line, matched by the same rule a switch uses — so an outcome nobody
 *  drew an edge for, or none at all, lands on else rather than stopping the
 *  walk. A node with no outcomes is untouched and answers exactly as before.
 */
function outcomeStep(node: WfNode, said: StepResult): StepResult {
  if (!said.ok || casesOf(node).length == 0) {
    return said;
  }
  let read = outcomeFrom(said.output);
  return stepBranch(read.text, switchBranch(node, read.picked));
}

function askModel(db: Db, agent: AgentRow, master: string, prompt: string): StepResult {
  let held = configAndModel(db, agent.modelConfigId);
  if (held.fault != "") {
    return stepFailed(agent.agentName + ": " + held.fault);
  }
  let config = held.config;
  let model = held.model;
  if (!model.enabled) {
    return stepFailed(model.label + " is disabled");
  }
  let key = credentialFor(db, model.provider, master);
  if (key == "") {
    return stepFailed("no usable credential for " + model.provider);
  }
  let asked = complete(model, config,
    "You are one step in a workflow. Answer the instruction directly — your answer is handed "
    + "to the next step as text, so no preamble and no closing remarks.",
    prompt, key);
  if (!asked.ok) {
    return stepFailed(asked.error);
  }
  return stepOk(replyText(model.provider, asked.text).trim());
}

function lookUp(db: Db, agent: AgentRow, owner: string, master: string, question: string): StepResult {
  let want = retrievalFor(db, agent.id);
  if (want.embeddingModelId == "" || !want.enabled) {
    return stepFailed(agent.agentName + " has no document retrieval set up — a KNOWLEDGE step needs it");
  }
  if (db.name != "postgres") {
    return stepFailed("retrieval needs PostgreSQL; this runs on " + db.name);
  }
  let embedder = embeddingModel(db, want.embeddingModelId);
  if (embedder.id == "") {
    return stepFailed("no usable embedding model " + want.embeddingModelId);
  }
  let granted = agentScopes(db, agent.id);
  if (granted.length == 0) {
    return stepFailed(agent.agentName + " has no scopes granted, so there is nothing to read");
  }
  let key = credentialFor(db, embedder.provider, master);
  if (key == "") {
    return stepFailed("no credential for " + embedder.provider);
  }
  let found = retrieve(db, embedder, owner, granted, question, KNOW_TOP_K, key);
  if (!found.ok) {
    return stepFailed(found.error);
  }
  if (found.found.length == 0) {
    return stepOk("Nothing in the documents matches: " + question);
  }
  return stepOk(asContext(found.found));
}

function reachOut(db: Db, node: WfNode, owner: string, master: string, args: string): StepResult {
  let doc = findById(db, mcpServersMapping(), node.serverId);
  if (doc == "") {
    return stepFailed("no connector " + node.serverId + " — it may have been removed");
  }
  let server: McpServerRow = JSON.parse<McpServerRow>(doc);
  if (!server.enabled) {
    return stepFailed(server.serverName + " is switched off");
  }
  let token = accessTokenFor(db, server, owner, master);
  if (server.authKind != "" && server.authKind != "none" && token == "") {
    return stepFailed(server.serverName + " needs a token and none is stored for it");
  }
  let called = callTool(server, node.tool, args == "" ? "{}" : args, token);
  if (!called.ok) {
    return stepFailed(called.error);
  }
  return stepOk(called.text);
}

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

function runScriptStep(node: WfNode, ctx: WalkCtx, runId: string): StepResult {
  let built = ensureBuilt(node.source ?? "");
  if (!built.ok) {
    return stepFailed(built.error);
  }
  let dir = "/tmp/agents-script-run/" + runId + "-" + node.id;
  let ran = runScript(built.path, scriptGiven(ctx), dir);
  if (!ran.ok) {
    return stepFailed(ran.error);
  }
  return stepOk(ran.output);
}

function fetchStep(db: Db, node: WfNode, ctx: WalkCtx, owner: string, master: string): StepResult {
  let url = fill(node.url, ctx);
  let headers = new Map<string, string>();
  headers.set("Content-Type", "application/json");
  let lines = headerLines(node);
  let h: int = 0;
  while (h < lines.length) {
    let colon = lines[h].indexOf(":");
    if (colon > 0) {
      headers.set(lines[h].slice(0, colon).trim(), fill(lines[h].slice(colon + 1, lines[h].length).trim(), ctx));
    }
    h = h + 1;
  }
  let secrets = new SecretService(db, master);
  let held = secretIds(node);
  let s: int = 0;
  while (s < held.length) {
    let secret = secrets.repository.byId(held[s], owner);
    if (secret.id == "") {
      return stepFailed("this step names a secret that is not here any more — pick another in the step's settings");
    }
    if (destinationOf(url) != secret.destination) {
      return stepFailed("this step sends to " + (destinationOf(url) == "" ? "an address this cannot read" : destinationOf(url))
        + ", and \"" + secret.name + "\" was stored for " + secret.destination
        + " — a secret is only sent to the address it was stored for");
    }
    let value = secrets.value(secret);
    if (value == "") {
      return stepFailed("\"" + secret.name + "\" could not be opened — delete it and add it again");
    }
    headers.set(secret.header, value);
    secrets.touch(secret.id, `${Date.now() as number}`);
    s = s + 1;
  }
  let body = node.method == "GET" ? "" : fill(node.body, ctx);
  let res = http.request(url, node.method, body, headers);
  if (res.status < 0) {
    return stepFailed("no answer from " + url);
  }
  if (res.status < 200 || res.status > 299) {
    return stepFailed(url + " answered " + `${res.status}` + ": " + res.body.slice(0, 300));
  }
  return stepOk(res.body);
}

/* A step that sends mail.
 *
 * Everything about it is templated except who it is from: a step can mail an
 * address an earlier step produced, and can never change the sender. The
 * failure is a step failure like any other, so a workflow that could not send
 * stops with the reason on the step rather than carrying on as though it had.
 */
function mailStep(db: Db, master: string, node: WfNode, ctx: WalkCtx, owner: string): StepResult {
  let ask: MailAsk = {
    to: fill(node.to ?? "", ctx),
    subject: fill(node.subject, ctx),
    body: fill(node.body, ctx),
  };
  let sent = sendMail(db, master, ask, owner);
  if (!sent.ok) {
    return stepFailed(sent.fault);
  }
  return stepOk("Sent to " + sent.to + ", subject \"" + ask.subject + "\".");
}

export function runWorkflow(db: Db, row: WorkflowRow, ask: WorkflowAsk): WorkflowDone {
  let parsed = parseGraph(row.graph);
  if (!parsed.ok) {
    let refused: WorkflowDone = {
      ok: false,
      runId: "",
      threadId: "",
      answer: "",
      error: parsed.error,
    };
    return refused;
  }
  // What one account may spend of the deployment's model budget in a day. A
  // sub-workflow counts, because it costs the same as any other run.
  let already = runsToday(db, row.owner, ask.nowMs);
  let allowed = runsPerOwnerDay();
  if (already >= allowed) {
    let spent: WorkflowDone = {
      ok: false,
      runId: "",
      threadId: "",
      answer: "",
      error: OVER_DAILY_RUNS + ": " + `${already}` + " today, and " + `${allowed}`
        + " is the most one account may start. It starts again at midnight UTC.",
    };
    return spent;
  }
  // A draft may hold a step nobody has finished — that is what drafts are for
  // — and a workflow never published runs its draft. Say which step, once,
  // rather than failing partway through on an empty url.
  let notReady = refuse(parsed.graph);
  if (notReady != "") {
    let unfinished: WorkflowDone = {
      ok: false,
      runId: "",
      threadId: "",
      answer: "",
      error: notReady,
    };
    return unfinished;
  }
  let agentDoc = findById(db, agentsMapping(), row.agentId);
  if (agentDoc == "") {
    let refused: WorkflowDone = {
      ok: false,
      runId: "",
      threadId: "",
      answer: "",
      error: "no agent " + row.agentId + " to run as",
    };
    return refused;
  }
  let agent: AgentRow = JSON.parse<AgentRow>(agentDoc);

  let carried = ask.threadId ?? "";
  let threadId = carried != "" && existsById(db, threadsMapping(), carried)
    ? carried
    : openThread(db, { agentId: row.agentId, owner: ask.owner, now: `${ask.nowMs}` });
  if (threadId == "") {
    let refused: WorkflowDone = {
      ok: false,
      runId: "",
      threadId: "",
      answer: "",
      error: "the conversation could not be opened",
    };
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

  let paint = (sofar: WfStep[], at: WfNode): void => {
    let all: WfStep[] = [];
    let i: int = 0;
    while (i < sofar.length) {
      all.push(sofar[i]);
      i = i + 1;
    }
    if (at.id != "") {
      let underway: WfStep = {
        nodeId: at.id,
        type: at.type,
        status: "RUNNING",
        ms: 0,
        input: "",
        output: "",
        error: "",
        threadId: "",
      };
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
    if (node.type == "START" || node.type == "TELEGRAM") {
      return withInput(stepOk(ctx.input), ctx.input);
    }
    if (node.type == "END") {
      return withInput(stepOk(ctx.prev), ctx.prev);
    }
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
      return withInput(outcomeStep(node, askModel(db, agent, ask.master, said + outcomeAsk(node))), said);
    }
    if (node.type == "WEB_SEARCH") {
      /* The built-in web index left with Discover (it was Joule's, not this
       * engine's). The node stays loadable so an old graph still validates;
       * it fails with the way forward rather than answering from nothing. */
      let asked = fill(node.query, ctx);
      return withInput(stepFailed("web search is no longer built in - mount a search tool (MCP) and use an AGENT step"), asked);
    }
    if (node.type == "KNOWLEDGE") {
      let asked = fill(node.query, ctx);
      return withInput(lookUp(db, agent, ask.owner, ask.master, asked), asked);
    }
    if (node.type == "MCP") {
      let args = fill(node.args, ctx);
      return withInput(reachOut(db, node, ask.owner, ask.master, args), node.tool + " " + args);
    }
    if (node.type == "SCRIPT") {
      return withInput(runScriptStep(node, ctx, runId), ctx.prev);
    }
    if (node.type == "HTTP") {
      let url = fill(node.url, ctx);
      let body = node.method == "GET" ? "" : fill(node.body, ctx);
      return withInput(fetchStep(db, node, ctx, ask.owner, ask.master), node.method + " " + url + (body == "" ? "" : "\n" + body));
    }
    if (node.type == "EMAIL") {
      let to = fill(node.to ?? "", ctx);
      let subject = fill(node.subject, ctx);
      return withInput(mailStep(db, ask.master, node, ctx, ask.owner), to + "\n" + subject);
    }
    if (node.type == "TELEGRAM_ASK") {
      let asking = fill(node.instruction, ctx);
      let bot = ask.botId ?? "";
      let chat = ask.chatId ?? "";
      if (bot == "" || chat == "") {
        return withInput(stepFailed("nobody can answer - this run was not started by a chat"), asking);
      }
      let queued = queueOutboundWith(db, bot, chat, runId, asking, node.cases ?? "", Date.now() as number);
      if (queued == "") {
        return withInput(stepFailed("the question could not be sent"), asking);
      }
      let paused: StepResult = {
        ok: true,
        output: asking,
        branch: "",
        error: "",
        input: asking,
        suspend: true,
      };
      return paused;
    }
    if (node.type == "TELEGRAM_REPLY") {
      let saying = fill(node.instruction, ctx);
      let bot = ask.botId ?? "";
      let chat = ask.chatId ?? "";
      if (bot == "" || chat == "") {
        return withInput(stepOk(ctx.prev), "(no chat to reply to) " + saying);
      }
      let sendPath = fill(node.body, ctx).trim();
      if (sendPath == "") {
        sendPath = fileBlock(saying);
      }
      let queued = sendPath != ""
        ? queueOutboundFile(db, bot, chat, runId, saying, threadId, sendPath, Date.now() as number)
        : queueOutbound(db, bot, chat, runId, saying, Date.now() as number);
      if (queued == "") {
        return withInput(stepFailed("the reply could not be sent"), saying);
      }
      return withInput(stepOk(ctx.prev), saying);
    }
    if (node.type == "AGENT") {
      let said = fill(node.instruction, ctx) + outcomeAsk(node);
      if (node.agentId != "" && node.agentId != row.agentId) {
        let alone: Turn[] = [];
        let noChunks: string[] = [];
        let noPath: string[] = [];
        let atSeq = threadTurns(db, threadId).length;
        let below: RunContext = {
          depth: 0, path: noPath, tracer: tracerFor(db, ask.master),
          parentSpan: "", prior: alone, threadId: threadId,
          excludeChunks: noChunks,
          modelConfigId: "",
          baseSeq: atSeq,
          owner: ask.owner,
          think: false,
          scope: "",
          mustSearch: false,
        };
        let asked = runAgentAt(db, node.agentId, said, ask.master, below);
        if (!asked.ok) {
          return inThread(withInput(stepFailed(asked.error), said), threadId);
        }
        return inThread(withInput(outcomeStep(node, stepOk(asked.text)), said), threadId);
      }
      let turn: ThreadAsk = {
        userText: said,
        master: ask.master,
        tracer: tracerFor(db, ask.master),
        pick: inheritedPick(),
        think: false,
        scope: "",
        mustSearch: false,
        titledElsewhere: false,
      };
      let answered = runInThreadWith(db, threadId, turn);
      if (!answered.run.ok) {
        return inThread(withInput(stepFailed(answered.run.error), said), threadId);
      }
      return inThread(withInput(outcomeStep(node, stepOk(answered.text)), said), threadId);
    }
    if (node.type == "SET") {
      let said = fill(node.instruction, ctx);
      return withInput(stepOk(said), said);
    }
    if (node.type == "WAIT") {
      let held = parseInt((node.amount ?? "").trim(), 10) ?? 0;
      if (held < 1) { return stepFailed("this step does not say how long to wait"); }
      let ms = held * 1000;
      process.sleep(ms > MAX_WAIT_MS ? MAX_WAIT_MS : ms);
      return withInput(stepOk(ctx.prev), ctx.prev);
    }
    if (node.type == "FILTER") {
      let listed = node.query.trim() == "" ? ctx.prev : fill(node.query, ctx);
      let all = itemsOf(listed);
      let want = fill(node.needle, ctx);
      let kept: string[] = [];
      let i: int = 0;
      while (i < all.length) {
        if (matches(node.test, want, all[i])) { kept.push(all[i]); }
        i = i + 1;
      }
      return withInput(stepOk(asJsonList(kept)), listed);
    }
    if (node.type == "AGGREGATE") {
      let listed = node.query.trim() == "" ? ctx.prev : fill(node.query, ctx);
      return withInput(stepOk(aggregated((node.op ?? "").trim(), itemsOf(listed))), listed);
    }
    if (node.type == "SUB_WORKFLOW") {
      let wanted = (node.workflowId ?? "").trim();
      if (wanted == row.id) { return stepFailed("a workflow cannot run itself"); }
      let deep = (ask.depth ?? 0) + 1;
      if (deep > MAX_DEPTH) {
        return stepFailed("workflows are nested " + `${deep}` + " deep — the most is " + `${MAX_DEPTH}`);
      }
      let doc = findById(db, workflowsMapping(), wanted);
      if (doc == "") { return stepFailed("the workflow this step runs is gone: " + wanted); }
      let inner: WorkflowRow = JSON.parse<WorkflowRow>(doc);
      if (inner.owner != row.owner) { return stepFailed("that workflow belongs to somebody else"); }
      let said = node.instruction.trim() == "" ? ctx.prev : fill(node.instruction, ctx);
      let below: WorkflowAsk = {
        owner: ask.owner, input: said, master: ask.master, nowMs: ask.nowMs,
        threadId: threadId, botId: ask.botId ?? "", chatId: ask.chatId ?? "", depth: deep,
      };
      let ran = runWorkflow(db, inner, below);
      if (!ran.ok) { return withInput(stepFailed(inner.name + ": " + ran.error), said); }
      return withInput(stepOk(ran.answer), said);
    }
    return stepFailed("\"" + node.type + "\" is not a step this deployment can run");
  };
}

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

export function resumeWorkflow(db: Db, row: WorkflowRow, held: ResumeAsk): WorkflowDone {
  let parsed = parseGraph(held.graph);
  if (!parsed.ok) {
    let refused: WorkflowDone = {
      ok: false,
      runId: held.runId,
      threadId: held.threadId,
      answer: "",
      error: parsed.error,
    };
    return refused;
  }
  let agentDoc = findById(db, agentsMapping(), row.agentId);
  if (agentDoc == "") {
    let refused: WorkflowDone = {
      ok: false,
      runId: held.runId,
      threadId: held.threadId,
      answer: "",
      error: "no agent " + row.agentId + " to run as",
    };
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
    while (f < firstHalf.length) {
      all.push(firstHalf[f]);
      f = f + 1;
    }
    let g: int = 0;
    while (g < steps.length) {
      all.push(steps[g]);
      g = g + 1;
    }
    if (at.id != "") {
      let underway: WfStep = {
        nodeId: at.id,
        type: at.type,
        status: "RUNNING",
        ms: 0,
        input: "",
        output: "",
        error: "",
        threadId: "",
      };
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
  while (f < firstHalf.length) {
    all.push(firstHalf[f]);
    f = f + 1;
  }
  let g: int = 0;
  while (g < walked.steps.length) {
    all.push(walked.steps[g]);
    g = g + 1;
  }
  return closeWalk(db, row, row.owner, runId, threadId, held.input, held.startedAt, walked, all);
}

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
  let written = persist(db, workflowRunsMapping(), JSON.stringify(closed));
  if (!written.ok) {
    let lost: WorkflowDone = {
      ok: false, runId: runId, threadId: threadId,
      answer: walked.answer, error: "the run finished but could not be saved: " + written.error,
      waitingAt: "", outputsSoFar: "[]",
    };
    return lost;
  }
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

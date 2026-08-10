import { Db, DbConfig } from "../plume/driver.ts";
import { postgres } from "../plume/postgres.ts";
import { connectDatabase, findById, persist } from "../plume/plume.ts";
import { masterKey } from "./credentials.ts";
import { claimDue, markFailed, markRan, TaskRow } from "./tasks.ts";
import { WorkflowRow, claimDueWorkflow, markWorkflowFailed, markWorkflowRan, withGraph, workflowsMapping } from "./workflow-store.ts";
import { ResumeAsk, WorkflowAsk, resumeWorkflow, runWorkflow } from "./workflow-run.ts";
import { openThread, runInThreadWith, inheritedPick, ThreadAsk } from "./threads.ts";
import { tracerFor } from "./trace.ts";
import { discoverModelId, discoverStoriesMapping, readable, unreadableStories, withReadableBody } from "./discover.ts";
import { recordRun } from "./runlog.ts";
import { TURN_SEQ_NONE, binaryKind, kindOf, putArtifact } from "./artifacts.ts";
import { TRIGGER_ASK_TTL_MS, TriggerInboxRow, TriggerPendingRow, botById, claimMessage, finishMessage, forgetAsk, noteThread, pendingFor, plainly, queueOutbound, rememberAsk, testingDraft, threadForChat } from "./triggers.ts";

const PER_PASS: int = 5;
const TRIGGER_RUNNERS: int = 3;
const WORKFLOWS_PER_PASS: int = 2;

function main(): void {
  let master = masterKey();
  if (master == "") {
    console.error("LUMEN_MASTER_KEY is not set — the scheduler cannot read provider credentials");
    return;
  }
  if ((process.env("SCHEDULER_CHILD") ?? "") == "triggers") {
    let db2 = postgres();
    let server2: DbConfig = {
      host: process.env("AGENTS_PG_HOST") ?? "127.0.0.1",
      database: process.env("AGENTS_PG_DATABASE") ?? "agents",
      user: process.env("AGENTS_PG_USER") ?? "agents",
      password: process.env("AGENTS_PG_PASSWORD") ?? "",
    };
    connectDatabase(db2, server2);
    drainTriggers(db2, master);
    return;
  }

  let db = postgres();
  let server: DbConfig = {
    host: process.env("AGENTS_PG_HOST") ?? "127.0.0.1",
    database: process.env("AGENTS_PG_DATABASE") ?? "agents",
    user: process.env("AGENTS_PG_USER") ?? "agents",
    password: process.env("AGENTS_PG_PASSWORD") ?? "",
  };
  connectDatabase(db, server);

  let fired: int = 0;
  while (fired < PER_PASS) {
    let task = claimDue(db, Date.now() as number);
    if (task.id == "") {
      break;
    }
    try {
      fire(db, task, master);
    }
    catch (e) {
      console.error("scheduler: " + task.id + " threw: " + e.message);
      markFailed(db, task, e.message, Date.now() as number);
    }
    fired = fired + 1;
  }
  if (fired > 0) {
    console.log("scheduler: fired " + `${fired}`);
  }

  let walked: int = 0;
  while (walked < WORKFLOWS_PER_PASS) {
    let flow = claimDueWorkflow(db, Date.now() as number);
    if (flow.id == "") {
      break;
    }
    try {
      fireWorkflow(db, flow, master);
    }
    catch (e) {
      console.error("scheduler: workflow " + flow.id + " threw: " + e.message);
      markWorkflowFailed(db, flow, e.message, Date.now() as number);
    }
    walked = walked + 1;
  }
  if (walked > 0) {
    console.log("scheduler: walked " + `${walked}` + " workflows");
  }

  reflow(db, master);

  sweep(db);

  let waiting = queuedMessages(db);
  if (waiting > 0) {
    let runners = waiting < TRIGGER_RUNNERS ? waiting : TRIGGER_RUNNERS;
    let r: int = 0;
    while (r < runners) {
      child_process.spawnSync("bash", ["-c",
        "SCHEDULER_CHILD=triggers setsid " + ownBinary() + " >> .lumen-scheduler-runner.log 2>&1 < /dev/null &"]);
      r = r + 1;
    }
    console.log("scheduler: launched " + `${runners}` + " runner(s) for " + `${waiting}` + " queued message(s)");
  }
}

function ownBinary(): string {
  return process.env("AGENTS_SCHEDULER_BIN") ?? "./scheduler";
}

const KEEP_RUNS_MS: number = 2592000000.0;
const KEEP_TRAFFIC_MS: number = 1209600000.0;

function sweep(db: Db): void {
  let now = Date.now() as number;
  let runsBefore = `${now - KEEP_RUNS_MS}`;
  let trafficBefore = `${now - KEEP_TRAFFIC_MS}`;
  db.query("DELETE FROM workflow_runs WHERE started_at <> '' AND started_at < " + db.placeholder
    + " AND status <> 'waiting' AND status <> 'running'", [runsBefore]);
  db.query("DELETE FROM trigger_inbox WHERE created_at < " + db.placeholder
    + " AND status <> 'queued' AND status <> 'running'", [trafficBefore]);
  db.query("DELETE FROM trigger_outbox WHERE created_at < " + db.placeholder
    + " AND status = 'sent'", [trafficBefore]);
  db.query("DELETE FROM trigger_pending WHERE expires_at < " + db.placeholder, [trafficBefore]);
}

function queuedMessages(db: Db): int {
  if (!db.query("SELECT count(*) FROM trigger_inbox WHERE status = 'queued'", [])) {
    return 0;
  }
  if (db.rows() == 0) {
    return 0;
  }
  return parseInt(db.value(0, 0), 10) ?? 0;
}

function rememberOpenQuestion(db: Db, msg: TriggerInboxRow, flow: WorkflowRow, done: WorkflowDone): void {
  let now = Date.now() as number;
  let row: TriggerPendingRow = {
    id: crypto.randomUUID(), botId: msg.botId, chatId: msg.chatId,
    workflowId: flow.id, runId: done.runId, nodeId: done.waitingAt ?? "",
    graph: flow.graph, input: msg.input, outputs: done.outputsSoFar ?? "[]",
    threadId: done.threadId,
    expiresAt: `${now + (TRIGGER_ASK_TTL_MS as number)}`,
    createdAt: `${now}`,
  };
  rememberAsk(db, row);
}

function drainTriggers(db: Db, master: string): void {
  let answered: int = 0;
  while (answered < 50) {
    let msg = claimMessage(db, Date.now() as number);
    if (msg.id == "") {
      break;
    }
    try {
      answer(db, msg, master);
    }
    catch (e) {
      console.error("scheduler: trigger message " + msg.id + " threw: " + e.message);
      finishMessage(db, msg, "failed", "", "", e.message, Date.now() as number);
    }
    answered = answered + 1;
  }
  if (answered > 0) {
    console.log("scheduler: answered " + `${answered}` + " triggered messages");
  }
}

function answer(db: Db, msg: TriggerInboxRow, master: string): void {
  let doc = findById(db, workflowsMapping(), msg.workflowId);
  if (doc == "") {
    finishMessage(db, msg, "failed", "", "", "no workflow " + msg.workflowId, Date.now() as number);
    return;
  }
  let flow: WorkflowRow = JSON.parse<WorkflowRow>(doc);

  let open = pendingFor(db, msg.botId, msg.chatId, Date.now() as number);
  if (open.id != "") {
    forgetAsk(db, open.id);
    let stepsSoFar = "[]";
    let runDoc = findById(db, workflowRunsMapping(), open.runId);
    if (runDoc != "") {
      stepsSoFar = jsonText(runDoc, "steps");
    }
    let held: ResumeAsk = {
      runId: open.runId, threadId: open.threadId, graph: open.graph,
      nodeId: open.nodeId, input: open.input, outputs: open.outputs,
      stepsSoFar: stepsSoFar == "" ? "[]" : stepsSoFar,
      startedAt: jsonText(runDoc, "startedAt"),
      reply: msg.input, master: master, nowMs: Date.now() as number,
      botId: msg.botId, chatId: msg.chatId,
    };
    let resumed = resumeWorkflow(db, flow, held);
    if (resumed.threadId != "") {
      noteThread(db, msg.id, resumed.threadId);
    }
    if ((resumed.waitingAt ?? "") != "") {
      rememberOpenQuestion(db, msg, withGraph(flow, open.graph), resumed);
      finishMessage(db, msg, "done", resumed.runId, "", "", Date.now() as number);
      return;
    }
    if (!resumed.ok) {
      finishMessage(db, msg, "failed", resumed.runId, "", resumed.error, Date.now() as number);
      return;
    }
    finishMessage(db, msg, "done", resumed.runId, plainly(resumed.answer), "", Date.now() as number);
    return;
  }

  let bot = botById(db, msg.botId);
  let onDraft = testingDraft(bot, Date.now() as number);
  let bytes = onDraft ? flow.graph
    : (flow.publishedGraph ?? "") == "" ? flow.graph : (flow.publishedGraph ?? "");
  flow = withGraph(flow, bytes);
  let ask: WorkflowAsk = {
    owner: msg.owner,
    input: (msg.speaker ?? "") == "" ? msg.input : (msg.speaker ?? "") + ": " + msg.input,
    master: master,
    nowMs: Date.now() as number,
    threadId: threadForChat(db, msg.botId, msg.chatId),
    botId: msg.botId, chatId: msg.chatId,
  };
  if ((msg.fileName ?? "") != "" && (msg.fileBody ?? "") != "") {
    let home = ask.threadId ?? "";
    if (home == "") {
      home = openThread(db, {
        agentId: flow.agentId,
        owner: msg.owner,
        now: `${Date.now() as number}`,
      });
    }
    if (home != "") {
      let path = "/" + (msg.fileName ?? "document");
      let body = msg.fileBody ?? "";
      if (!binaryKind(kindOf(path))) {
        body = crypto.base64Decode(body);
      }
      let filed = putArtifact(db, {
        threadId: home, path: path,
        title: msg.fileName ?? "document",
        content: body, note: "sent over Telegram",
        origin: "uploaded", mustCreate: false,
        turnSeq: TURN_SEQ_NONE, now: `${Date.now() as number}`,
      });
      if (!filed.ok) {
        finishMessage(db, msg, "failed", "", "", filed.problem, Date.now() as number);
        queueOutbound(db, msg.botId, msg.chatId, "", "I could not keep that file: " + filed.problem, Date.now() as number);
        return;
      }
      ask = { owner: ask.owner, input: msg.input == "" ? "the file " + (msg.fileName ?? "") : msg.input,
        master: ask.master, nowMs: ask.nowMs, threadId: home,
        botId: ask.botId, chatId: ask.chatId };
    }
  }
  let done = runWorkflow(db, flow, ask);
  if (done.threadId != "") {
    noteThread(db, msg.id, done.threadId);
  }
  if ((done.waitingAt ?? "") != "") {
    rememberOpenQuestion(db, msg, flow, done);
    finishMessage(db, msg, "done", done.runId, "", "", Date.now() as number);
    return;
  }
  if (!done.ok) {
    finishMessage(db, msg, "failed", done.runId, "", done.error, Date.now() as number);
    return;
  }
  finishMessage(db, msg, "done", done.runId, plainly(done.answer), "", Date.now() as number);
}

const REFLOW_PER_PASS: int = 3;

function reflow(db: Db, master: string): void {
  let waiting = unreadableStories(db, REFLOW_PER_PASS);
  let i: int = 0;
  let done: int = 0;
  while (i < waiting.length) {
    try {
      let better = readable(db, waiting[i].body, discoverModelId(), master);
      if (better != "") {
        persist(db, discoverStoriesMapping(), JSON.stringify(withReadableBody(waiting[i], better)));
        done = done + 1;
      }
    } catch (e) {
      console.error("scheduler: reflow " + waiting[i].id + ": " + e.message);
    }
    i = i + 1;
  }
  if (done > 0) {
    console.log("scheduler: made " + `${done}` + " stories readable");
  }
}

function fireWorkflow(db: Db, flow: WorkflowRow, master: string): void {
  let ask: WorkflowAsk = {
    owner: flow.owner, input: "", master: master,
    nowMs: Date.now() as number,
  };
  let bytes = flow.kind == "manual" ? flow.graph
    : (flow.publishedGraph ?? "") == "" ? flow.graph : (flow.publishedGraph ?? "");
  let done = runWorkflow(db, withGraph(flow, bytes), ask);
  if (!done.ok) {
    markWorkflowFailed(db, flow, done.error, Date.now() as number);
    return;
  }
  markWorkflowRan(db, flow, done.runId, Date.now() as number);
}

function fire(db: Db, task: TaskRow, master: string): void {
  let now = Date.now() as number;
  let threadId = openThread(db, { agentId: task.agentId, owner: task.owner, now: `${now}` });
  if (threadId == "") {
    markFailed(db, task, "the conversation could not be opened", now);
    return;
  }

  let ask: ThreadAsk = {
    userText: task.instruction,
    master: master,
    tracer: tracerFor(db, master),
    pick: inheritedPick(),
    think: false,
    scope: "",
};
  let answered = runInThreadWith(db, threadId, ask);

  let runId = recordRun(db, {
    agentId: task.agentId, threadId: threadId, owner: task.owner,
    question: task.instruction,
    run: answered.run,
    modelChoiceId: answered.modelChoiceId, routeNote: answered.routeNote,
  });

  if (!answered.run.ok) {
    markFailed(db, task, answered.run.error, Date.now() as number);
    return;
  }
  markRan(db, task, runId, Date.now() as number);
}

main();

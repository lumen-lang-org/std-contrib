// The scheduler: claim what is due, run it, record it, exit.
//
//   AGENTS_PG_HOST=db LUMEN_MASTER_KEY=… scheduler
//
// One pass and then it stops. The clock is systemd's — `joule-scheduler.timer`
// fires this every minute — and that is deliberate in three ways:
//
//   A process that exits cannot leak. This runtime never frees, which is why
//   the engine's unit carries MemoryMax=2G and Restart=always; a scheduler that
//   ran forever would hold every transcript it had ever fired.
//
//   A `Worker.run` thread inside the engine cannot do this. A worker body may
//   not throw — `Worker.run` takes `() => T` while anything touching the
//   database, JSON or an HTTP endpoint is `error{LumenThrow}!T` — so the try
//   has to wrap the whole loop, and the first provider timeout would end every
//   task on the deployment until somebody restarted the engine. indexer.ts is
//   a process for exactly this reason. Here the try is per task, inside the
//   pass, so one failure costs one task.
//
//   systemd will not start a second instance while one is running, so a pass
//   that overruns skips a tick instead of piling up. The claim makes that safe
//   rather than merely tolerable.
//
// What a fired task leaves behind is an ordinary conversation, opened against
// the task's agent and answered through the same `runInThreadWith` a person's
// message goes through. There is no second run path, which is the point: a
// task's answer is a conversation in the sidebar, indistinguishable from one
// somebody typed, and every fix to how turns work reaches it for free.

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
import { TRIGGER_ASK_TTL_MS, TriggerInboxRow, TriggerPendingRow, botById, claimMessage, finishMessage, forgetAsk, noteThread, pendingFor, plainly, rememberAsk, testingDraft, threadForChat } from "./triggers.ts";

// How many tasks one pass will fire before leaving the rest to the next tick.
// A bound rather than "drain it": a pass that runs forty agent turns holds the
// unit active for an hour, and every tick in that hour is silently dropped.
const PER_PASS: int = 5;
// How many trigger runners one pass will launch. Each is a whole process
// walking whole graphs, so this bounds concurrent model spend, not threads.
const TRIGGER_RUNNERS: int = 3;
// Fewer workflows than tasks per pass: one workflow is several model turns.
const WORKFLOWS_PER_PASS: int = 2;

function main(): void {
  let master = masterKey();
  if (master == "") {
    console.error("LUMEN_MASTER_KEY is not set — the scheduler cannot read provider credentials");
    return;
  }
  // Child mode: walk triggered messages until the queue is dry, then exit.
  // Everything else — tasks, clock workflows, reflow — belongs to the timer's
  // own pass; a runner exists so that work and this work cannot block each
  // other.
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

  // No migrations here, for the reason indexer.ts records: the API owns the
  // schema, and plume refuses a plan that does not account for every migration
  // already recorded. If the table is not there yet, the claim finds nothing.
  let fired: int = 0;
  while (fired < PER_PASS) {
    let task = claimDue(db, Date.now() as number);
    if (task.id == "") { break; }
    // Per task, not around the pass: a task whose provider is down must cost
    // that task and not the four behind it.
    try { fire(db, task, master); }
    catch (e) {
      console.error("scheduler: " + task.id + " threw: " + e.message);
      markFailed(db, task, e.message, Date.now() as number);
    }
    fired = fired + 1;
  }
  if (fired > 0) { console.log("scheduler: fired " + `${fired}`); }

  // Workflows, the same way: claim, walk, record, per-workflow try. A graph
  // whose provider is down must cost that graph and not the pass. Fewer per
  // pass than tasks, because one workflow is several model turns.
  let walked: int = 0;
  while (walked < WORKFLOWS_PER_PASS) {
    let flow = claimDueWorkflow(db, Date.now() as number);
    if (flow.id == "") { break; }
    try { fireWorkflow(db, flow, master); }
    catch (e) {
      console.error("scheduler: workflow " + flow.id + " threw: " + e.message);
      markWorkflowFailed(db, flow, e.message, Date.now() as number);
    }
    walked = walked + 1;
  }
  if (walked > 0) { console.log("scheduler: walked " + `${walked}` + " workflows"); }

  // The other thing a minute is good for. A crawled body is readable in the
  // sense that the words are there; a model turns it into an article once, and
  // this is where that call belongs — not on the read path, where the first
  // person to open a story waited fifty-three seconds for a page that already
  // had text on it.
  reflow(db, master);

  // And what arrived while nobody was asking — but not HERE. A triggered
  // walk is minutes of model time, and this pass ran them inline until one
  // proved both failure modes in an afternoon: a slow walk held the pass
  // (and systemd's no-second-instance rule held every tick behind it), and a
  // crashing walk took the pass down with every unclaimed message behind it.
  // So the pass now only counts the queue and launches runners — each one
  // this same binary in child mode, claiming through the same SKIP LOCKED
  // door, walking until the queue is dry, and exiting. A process that exits
  // also cannot leak, which is this file's founding rule; a child holds the
  // transcripts of the walks it ran and gives them back to the OS minutes
  // later instead of never.
  let waiting = queuedMessages(db);
  if (waiting > 0) {
    let runners = waiting < TRIGGER_RUNNERS ? waiting : TRIGGER_RUNNERS;
    let r: int = 0;
    while (r < runners) {
      // setsid, not nohup: the runtime reaps the process GROUP when this
      // pass exits, and nohup only shields a child from SIGHUP — twenty-five
      // launches produced a created-then-empty log and not one surviving
      // runner. setsid gives the child its own session, out of the group the
      // reaper kills. Through a shell, because what this needs is a DETACHED
      // child, and spawnSync returns as soon as the shell has backgrounded it.
      child_process.spawnSync("bash", ["-c",
        "SCHEDULER_CHILD=triggers setsid " + ownBinary() + " >> .lumen-scheduler-runner.log 2>&1 < /dev/null &"]);
      r = r + 1;
    }
    console.log("scheduler: launched " + `${runners}` + " runner(s) for " + `${waiting}` + " queued message(s)");
  }
}

// Where this binary lives, for launching itself. The unit's WorkingDirectory
// is this package, so the relative default holds for systemd and for a shell
// started here; anything else names it.
function ownBinary(): string {
  return process.env("AGENTS_SCHEDULER_BIN") ?? "./scheduler";
}

function queuedMessages(db: Db): int {
  if (!db.query("SELECT count(*) FROM trigger_inbox WHERE status = 'queued'", [])) { return 0; }
  if (db.rows() == 0) { return 0; }
  return parseInt(db.value(0, 0), 10) ?? 0;
}

/** A walk stopped mid-question: keep what the resume needs, keyed to the
 *  chat, with an expiry — the one rule that makes "yes" safe. */
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
  // Until dry, not a fixed few: this runs in a child whose whole job is the
  // queue, and the concurrency bound is how many children the pass launches.
  while (answered < 50) {
    let msg = claimMessage(db, Date.now() as number);
    if (msg.id == "") { break; }
    try { answer(db, msg, master); }
    catch (e) {
      console.error("scheduler: trigger message " + msg.id + " threw: " + e.message);
      finishMessage(db, msg, "failed", "", "", e.message, Date.now() as number);
    }
    answered = answered + 1;
  }
  if (answered > 0) { console.log("scheduler: answered " + `${answered}` + " triggered messages"); }
}

// One inbound message: run its bot's workflow with the message as the input,
// and leave the answer on the row. Sending it back is the poller's job, not
// this one's — the poller is the process that holds the token, and a token
// read in two places is a token to rotate in two places.
function answer(db: Db, msg: TriggerInboxRow, master: string): void {
  let doc = findById(db, workflowsMapping(), msg.workflowId);
  if (doc == "") {
    finishMessage(db, msg, "failed", "", "", "no workflow " + msg.workflowId, Date.now() as number);
    return;
  }
  let flow: WorkflowRow = JSON.parse<WorkflowRow>(doc);

  // An open question outranks a fresh start: if this chat was asked
  // something and answered within the question's lifetime, this message IS
  // the answer, and the suspended walk continues from the asking node with
  // it as {{prev}}. Expired questions fall through — "yes" must never fire
  // an action proposed yesterday.
  let open = pendingFor(db, msg.botId, msg.chatId, Date.now() as number);
  if (open.id != "") {
    forgetAsk(db, open.id);
    let stepsSoFar = "[]";
    let runDoc = findById(db, workflowRunsMapping(), open.runId);
    // jsonText, not jsonRaw: `steps` is a STRING column holding JSON, so the
    // raw scanner answers it still wearing its quotes and the typed parse
    // refuses. The ok/update_id lesson from the other direction.
    if (runDoc != "") { stepsSoFar = jsonText(runDoc, "steps"); }
    let held: ResumeAsk = {
      runId: open.runId, threadId: open.threadId, graph: open.graph,
      nodeId: open.nodeId, input: open.input, outputs: open.outputs,
      stepsSoFar: stepsSoFar == "" ? "[]" : stepsSoFar,
      startedAt: jsonText(runDoc, "startedAt"),
      reply: msg.input, master: master, nowMs: Date.now() as number,
      botId: msg.botId, chatId: msg.chatId,
    };
    let resumed = resumeWorkflow(db, flow, held);
    if (resumed.threadId != "") { noteThread(db, msg.id, resumed.threadId); }
    if ((resumed.waitingAt ?? "") != "") {
      // A second question in the same walk: the NEXT resume must keep
      // walking the bytes this one walked, not whatever the draft has
      // become since the first suspension.
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

  // A message walks the PUBLISHED graph — except inside the bot's test
  // window, when the person editing pointed their own bot at the draft on
  // purpose, loudly, and for a bounded time. The window is a timestamp
  // compared here at claim, so it cannot be left on: it just passes.
  let bot = botById(db, msg.botId);
  let onDraft = testingDraft(bot, Date.now() as number);
  let bytes = onDraft ? flow.graph
    : (flow.publishedGraph ?? "") == "" ? flow.graph : (flow.publishedGraph ?? "");
  flow = withGraph(flow, bytes);
  let ask: WorkflowAsk = {
    // The message IS the input — the same `{{input}}` a step reads when
    // somebody runs the graph by hand, which is what makes a workflow built
    // and tested in the console work unchanged behind a bot.
    owner: msg.owner, input: msg.input, master: master,
    nowMs: Date.now() as number,
    // And the conversation that chat is already having, so the second
    // message can say "and tomorrow?" and mean it. A run started by the
    // clock passes nothing here and gets a fresh conversation, which is
    // right: nobody is talking to it.
    threadId: threadForChat(db, msg.botId, msg.chatId),
    // And where a TELEGRAM_REPLY step speaks to, mid-walk.
    botId: msg.botId, chatId: msg.chatId,
  };
  let done = runWorkflow(db, flow, ask);
  // Before the outcome is judged: a walk that opened a conversation and then
  // failed still opened one, and the next message should continue it rather
  // than start a third.
  if (done.threadId != "") { noteThread(db, msg.id, done.threadId); }
  if ((done.waitingAt ?? "") != "") {
    // Stopped to ask. The question already left through the outbox; what
    // remains is remembering enough to continue when the answer comes.
    rememberOpenQuestion(db, msg, flow, done);
    finishMessage(db, msg, "done", done.runId, "", "", Date.now() as number);
    return;
  }
  if (!done.ok) {
    finishMessage(db, msg, "failed", done.runId, "", done.error, Date.now() as number);
    return;
  }
  // 'done' is the END of this row's life now, not "waiting to be sent".
  // Everything that reaches the chat went through a TELEGRAM_REPLY step and
  // the outbox — the graph SAYS where it speaks, and END only records. The
  // answer is kept on the row for the console's queue view, and the poller
  // no longer reads this table to send.
  finishMessage(db, msg, "done", done.runId, plainly(done.answer), "", Date.now() as number);
}

// Up to REFLOW_PER_PASS stories, made readable. Per story try, so one that
// fails costs one story; and no failure is recorded on the row, because there
// is nothing to record — `readable` answers "" and the story keeps showing the
// body it already had.
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
  if (done > 0) { console.log("scheduler: made " + `${done}` + " stories readable"); }
}

// One workflow: the walk records its own run row and files its conversation
// (workflow-run.ts); this only decides what the outcome means for the row's
// schedule and failure count.
function fireWorkflow(db: Db, flow: WorkflowRow, master: string): void {
  let ask: WorkflowAsk = {
    owner: flow.owner, input: "", master: master,
    nowMs: Date.now() as number,
  };
  // Which graph: the clock is production, so a scheduled firing walks what
  // was PUBLISHED. "Run soon" arrives through this same claim but only ever
  // on a manual workflow — run-now is the one write that makes one due — and
  // a person pressing the button is looking at the draft, so the draft is
  // what runs. The n8n split, decided by kind rather than by a flag that
  // could disagree with it.
  let bytes = flow.kind == "manual" ? flow.graph
    : (flow.publishedGraph ?? "") == "" ? flow.graph : (flow.publishedGraph ?? "");
  let done = runWorkflow(db, withGraph(flow, bytes), ask);
  if (!done.ok) {
    markWorkflowFailed(db, flow, done.error, Date.now() as number);
    return;
  }
  markWorkflowRan(db, flow, done.runId, Date.now() as number);
}

// One task: open a conversation, ask it, record what happened.
function fire(db: Db, task: TaskRow, master: string): void {
  let now = Date.now() as number;
  let threadId = openThread(db, { agentId: task.agentId, owner: task.owner, now: `${now}` });
  if (threadId == "") {
    markFailed(db, task, "the conversation could not be opened", now);
    return;
  }

  // The picker's memory does not apply: a task said which model it wanted when
  // it was created, and nothing since has been a message that could change it.
  // `inheritedPick` is the honest description of that — this send states
  // nothing, so the thread's own model stands.
  let ask: ThreadAsk = {
    userText: task.instruction,
    master: master,
    tracer: tracerFor(db, master),
    pick: inheritedPick(),
    think: false,
  };
  let answered = runInThreadWith(db, threadId, ask);

  // Filed the same way a person's turn is filed, and before the outcome is
  // judged: a run that failed is still a run somebody needs to be able to read,
  // and `last_run_id` pointing at nothing is the worst of both.
  let runId = recordRun(db, {
    agentId: task.agentId, threadId: threadId, owner: task.owner,
    question: task.instruction,
    // The run as it came back. The engine decorates a person's run with the
    // routing notes before filing it (`withNotes`, api.ts) and that helper is
    // private to the engine; the same information is on the row's routeNote,
    // so nothing is lost that anyone reads.
    run: answered.run,
    modelChoiceId: answered.modelChoiceId, routeNote: answered.routeNote,
  });

  if (!answered.run.ok) {
    // The thread stays. A failed run is a conversation with the question in it
    // and no answer, which is what somebody needs to see to fix the task —
    // deleting it would leave only a counter that went up.
    markFailed(db, task, answered.run.error, Date.now() as number);
    return;
  }
  markRan(db, task, runId, Date.now() as number);
}

main();

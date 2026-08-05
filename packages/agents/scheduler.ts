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
import { connectDatabase, persist } from "../plume/plume.ts";
import { masterKey } from "./credentials.ts";
import { claimDue, markFailed, markRan, TaskRow } from "./tasks.ts";
import { openThread, runInThreadWith, inheritedPick, ThreadAsk } from "./threads.ts";
import { tracerFor } from "./trace.ts";
import { discoverModelId, discoverStoriesMapping, readable, unreadableStories, withReadableBody } from "./discover.ts";
import { recordRun } from "./runlog.ts";

// How many tasks one pass will fire before leaving the rest to the next tick.
// A bound rather than "drain it": a pass that runs forty agent turns holds the
// unit active for an hour, and every tick in that hour is silently dropped.
const PER_PASS: int = 5;

function main(): void {
  let master = masterKey();
  if (master == "") {
    console.error("LUMEN_MASTER_KEY is not set — the scheduler cannot read provider credentials");
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

  // The other thing a minute is good for. A crawled body is readable in the
  // sense that the words are there; a model turns it into an article once, and
  // this is where that call belongs — not on the read path, where the first
  // person to open a story waited fifty-three seconds for a page that already
  // had text on it.
  reflow(db, master);
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

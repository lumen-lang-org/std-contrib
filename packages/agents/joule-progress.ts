import { Db } from "../plume/driver.ts";
import { jsonStringMemberAt } from "../ai/core/jsonscan.ts";
import { EnvRow, envMarkAgent, envMarkSynced, envServing } from "./environments.ts";
import { envSyncClock, envSyncOut } from "./env-sync.ts";
import { JOULE_ENV_NAME, JouleFrame, jouleFrameBool, jouleIsTaskTurn, jouleTail } from "./joule-bridge.ts";
import { StepClose, StepStart, beginStep, endStepAt, latestRound, recordPartial, stepsOfRound } from "./steps.ts";

// What the delegate is doing, while it is doing it, in the conversation that
// asked for it.
//
// joule-bridge.ts reads a byte range of broadcast.log and hands back frames.
// joule-task.ts turns a tool call into a turn and waits for it. Neither puts
// anything in the thread: until this file, a delegated turn was three minutes
// of nothing followed by a paragraph, and the files arrived whenever the
// workspace timer next came round.
//
// The frames become the engine's OWN step rows — beginStep, endStepAt,
// recordPartial — and not a second progress surface. The thread already draws
// whatever stepsOfRound returns, so a delegated `edit` renders exactly like an
// engine `edit_artifact`, live, with no change to the UI, the view, or the
// route that serves it. Inventing a parallel table would have meant a second
// renderer for the same fact.
//
// Three things about this loop are not obvious and all three are load-bearing.
//
// It runs in the worker that already runs sweepWorkspaces, and it must. Both
// harvest, and envServing's comment is explicit that the sweep's correctness
// rests on one reader per row: a stamp taken, a find run, a stamp written. Two
// loops would let one pass move the stamp the other is comparing against.
// Here they are two calls in one loop body and cannot overlap.
//
// It never touches lastUsedAt. The plan asked for that, and slice 4 answered
// the same question the other way: envIdle steps over any row with a live
// agentConn, so a turn that runs past ENV_IDLE_MS is already safe. Touching
// lastUsedAt as well would be a second mechanism for one problem, and the one
// that is there is the honest one — it asks whether anything is running rather
// than whether anybody has been by lately.
//
// Its state is in this process and not in the database. A watch is which turn
// is open, which round its steps belong to and which calls have not reported
// yet, and all of it is meaningless the moment the engine restarts, because
// the daemon truncates broadcast.log whenever the container is rebuilt and the
// cursor goes back to zero with it. What survives a restart is the cursor,
// which is on the row; what is lost is at most one turn's steps, and the files
// still come back on the next sweep.

/** How often a delegated environment's log is read.
 *
 *  Open question 3 of the plan, answered as a poll rather than as a tail
 *  process, and this is the cost of that answer: one `docker exec` per live
 *  delegated environment per tick, plus the one joule-task's own follow is
 *  already making at the same cadence while a tool call is waiting. Two execs
 *  every two seconds for a conversation that is delegating, and none at all
 *  for one that is not — the tick still asks the database which environments
 *  have a daemon in them, which is one indexed read of a table bounded by
 *  ENV_LIVE_MAX whether anything is delegating or not.
 *
 *  A tail process would cost less than that and is the obvious alternative:
 *  `docker exec` a `tail -f` per environment and read its output. It was not
 *  taken because this runtime has one process primitive and it is
 *  child_process.spawnSync — env-sync, run-script and environments all reach
 *  for the same one — so a streaming child would be a new capability, and with
 *  it a second lifecycle to get right: reaped when the container stops, when
 *  the engine restarts, when the child dies on its own, and a second cursor
 *  over whatever it wrote on the host. That is more moving parts than the
 *  execs it saves.
 *
 *  Two seconds because it is joule-task's own poll interval, so this adds no
 *  new order of magnitude to what a delegated turn already costs, and because
 *  a step row that appears two seconds after the call it describes reads as
 *  live. What would change the decision: a text.delta stream that has to look
 *  like typing rather than like progress, or a deployment where the number of
 *  simultaneously delegating environments is routinely past JOULE_PROGRESS_MAX
 *  and the share below stretches the worst case past a few seconds. Either one
 *  makes a tail process worth its lifecycle; neither is true today. */
export const JOULE_PROGRESS_MS: int = 2000;

/** How many environments one tick reads.
 *
 *  A ceiling on docker work per unit time, in the spirit of run-script's
 *  SCRIPT_MAX_RUNNING: without one, ENV_LIVE_MAX is 200 and a tick could ask
 *  the host for two hundred execs at once. With it the loop costs at most four
 *  execs a second whatever the deployment is doing, and the price is latency
 *  rather than loss — an environment not read this tick is read on a later
 *  one, from the same cursor, having missed nothing. */
export const JOULE_PROGRESS_MAX: int = 8;

/** The depth a delegated step is written at.
 *
 *  A step's identity is (thread, round, depth, index), and run.ts owns depths
 *  0 to MAX_DEPTH — 3 — for the agent and the agents it delegates to. One past
 *  that is a depth run.ts cannot reach, so a delegated step can never land on
 *  the id of a step the engine is writing at the same moment. It is not a
 *  nesting level anybody renders; it is a namespace. */
export const JOULE_STEP_DEPTH: int = 4;

/** Where delegated step indices start.
 *
 *  Steps come back ordered by index, and the engine's own for a round are 0,
 *  1, 2. Starting far above them puts the delegate's work after the tool call
 *  that asked for it, which is where a reader looks for it. */
export const JOULE_STEP_IDX: int = 1000;

/** How much of a delegate's reply is held as the round's streaming text.
 *
 *  A preview and not a transcript: what lands here is replaced by the engine's
 *  own answer the moment the model starts speaking again, and a delegate that
 *  writes an essay should not put a megabyte in a row that is about to be
 *  overwritten. */
export const JOULE_PARTIAL_MAX: int = 8000;

// ---------------------------------------------------------------------------
// What is being watched
// ---------------------------------------------------------------------------

/** A tool call the delegate started and has not reported a result for.
 *
 *  Held because endStepAt needs the same StepStart beginStep was given — name,
 *  arguments and start time — and the result frame carries none of them, only
 *  the call id that ties the two together. */
export type JouleCall = {
  callId: string,
  idx: int,
  name: string,
  args: string,
  /** The stamp the step was opened with, which is what endStepAt writes back
   *  as startedAt. */
  at: string,
  /** The container's clock when the call frame was written. The duration of a
   *  delegated call is the difference between two of these and not between two
   *  host readings: both frames may arrive in one tail, and timing them from
   *  here would report every call as instant. A number rather than an int for
   *  the reason JouleFrame.at gives: an int is 32 bits and an epoch in
   *  milliseconds is not. */
  atMs: number,
};

export type JouleWatch = {
  envId: string,
  threadId: string,
  /** The foreground turn being followed, or "" between turns. */
  turnId: string,
  /** The round its steps belong to, pinned when the turn started rather than
   *  read again per frame: a turn can outlive the tool call that asked for it,
   *  and the round moves on when it does. Pinned, the steps stay with the
   *  message that asked for them. -1 when the thread had no round to attach
   *  to, which means the frames are followed but nothing is drawn. */
  seq: int,
  /** The next step index. Monotonic for the life of the watch, so a second
   *  delegated turn in one round does not write over the first one's steps. */
  idx: int,
  open: JouleCall[],
  said: string,
  approvals: int,
  /** Why the turn ended, set for exactly the tick that read the turn.end
   *  frame. The caller harvests on it and clears it. */
  ended: string,
  /** Which turn that was. Kept past the reset so the harvest can name it. */
  endedTurn: string,
};

export function jouleWatchNew(envId: string, threadId: string): JouleWatch {
  let none: JouleCall[] = [];
  let fresh: JouleWatch = {
    envId: envId, threadId: threadId, turnId: "", seq: -1, idx: JOULE_STEP_IDX,
    open: none, said: "", approvals: 0, ended: "", endedTurn: "",
  };
  return fresh;
}

/** The same watch with its end signal taken off, once it has been acted on. */
export function jouleWatchRested(w: JouleWatch): JouleWatch {
  let calm: JouleWatch = {
    envId: w.envId, threadId: w.threadId, turnId: w.turnId, seq: w.seq, idx: w.idx,
    open: w.open, said: w.said, approvals: w.approvals, ended: "", endedTurn: w.endedTurn,
  };
  return calm;
}

/** The watch for an environment, or a fresh one. */
export function jouleWatchOf(held: JouleWatch[], envId: string, threadId: string): JouleWatch {
  let i: int = 0;
  while (i < held.length) {
    if (held[i].envId == envId) {
      return held[i];
    }
    i = i + 1;
  }
  return jouleWatchNew(envId, threadId);
}

// ---------------------------------------------------------------------------
// Which environments a tick reads
// ---------------------------------------------------------------------------

/** Whether the environment at `at` is one this tick reads, given how far the
 *  last tick got and how many a tick may read.
 *
 *  A rotation and not a queue: the row order comes from envServing and changes
 *  as environments come and go, so this is fairness by construction rather
 *  than a promise about any particular row. What it does guarantee is the part
 *  that matters — the count per tick is capped, and every index is reached
 *  within ceil(count / max) ticks of any starting point. */
export function jouleChosen(count: int, from: int, max: int, at: int): bool {
  if (count <= 0 || max <= 0 || at < 0 || at >= count) {
    return false;
  }
  if (max >= count) {
    return true;
  }
  let start = ((from % count) + count) % count;
  return ((at - start + count) % count) < max;
}

/** Where the next tick starts reading. */
export function jouleNextFrom(count: int, from: int, max: int): int {
  if (count <= 0) {
    return 0;
  }
  let start = ((from % count) + count) % count;
  let took = max < count ? max : count;
  return (start + took) % count;
}

// ---------------------------------------------------------------------------
// Frames into steps
// ---------------------------------------------------------------------------

/** The first index a delegated step may take in a round, read back rather than
 *  counted from zero.
 *
 *  The counter lives in this process and the rows live in the database, and
 *  the two disagree after a restart: a fresh counter would write over the
 *  steps an earlier process left in the same round. Asking the round what it
 *  already holds costs one query per turn and makes that impossible. */
export function jouleNextIdx(db: Db, threadId: string, seq: int): int {
  if (threadId == "" || seq < 0) {
    return JOULE_STEP_IDX;
  }
  let held = stepsOfRound(db, threadId, seq);
  let best = JOULE_STEP_IDX - 1;
  let i: int = 0;
  while (i < held.length) {
    if (held[i].depth == JOULE_STEP_DEPTH && held[i].idx > best) {
      best = held[i].idx;
    }
    i = i + 1;
  }
  return best + 1;
}

/** What a step says when a delegated call asked for a decision.
 *
 *  It should never be written. The daemon is started with `--mode full-auto`
 *  and nothing asks in full-auto, so a step carrying this is not a report
 *  about the call — it is a report that the mode did not land, and the visible
 *  symptom of that is not an error but a turn that spends the gate's whole
 *  timeout on every command and then has it denied. */
export const JOULE_UNATTENDED: string = "this call asked for an approval, and nobody is"
  + " attached to answer one: the environment's daemon is not in full-auto";

/** How a delegated tool is named in the thread.
 *
 *  Qualified by the environment because the names collide: joule calls its
 *  file editor `edit` and the engine calls its own `edit_artifact`, but it
 *  also has `read`, `run` and `grep`, and an unqualified one of those in a
 *  step list reads as something the engine did itself. */
export function jouleStepName(tool: string): string {
  return JOULE_ENV_NAME + "/" + (tool == "" ? "?" : tool);
}

function jouleStepOf(threadId: string, seq: int, call: JouleCall): StepStart {
  let s: StepStart = {
    threadId: threadId, seq: seq, depth: JOULE_STEP_DEPTH, rotation: 0, idx: call.idx,
    kind: "tool", name: call.name, target: JOULE_ENV_NAME, args: call.args, now: call.at,
  };
  return s;
}

/** One step that begins and ends at once, for the frames that report something
 *  rather than start something. Returns the next free index. */
function jouleNoteStep(db: Db, threadId: string, seq: int, idx: int, name: string, message: string, ok: bool, now: string): int {
  if (threadId == "" || seq < 0) {
    return idx;
  }
  let none: number = 0.0;
  let one: JouleCall = { callId: "", idx: idx, name: name, args: "", at: now, atMs: none };
  let s = jouleStepOf(threadId, seq, one);
  beginStep(db, s);
  let close: StepClose = {
    ok: ok, endedAt: now, millis: 0, line: 0, changed: "", result: message,
  };
  endStepAt(db, s, close);
  return idx + 1;
}

/** How long a delegated call took, in milliseconds, or -1 for not known.
 *
 *  The container's clock at both ends. Both frames of a call can arrive in one
 *  tail — the log is read every couple of seconds and a call that answers
 *  quickly is over before the next read — so two readings of this host's clock
 *  would report every delegated call as instant.
 *
 *  Narrowed through a string because the two stamps are numbers and a step's
 *  duration is an int, and unknown rather than wrong when that narrowing does
 *  not fit: a stamp this could not read is 0, and 0 subtracted from an epoch
 *  is not a duration. */
export function jouleTook(from: number, to: number): int {
  let none: number = 0.0;
  if (from <= none || to < from) {
    return -1;
  }
  return parseInt(`${to - from}`, 10) ?? -1;
}

function jouleCut(text: string): string {
  return text.length <= JOULE_PARTIAL_MAX ? text : text.slice(0, JOULE_PARTIAL_MAX);
}

/** The frames of one tail, written into the thread as the engine's own step
 *  rows, and the watch that follows from them.
 *
 *  Field by field off each frame rather than by decoding it, for the reason
 *  joule-bridge gives: the frame set has 28 shapes and grows, and an exact
 *  JSON.parse is a reader that stops working the day one of them gains a
 *  field.
 *
 *  The frames of a background run or a subagent are dropped before anything
 *  else looks at them. They share this log with `bg:` and `agent:` prefixed
 *  turn ids and interleave freely with the foreground turn, and one of their
 *  turn.end frames read as the turn's end is a harvest fired while the
 *  delegate is still writing files. */
export function jouleApply(db: Db, watch: JouleWatch, frames: JouleFrame[], now: string): JouleWatch {
  let threadId = watch.threadId;
  let turnId = watch.turnId;
  let seq = watch.seq;
  let idx = watch.idx;
  let open = watch.open;
  let said = watch.said;
  let approvals = watch.approvals;
  let ended = "";
  let endedTurn = watch.endedTurn;
  let saidMoved = false;
  let i: int = 0;
  while (i < frames.length) {
    let f = frames[i];
    i = i + 1;
    if (jouleIsTaskTurn(f.turnId)) {
      continue;
    }
    if (f.type == "error" || f.type == "notice") {
      // Neither carries a turn id — an error frame is the daemon's, not a
      // turn's — so the only honest scope for one is the window it arrived
      // in, which is the turn this watch has open.
      let why = jsonStringMemberAt(f.json, 0, "message");
      let code = jsonStringMemberAt(f.json, 0, "code");
      let text = why == "" ? code : why;
      let warn = f.type == "error" || jsonStringMemberAt(f.json, 0, "level") == "warn";
      if (turnId == "" || seq < 0) {
        console.error("delegated " + f.type + " with no turn to attach it to: " + text);
        continue;
      }
      idx = jouleNoteStep(db, threadId, seq, idx, jouleStepName(f.type), text, !warn, now);
      continue;
    }
    if (f.type == "turn.start") {
      if (turnId != "") {
        // Input queues behind a turn in flight rather than interleaving, so
        // two open foreground turns is not a thing the daemon does. Said
        // rather than assumed away.
        console.error("delegated turn " + f.turnId + " started while " + turnId
          + " is still open, and its steps are not being drawn");
        continue;
      }
      turnId = f.turnId;
      seq = latestRound(db, threadId);
      idx = jouleNextIdx(db, threadId, seq);
      said = "";
      saidMoved = false;
      if (seq < 0) {
        console.error("delegated turn " + turnId + " belongs to " + threadId
          + ", which has no round to draw it in");
      }
      continue;
    }
    if (turnId == "" || f.turnId != turnId) {
      continue;
    }
    if (f.type == "tool.call") {
      if (seq < 0) {
        continue;
      }
      let call: JouleCall = {
        callId: jsonStringMemberAt(f.json, 0, "callId"),
        idx: idx,
        name: jouleStepName(jsonStringMemberAt(f.json, 0, "tool")),
        // A JSON string holding JSON, which jsonStringMemberAt unescapes back
        // into the object the delegate was called with.
        args: jsonStringMemberAt(f.json, 0, "args"),
        at: now,
        atMs: f.at,
      };
      beginStep(db, jouleStepOf(threadId, seq, call));
      open.push(call);
      idx = idx + 1;
    } else if (f.type == "tool.result") {
      let callId = jsonStringMemberAt(f.json, 0, "callId");
      let rest: JouleCall[] = [];
      let found = false;
      let k: int = 0;
      while (k < open.length) {
        let one = open[k];
        k = k + 1;
        if (found || one.callId != callId) {
          rest.push(one);
          continue;
        }
        found = true;
        let close: StepClose = {
          ok: jouleFrameBool(f.json, "ok"),
          endedAt: now,
          millis: jouleTook(one.atMs, f.at),
          line: 0,
          changed: "",
          result: jsonStringMemberAt(f.json, 0, "output"),
        };
        endStepAt(db, jouleStepOf(threadId, seq, one), close);
      }
      open = rest;
      if (!found) {
        console.error("delegated call " + callId + " reported a result for a call that"
          + " was never seen starting, so nothing in the thread is closed by it");
      }
    } else if (f.type == "text.delta") {
      said = jouleCut(said + jsonStringMemberAt(f.json, 0, "text"));
      saidMoved = true;
    } else if (f.type == "approval.request") {
      // Counted here and shouted about by the loop. The daemon is started with
      // --mode full-auto and in full-auto nothing asks, so one of these means
      // the flag did not land — but the count is a fact about the turn and the
      // shout is a fact about a container, and only the loop knows which one.
      approvals = approvals + 1;
      idx = jouleNoteStep(db, threadId, seq, idx,
        jouleStepName(jsonStringMemberAt(f.json, 0, "tool")), JOULE_UNATTENDED, false, now);
    } else if (f.type == "turn.end") {
      ended = jsonStringMemberAt(f.json, 0, "reason");
      if (ended == "") {
        ended = "done";
      }
      endedTurn = turnId;
      let k: int = 0;
      while (k < open.length) {
        let one = open[k];
        k = k + 1;
        let close: StepClose = {
          ok: false, endedAt: now, millis: -1, line: 0, changed: "",
          result: "the turn ended before this call reported a result",
        };
        endStepAt(db, jouleStepOf(threadId, seq, one), close);
      }
      let none: JouleCall[] = [];
      open = none;
      if (saidMoved && seq >= 0) {
        recordPartial(db, threadId, seq, said, now);
      }
      said = "";
      saidMoved = false;
      turnId = "";
    }
  }
  if (saidMoved && seq >= 0) {
    // Once per tail rather than once per delta: a turn's text arrives in
    // hundreds of frames and each one would be a write of the whole answer so
    // far into a row that holds exactly one of them.
    recordPartial(db, threadId, seq, said, now);
  }
  let after: JouleWatch = {
    envId: watch.envId, threadId: threadId, turnId: turnId, seq: seq, idx: idx,
    open: open, said: said, approvals: approvals, ended: ended, endedTurn: endedTurn,
  };
  return after;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** The same row with its cursor moved.
 *
 *  Built rather than assigned into, because a record here is immutable, and
 *  built at all because the two writers that follow each carry the whole row:
 *  envMarkAgent would put the old sync stamp back, and envMarkSynced would put
 *  the old cursor back. One row with both new values, saved once, is the only
 *  arrangement where neither undoes the other. */
export function jouleMoved(row: EnvRow, read: int): EnvRow {
  let moved: EnvRow = {
    id: row.id, threadId: row.threadId, name: row.name, image: row.image,
    network: row.network, status: row.status, slug: row.slug, hostPort: row.hostPort,
    servePort: row.servePort, serveCmd: row.serveCmd, syncAt: row.syncAt,
    agentConn: row.agentConn, agentRead: read,
    createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
  };
  return moved;
}

/** Everything the delegate wrote, brought back because its turn ended.
 *
 *  The same three calls sweepWorkspaces makes and in the same order, which is
 *  the whole point: the stamp is taken from the container's clock BEFORE the
 *  find and written AFTER it, so a file written while this runs is newer than
 *  the stamp and is caught by the next pass rather than missed by both. The
 *  timer stays as that next pass; this only means a delegated turn's files are
 *  in the thread when the turn is, rather than up to a sweep later. */
function jouleHarvest(db: Db, row: EnvRow, w: JouleWatch, now: string): void {
  let stamp = envSyncClock(row);
  if (stamp == "") {
    console.error("delegated harvest: " + row.threadId + ":" + row.name + " — its clock did"
      + " not answer, so its files wait for the sweep");
    let missed = envMarkAgent(db, row, row.agentConn, row.agentRead);
    if (missed != "") {
      console.error("delegated progress: " + row.id + " — its cursor was not written, so"
        + " these frames will be read again: " + missed);
    }
    return;
  }
  let carried = envSyncOut(db, row, row.syncAt, now);
  // Carries the cursor with it: envMarkSynced writes the whole row, and the
  // row it is given is the one jouleMoved built.
  let marked = envMarkSynced(db, row, stamp);
  if (marked != "") {
    console.error("delegated harvest: " + row.id + " — the sync mark was not written, so"
      + " the next sweep reads these files back again: " + marked);
  }
  console.log("brought " + `${carried.changed.length}` + " file(s) back from "
    + row.threadId + ":" + row.name + " on turn.end of " + w.endedTurn + " (" + w.ended + ")");
}

function joulePoll(db: Db, row: EnvRow, watch: JouleWatch, now: string): JouleWatch {
  let tailed = jouleTail(row, row.agentRead);
  if (!tailed.ok) {
    console.error("delegated progress: " + row.id + " — " + tailed.fault);
    return watch;
  }
  if (tailed.frames.length == 0 && tailed.read <= row.agentRead) {
    return watch;
  }
  // The steps are written before the cursor moves. Crashing between the two
  // means the frames are read again and their steps written again, which is a
  // duplicate row; crashing the other way round means they are never read at
  // all, which is a turn that leaves no trace.
  let after = jouleApply(db, watch, tailed.frames, now);
  if (after.approvals > watch.approvals) {
    // Loud on purpose, and here rather than in the translation because this is
    // a fact about a container and not about a turn: the daemon in this one
    // did not come up in full-auto, and every gated call it makes from now on
    // burns the gate's timeout before being denied.
    console.error("delegated environment " + row.id + " asked for "
      + `${after.approvals - watch.approvals}` + " approval(s), which cannot happen in"
      + " full-auto: its daemon did not take the mode, and its turns will stall rather"
      + " than fail");
  }
  let moved = jouleMoved(row, tailed.read);
  if (after.ended == "") {
    let marked = envMarkAgent(db, moved, moved.agentConn, moved.agentRead);
    if (marked != "") {
      console.error("delegated progress: " + row.id + " — its cursor was not written, so"
        + " these frames will be read again: " + marked);
    }
    return after;
  }
  jouleHarvest(db, moved, after, now);
  return jouleWatchRested(after);
}

/** The watches this process is holding, one per environment with a daemon in
 *  it. A record is immutable and an array cannot be assigned into, so a tick
 *  builds the whole list again rather than editing it. */
let jouleWatches: JouleWatch[] = [];

/** Where the next tick starts its share. */
let jouleFrom: int = 0;

/** One pass over the environments with a daemon in them. Returns how many were
 *  read.
 *
 *  Called from the worker that runs sweepWorkspaces, and only from there. Two
 *  callers would be two readers of one row's sync stamp, which is the race
 *  envServing's own comment describes. */
export function jouleProgress(db: Db, now: string): int {
  let serving = envServing(db);
  let live: EnvRow[] = [];
  let i: int = 0;
  while (i < serving.length) {
    if (serving[i].agentConn != "") {
      live.push(serving[i]);
    }
    i = i + 1;
  }
  if (live.length == 0) {
    let none: JouleWatch[] = [];
    jouleWatches = none;
    jouleFrom = 0;
    return 0;
  }
  let kept: JouleWatch[] = [];
  let read: int = 0;
  let j: int = 0;
  while (j < live.length) {
    let row = live[j];
    let mine = jouleWatchOf(jouleWatches, row.id, row.threadId);
    if (jouleChosen(live.length, jouleFrom, JOULE_PROGRESS_MAX, j)) {
      mine = joulePoll(db, row, mine, now);
      read = read + 1;
    }
    kept.push(mine);
    j = j + 1;
  }
  // Watches for environments that are no longer live are dropped by not being
  // carried: the next daemon in that container truncates its log and starts
  // its turn ids again from t1, so nothing about the old one is worth keeping.
  jouleWatches = kept;
  jouleFrom = jouleNextFrom(live.length, jouleFrom, JOULE_PROGRESS_MAX);
  return read;
}

/** For a test that needs the loop to have forgotten what it saw. */
export function jouleProgressForget(): void {
  let none: JouleWatch[] = [];
  jouleWatches = none;
  jouleFrom = 0;
}

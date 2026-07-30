// What a run is doing right now, readable while it is still doing it.
//
// A round can take a minute: the model thinks, a tool runs, a sub-agent runs a
// whole conversation of its own. `POST /threads/:id/messages` answers once, at
// the end, so until now the console could show a spinner and nothing else —
// not which tool, not how many, not how long.
//
// The run loop writes a row here when it dispatches a call and updates it when
// the call returns. A second request reads those rows while the first is still
// running, which works because the language's HTTP server runs handlers on a
// real thread pool (`lumen_runtime_net.zig`, an `xev.ThreadPool` sized to the
// CPU count) rather than one at a time. That was checked before this file was
// written; without it none of this would be visible until the run ended.
//
// `endedAt == ""` is the whole liveness signal. A row with one is finished and
// draws a check and a duration; a row without one is what draws a spinner. The
// writer never has to hold a clock across a call that might throw.
//
//   cd packages/agents && lumen test steps.test.ts

import { Db } from "../plume/driver.ts";
import { jsonFind, jsonText } from "./scan.ts";
import { DbField, DbRepository, DbOrder, field, repository, persist, listOrdered, deleteWhere, dialectType, placeholderAt } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

// One dispatched call, before and after it returns.
//
// The id is derived rather than random — thread, round, position — so the row
// that starts a call and the row that ends it are the same row, and `persist`
// (an upsert) closes it without a second lookup.
export type LiveStep = {
  id: string,
  threadId: string,
  // The round this belongs to, so a step is attached to one message rather
  // than to a thread at large.
  seq: int,
  // How far down the delegation this call was made. 0 is the agent the person
  // is talking to; 1 is a sub-agent it asked; and so on.
  //
  // Part of the row's identity, not decoration. A child runs in the parent's
  // thread and under the parent's round — that is what lets its writes join the
  // same message — and its own step counter starts at zero, so without the
  // depth its first call has the same id as the parent's first call and
  // silently overwrites the delegation that caused it.
  depth: int,
  // Which rotation of the model loop dispatched it. One message is not one
  // exchange with the model: it calls tools, reads the results, and may call
  // more before it answers. Every rotation has its own set of calls, and
  // flattening them into one list says the model asked for all of them at once
  // — which is exactly what it did not do.
  rotation: int,
  idx: int,
  // "tool" for anything dispatched by name, "agent" for a delegation. The
  // console draws them differently: a delegation says which agent is thinking.
  kind: string,
  name: string,
  // Which MCP server answered, or the child agent's id. Empty for a call the
  // run loop served itself.
  target: string,
  // A preview, capped. An argument list can be an entire file, and this row is
  // read on a timer.
  args: string,
  startedAt: string,
  endedAt: string,
  // How long the call took, set when it closes; -1 while it runs. Stored
  // rather than derived: a millisecond stamp is thirteen digits and `parseInt`
  // answers an i32, so subtracting two of them silently produced -1 for every
  // call that had in fact finished.
  millis: int,
  ok: bool,
};

// How much of an argument list is worth showing. Enough to tell two calls to
// the same tool apart, short enough that a poll stays cheap.
export const ARGS_PREVIEW = 120;

export function stepsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("threadId", "thread_id", "text"),
    field("seq", "seq", "int"),
    field("depth", "depth", "int"),
    field("rotation", "rotation", "int"),
    field("idx", "idx", "int"),
    field("kind", "kind", "text"),
    field("name", "name", "text"),
    field("target", "target", "text"),
    field("args", "args", "text"),
    field("startedAt", "started_at", "text"),
    field("endedAt", "ended_at", "text"),
    field("millis", "millis", "int"),
    field("ok", "ok", "bool"),
  ];
  return repository("thread_steps", "id", "id", fs);
}

// The DDL is written out rather than generated from the mapping above.
//
// A migration's recorded SQL must stay byte-identical forever — it is
// checksummed — and a statement built from a live mapping is rewritten the day
// someone adds a field to it, at which point every deployed database refuses
// the whole plan while a fresh one migrates happily. Migrations 24 and 25 in
// threads.ts already write their DDL out for the same reason.
export function stepPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("55", "thread steps",
      "CREATE TABLE IF NOT EXISTS thread_steps ("
      + "id " + db.textType + " PRIMARY KEY, "
      + "thread_id " + db.textType + " NOT NULL, "
      + "seq INTEGER NOT NULL, "
      + "idx INTEGER NOT NULL, "
      + "kind " + db.textType + " NOT NULL, "
      + "name " + db.textType + " NOT NULL, "
      + "target " + db.textType + " NOT NULL, "
      + "args " + db.textType + " NOT NULL, "
      + "started_at " + db.textType + " NOT NULL, "
      + "ended_at " + db.textType + " NOT NULL, "
      + "ok " + dialectType(db, "bool") + " NOT NULL)"),
    // Added after 55 shipped, so an ALTER rather than a wider CREATE: the
    // recorded text of a migration is checksummed and may never change.
    migration("57", "steps carry their rotation",
      "ALTER TABLE thread_steps ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0"),
    migration("58", "steps carry their own duration",
      "ALTER TABLE thread_steps ADD COLUMN millis INTEGER NOT NULL DEFAULT -1"),
    migration("59", "what the model was thinking",
      "CREATE TABLE IF NOT EXISTS thread_thoughts ("
      + "id " + db.textType + " PRIMARY KEY, "
      + "thread_id " + db.textType + " NOT NULL, "
      + "seq INTEGER NOT NULL, "
      + "rotation INTEGER NOT NULL, "
      + "text " + db.textType + " NOT NULL, "
      + "created_at " + db.textType + " NOT NULL)"),
    migration("60", "thoughts by round",
      "CREATE INDEX IF NOT EXISTS thoughts_by_round ON thread_thoughts (thread_id, seq, rotation)"),
    migration("62", "a step knows how deep it was made",
      "ALTER TABLE thread_steps ADD COLUMN depth INTEGER NOT NULL DEFAULT 0"),
    migration("63", "a thought knows whose it is",
      "ALTER TABLE thread_thoughts ADD COLUMN depth INTEGER NOT NULL DEFAULT 0"),
    migration("56", "steps by round",
      "CREATE INDEX IF NOT EXISTS steps_by_round ON thread_steps (thread_id, seq, idx)"),
  ];
  return plan;
}

// What the model said it was thinking, for one rotation of the loop.
//
// A separate table rather than a step of its own kind: a rotation can think and
// call nothing, and a step's `args` is capped at a preview because it is read on
// a timer — thinking is prose and is read once.
export type Thought = {
  id: string,
  threadId: string,
  seq: int,
  // Whose thinking it is: 0 the agent being talked to, 1 a sub-agent it asked.
  // Part of the id for the same reason the steps' depth is — a child thinks
  // under the parent's round and its own rotation count starts at zero, so
  // without this its reasoning replaced the parent's.
  depth: int,
  rotation: int,
  text: string,
  createdAt: string,
};

export function thoughtsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("threadId", "thread_id", "text"),
    field("seq", "seq", "int"),
    field("depth", "depth", "int"),
    field("rotation", "rotation", "int"),
    field("text", "text", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("thread_thoughts", "id", "id", fs);
}

// One row per rotation, so a rotation that thinks twice — a retry — replaces
// rather than duplicates.
export function recordThought(db: Db, threadId: string, seq: int, depth: int, rotation: int, text: string, now: string): void {
  if (threadId == "" || text == "") { return; }
  let row: Thought = {
    id: threadId + ":" + `${seq}` + ":d" + `${depth}` + ":r" + `${rotation}`,
    threadId: threadId, seq: seq, depth: depth, rotation: rotation, text: text, createdAt: now,
  };
  persist(db, thoughtsMapping(), JSON.stringify(row));
}

export function thoughtsOfRound(db: Db, threadId: string, seq: int): Thought[] {
  let keys: DbOrder[] = [{ column: "created_at" }, { column: "depth" }, { column: "rotation" }];
  let where = "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2);
  let args: string[] = [threadId, `${seq}`];
  return JSON.parse<Thought[]>(listOrdered(db, thoughtsMapping(), where, args, keys));
}

// Every round's reasoning at once, for a console that has just reloaded. The
// pairing with stepsOfThread is deliberate: a reload that got the calls back
// but not the thinking would redraw half a card, and the half it dropped is
// the half a round with no tool call is made entirely of.
export function thoughtsOfThread(db: Db, threadId: string): Thought[] {
  let keys: DbOrder[] = [{ column: "seq" }, { column: "created_at" }, { column: "depth" }, { column: "rotation" }];
  let args: string[] = [threadId];
  return JSON.parse<Thought[]>(
    listOrdered(db, thoughtsMapping(), "thread_id = " + placeholderAt(db, 1), args, keys));
}

export function forgetThoughts(db: Db, threadId: string, seq: int): void {
  let args: string[] = [threadId, `${seq}`];
  deleteWhere(db, thoughtsMapping(),
    "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2), args);
}

export function stepId(threadId: string, seq: int, depth: int, idx: int): string {
  return threadId + ":" + `${seq}` + ":d" + `${depth}` + ":" + `${idx}`;
}

// The preview, never longer than the cap and never cut through a character.
//
// A string here is UTF-8 bytes, so slicing at a fixed count can land inside a
// character and leave half of one at the end. That half is then handed to
// `JSON.stringify` and stored, and what comes back is a document with an
// invalid sequence in it — a tool argument in Arabic or Japanese, or one
// carrying an emoji, would poison the row that is meant to describe it. So the
// cut walks back off any continuation byte first.
export function argsPreview(args: string): string {
  if (args.length <= ARGS_PREVIEW) { return args; }
  let cut = ARGS_PREVIEW - 3;
  while (cut > 0 && continuationByte(args.charCodeAt(cut))) { cut = cut - 1; }
  return args.slice(0, cut) + "...";
}

// A byte that continues a character rather than starting one: 10xxxxxx.
function continuationByte(b: int): bool {
  return b >= 128 && b < 192;
}

// How much of `old` and `new` an edit step keeps for the card's detail view.
// Enough to read a change, small enough that a poll every few hundred
// milliseconds is not shipping documents around.
export const EDIT_KEEP: int = 1500;

function editCut(text: string): string {
  if (text.length <= EDIT_KEEP) { return text; }
  let cut = EDIT_KEEP;
  while (cut > 0 && continuationByte(text.charCodeAt(cut))) { cut = cut - 1; }
  return text.slice(0, cut);
}

function lineCount(text: string): int {
  if (text == "") { return 0; }
  let n: int = 1;
  let i: int = 0;
  while (i < text.length) {
    if (text.charAt(i) == "\n") { n = n + 1; }
    i = i + 1;
  }
  return n;
}

// What a step row stores as its `args`, by tool.
//
// Most tools store a cut prefix of their raw arguments — a label for a row,
// not the arguments back. An edit is different: the card shows "Edited <path>
// +a -r" and opens into the old and new text, so the row keeps those as
// fields, with the line counts computed from the WHOLE strings before any
// cut — a count made after cutting would report the preview, not the edit.
export function stepArgs(name: string, args: string): string {
  if (name != "edit_artifact") { return argsPreview(args); }
  if (jsonFind(args, "old") < 0 || jsonFind(args, "new") < 0) { return argsPreview(args); }
  let oldText = jsonText(args, "old");
  let newText = jsonText(args, "new");
  let keptOld = editCut(oldText);
  let keptNew = editCut(newText);
  return "{\"path\":" + JSON.stringify(jsonText(args, "path"))
    + ",\"removed\":" + `${lineCount(oldText)}`
    + ",\"added\":" + `${lineCount(newText)}`
    + ",\"old\":" + JSON.stringify(keptOld)
    + ",\"new\":" + JSON.stringify(keptNew)
    + ",\"cut\":" + (keptOld.length < oldText.length || keptNew.length < newText.length ? "true" : "false")
    + "}";
}

// What the caller knows when a call is dispatched. A record rather than six
// positional arguments, because four of them are strings and a transposition
// between `name` and `target` would be invisible.
export type StepStart = {
  threadId: string,
  seq: int,
  depth: int,
  rotation: int,
  idx: int,
  kind: string,
  name: string,
  target: string,
  args: string,
  now: string,
};

// Announce a call. Returns the row's id, which is what closes it.
//
// A failure to write is deliberately not fatal and not reported: this table is
// a view of a run, never the run itself, and a console that cannot show a
// spinner is a smaller problem than a request that fails because it could not.
export function beginStep(db: Db, s: StepStart): string {
  let id = stepId(s.threadId, s.seq, s.depth, s.idx);
  let row: LiveStep = {
    id: id, threadId: s.threadId, seq: s.seq, depth: s.depth, rotation: s.rotation, idx: s.idx,
    kind: s.kind, name: s.name, target: s.target, args: stepArgs(s.name, s.args),
    startedAt: s.now, endedAt: "", millis: -1, ok: false,
  };
  persist(db, stepsMapping(), JSON.stringify(row));
  return id;
}

// Close it. The row is rewritten whole, because `persist` is an upsert over
// every column and a partial document would write null over the rest.
export function endStep(db: Db, s: StepStart, ok: bool, endedAt: string, millis: int): void {
  let row: LiveStep = {
    id: stepId(s.threadId, s.seq, s.depth, s.idx), threadId: s.threadId, seq: s.seq,
    depth: s.depth, rotation: s.rotation, idx: s.idx,
    kind: s.kind, name: s.name, target: s.target, args: stepArgs(s.name, s.args),
    startedAt: s.now, endedAt: endedAt, millis: millis, ok: ok,
  };
  persist(db, stepsMapping(), JSON.stringify(row));
}

// How many rotations of the model loop this round took. What a card counts
// when it says a message took three exchanges to answer.
export function rotations(steps: LiveStep[]): int {
  let seen: int = 0;
  let i: int = 0;
  while (i < steps.length) {
    if (steps[i].rotation + 1 > seen) { seen = steps[i].rotation + 1; }
    i = i + 1;
  }
  return seen;
}

// The steps of one round, in the order they were dispatched.
export function stepsOfRound(db: Db, threadId: string, seq: int): LiveStep[] {
  let keys: DbOrder[] = [{ column: "idx" }];
  // placeholderAt, not db.placeholder: that field is the literal "$1" on
  // PostgreSQL, so naming it twice builds `thread_id = $1 AND seq = $1` and the
  // round is compared against the thread's id. SQLite's "?" is positional and
  // hides this completely — every test here passed while the real database
  // matched nothing.
  let where = "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2);
  let args: string[] = [threadId, `${seq}`];
  return JSON.parse<LiveStep[]>(listOrdered(db, stepsMapping(), where, args, keys));
}

// Whether anything in this round is still running, which is what decides
// between the two forms of the card the console draws.
export function roundRunning(steps: LiveStep[]): bool {
  let i: int = 0;
  while (i < steps.length) {
    if (steps[i].endedAt == "") { return true; }
    i = i + 1;
  }
  return false;
}

// How long a finished step took, in milliseconds; -1 while it runs. The
// subtraction is done here rather than stored, so a clock read once at each end
// is the only thing the writer has to be right about.
export function stepMillis(s: LiveStep): int {
  return s.millis;
}

// The round this thread is on, or has most recently been on: the one a console
// showing the newest message wants. -1 when the thread has never dispatched a
// call and never recorded a thought.
//
// Both tables, not just steps. A rotation thinks before it calls anything — that
// is the whole reason thinking is worth streaming — so for the first second or
// two of a round there are thoughts and no steps at all. Reading the round from
// steps alone answered -1 for exactly that window, and the console showed
// nothing until the first tool was dispatched.
export function latestRound(db: Db, threadId: string): int {
  let keys: DbOrder[] = [{ column: "seq", direction: "desc" }];
  let args: string[] = [threadId];
  let stepped = JSON.parse<LiveStep[]>(
    listOrdered(db, stepsMapping(), "thread_id = " + placeholderAt(db, 1), args, keys));
  let thought = JSON.parse<Thought[]>(
    listOrdered(db, thoughtsMapping(), "thread_id = " + placeholderAt(db, 1), args, keys));
  let best: int = -1;
  if (stepped.length > 0) { best = stepped[0].seq; }
  if (thought.length > 0 && thought[0].seq > best) { best = thought[0].seq; }
  return best;
}


// Clear a round before it starts.
//
// A round owns its seq. That has to be said out loud because a round that fails
// stores nothing, so the turn count does not advance and the next round runs
// under the same seq — and without this, the failed attempt's steps sit in the
// table beside the new attempt's, so a message shows tools that were dispatched
// for a question it never answered.
export function forgetRound(db: Db, threadId: string, seq: int): void {
  let args: string[] = [threadId, `${seq}`];
  deleteWhere(db, stepsMapping(),
    "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2), args);
}

// Every round this thread has steps for, oldest first. What a reloaded console
// draws a card from, one per message.
export function stepsOfThread(db: Db, threadId: string): LiveStep[] {
  let keys: DbOrder[] = [{ column: "seq" }, { column: "started_at" }, { column: "depth" }, { column: "idx" }];
  let args: string[] = [threadId];
  return JSON.parse<LiveStep[]>(
    listOrdered(db, stepsMapping(), "thread_id = " + placeholderAt(db, 1), args, keys));
}

// A thread's steps, dropped with the thread. Nothing here outlives the
// conversation it describes.
export function forgetSteps(db: Db, threadId: string): void {
  let args: string[] = [threadId];
  deleteWhere(db, stepsMapping(), "thread_id = " + placeholderAt(db, 1), args);
}

// A conversation that continues.
//
//   let id = openThread(db, "a1");
//   runInThread(db, id, "How many A-114 are in Lyon?", master);
//   runInThread(db, id, "And in Rotterdam?", master);      // remembers
//
// The whole context is replayed, not a summary of it: the model sees the tool
// calls it made, what they returned, and the passages it was given. It
// therefore does not re-ask a tool for something it already has, and "and in
// Rotterdam?" means what it says.
//
// The cost is that a thread grows, so it is trimmed — and trimming is the part
// with a sharp edge. A tool turn whose assistant turn has been dropped is a
// result answering nothing, which every provider refuses and Anthropic refuses
// most specifically: a tool_result must follow its tool_use. So whole rounds
// go, oldest first, never single turns.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, asc, desc, persist, findById, listOrdered, pageOrdered, executeWith, placeholderAt, createTableSql, execute, beginTransaction, commitTransaction, rollbackTransaction } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { Turn, ToolCall, toolCall, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { AgentRun, runAgentAt } from "./run.ts";
import { TURN_SEQ_NONE } from "./artifacts.ts";
import { extractFiles, neutraliseMarkers } from "./artifacts-fence.ts";
import { Tracer, noTracer } from "../tracing/tracing.ts";
import { jsonRaw, jsonList, jsonText } from "./scan.ts";

// A thread belongs to one agent. Moving a conversation to a different agent
// would replay tool calls naming tools the new agent may not have, so it is
// not offered.
export type ThreadRow = {
  id: string,
  agentId: string,
  createdAt: string,
};

// One turn of a thread's context, as stored.
//
// `calls` is the assistant's tool calls as JSON text. Kept whole rather than
// split into rows: the provider ids only have to agree within one request, and
// a turn is replayed as a unit or not at all.
export type ThreadTurnRow = {
  id: string,
  threadId: string,
  seq: int,
  role: string,
  text: string,
  calls: string,
  callId: string,
  toolName: string,
};

export function threadsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentId", "agent_id", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("threads", "id", "id", fs);
}

export function threadTurnsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("threadId", "thread_id", "text"),
    field("seq", "seq", "int"),
    field("role", "role", "text"),
    field("text", "text", "text"),
    field("calls", "calls", "text"),
    field("callId", "call_id", "text"),
    field("toolName", "tool_name", "text"),
  ];
  return repository("thread_turns", "id", "id", fs);
}

export function threadPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("19", "threads", createTableSql(db, threadsMapping())),
    migration("20", "thread turns", createTableSql(db, threadTurnsMapping())),
    migration("21", "turns by thread",
      "CREATE INDEX IF NOT EXISTS turns_by_thread ON thread_turns (thread_id, seq)"),
    // Which chunks each round showed, so the next round's retrieval can skip
    // what the replay already carries. `seq` is the round's first turn, which
    // is what trimming cuts on — exclusion has to follow the trim boundary,
    // or a forgotten chunk would stay excluded and never come back.
    migration("24", "thread chunks",
      "CREATE TABLE IF NOT EXISTS thread_chunks ("
      + "thread_id " + db.textType + " NOT NULL, "
      + "seq INTEGER NOT NULL, "
      + "chunk_id " + db.textType + " NOT NULL)"),
    migration("25", "chunks by thread",
      "CREATE INDEX IF NOT EXISTS chunks_by_thread ON thread_chunks (thread_id, seq)"),
    // One turn per seq, enforced. Two requests racing on one thread both read
    // the same turn count and file their rounds from the same number; without
    // this, the second `persist` upserted over the first round's rows and a
    // conversation silently lost half of what was said. Same loud-loser
    // pattern as 51–53: the loser's INSERT fails and the caller is told.
    // Appended at "54" to continue the artifact plan's numbering — versions
    // are global to the migrations table, not per plan.
    migration("54", "one turn per seq",
      "CREATE UNIQUE INDEX IF NOT EXISTS turns_one_per_seq ON thread_turns (thread_id, seq)"),
  ];
  return plan;
}

// The chunk ids shown at or after a round. What the replay still carries, and
// therefore what retrieval must not fetch again — a chunk in a trimmed round
// is genuinely forgotten and may return.
export function chunksShownSince(db: Db, threadId: string, fromSeq: int): string[] {
  let out: string[] = [];
  if (!db.query("SELECT DISTINCT chunk_id FROM thread_chunks WHERE thread_id = " + placeholderAt(db, 1)
                + " AND seq >= " + placeholderAt(db, 2) + " ORDER BY chunk_id",
                [threadId, `${fromSeq}`])) {
    return out;
  }
  let i: int = 0;
  while (i < db.rows()) { out.push(db.value(i, 0)); i = i + 1; }
  return out;
}

export function recordChunks(db: Db, threadId: string, seq: int, chunkIds: string[]): void {
  let i: int = 0;
  while (i < chunkIds.length) {
    executeWith(db, "INSERT INTO thread_chunks (thread_id, seq, chunk_id) VALUES ("
      + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", " + placeholderAt(db, 3) + ")",
      [threadId, `${seq}`, chunkIds[i]]);
    i = i + 1;
  }
}

// --- reading and writing a thread ------------------------------------------------

export function openThread(db: Db, agentId: string, now: string): string {
  let id = crypto.randomUUID();
  let row: ThreadRow = { id: id, agentId: agentId, createdAt: now };
  let written = persist(db, threadsMapping(), JSON.stringify(row));
  if (!written.ok) { return ""; }
  return id;
}

// One row of the thread list: enough for a sidebar, nothing more.
export type ThreadListing = {
  id: string,
  agentId: string,
  createdAt: string,
  // The first thing the user said, which is the only honest title a thread
  // has — nobody names their conversations.
  title: string,
};

// The threads, newest first. The title costs one query per row, which is fine
// for a sidebar page of fifty and wrong for anything unbounded — hence the
// limit is required, not defaulted.
export function listThreads(db: Db, limit: int, offset: int): ThreadListing[] {
  let out: ThreadListing[] = [];
  let newest: DbOrder[] = [desc("created_at")];
  let page = pageOrdered(db, threadsMapping(), "", [], newest, limit, offset);
  if (page == "" || page == "[]") { return out; }
  let rows: ThreadRow[] = JSON.parse<ThreadRow[]>(page);
  let i: int = 0;
  while (i < rows.length) {
    let said = threadMessages(db, rows[i].id);
    let title = "";
    let m: int = 0;
    while (m < said.length) {
      if (said[m].role == "user") { title = said[m].text; break; }
      m = m + 1;
    }
    if (title.length > 80) { title = title.slice(0, 77) + "..."; }
    let listing: ThreadListing = { id: rows[i].id, agentId: rows[i].agentId, createdAt: rows[i].createdAt, title: title };
    out.push(listing);
    i = i + 1;
  }
  return out;
}

export function threadAgent(db: Db, threadId: string): string {
  let document = findById(db, threadsMapping(), threadId);
  if (document == "") { return ""; }
  return jsonText(document, "agentId");
}

// A thread's context, in order.
export function threadTurns(db: Db, threadId: string): Turn[] {
  let out: Turn[] = [];
  let keys: DbOrder[] = [asc("seq")];
  let listed = listOrdered(db, threadTurnsMapping(), "thread_id = " + placeholderAt(db, 1), [threadId], keys);
  if (listed == "" || listed == "[]") { return out; }
  let rows: ThreadTurnRow[] = JSON.parse<ThreadTurnRow[]>(listed);
  let i: int = 0;
  while (i < rows.length) {
    out.push(turnOf(rows[i]));
    i = i + 1;
  }
  return out;
}

// One stored row as a turn. The calls are read back rather than reconstructed:
// a replayed assistant turn must carry the same call ids as the tool turns
// answering it, and inventing new ones would break the pairing.
function turnOf(row: ThreadTurnRow): Turn {
  if (row.role == "assistant") {
    let calls: ToolCall[] = [];
    let items = jsonList(row.calls);
    let i: int = 0;
    while (i < items.length) {
      calls.push(toolCall(jsonText(items[i], "id"), jsonText(items[i], "name"), jsonRaw(items[i], "args")));
      i = i + 1;
    }
    return assistantTurn(row.text, calls);
  }
  if (row.role == "tool") { return toolTurn(row.callId, row.toolName, row.text); }
  return userTurn(row.text);
}

// The assistant's calls as JSON, for storage.
function callsJson(calls: ToolCall[]): string {
  let out = "[";
  let i: int = 0;
  while (i < calls.length) {
    if (i > 0) { out = out + ","; }
    let args = calls[i].args;
    if (args == "") { args = "{}"; }
    out = out + "{\"id\":" + JSON.stringify(calls[i].id)
      + ",\"name\":" + JSON.stringify(calls[i].name)
      + ",\"args\":" + args + "}";
    i = i + 1;
  }
  return out + "]";
}

// Append turns to a thread, continuing its numbering. Returns "" on success
// and the database's sentence otherwise — an error a caller must check,
// because a round that was not stored must not have files extracted against
// its seq.
//
// All of the round or none of it, in one transaction. A round is not a list of
// rows that happen to arrive together: an assistant turn announcing calls is
// only replayable beside the tool turns that answer them, and a cut between
// them leaves a thread every provider refuses from then on — permanently, and
// the caller is meanwhile told "the round was not stored", which was false.
// A NUL byte in a tool result is one live trigger: jsonUnescape resolves the
// escape a provider wrote into the byte itself, and PostgreSQL refuses that in
// a text parameter. A race losing on migration 54's unique index is another.
export function appendTurns(db: Db, threadId: string, turns: Turn[], from: int): string {
  if (turns.length == 0) { return ""; }

  let opened = beginTransaction(db);
  if (!opened.ok) { return opened.error; }

  let i: int = 0;
  while (i < turns.length) {
    let seq = from + i;
    let row: ThreadTurnRow = {
      id: threadId + "-" + `${seq}`,
      threadId: threadId,
      seq: seq,
      role: turns[i].role,
      text: turns[i].text,
      calls: callsJson(turns[i].calls),
      callId: turns[i].callId,
      toolName: turns[i].toolName,
    };
    // An explicit INSERT, not `persist`: persist upserts, and an upsert here
    // let two rounds racing on one thread silently merge — the loser's turns
    // replaced the winner's row by row. With migration 54's unique
    // (thread_id, seq), the loser now fails loudly and this returns why.
    let wrote = executeWith(db,
      "INSERT INTO thread_turns (id, thread_id, seq, role, text, calls, call_id, tool_name) VALUES ("
      + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", " + placeholderAt(db, 3) + ", "
      + placeholderAt(db, 4) + ", " + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ", "
      + placeholderAt(db, 7) + ", " + placeholderAt(db, 8) + ")",
      [row.id, row.threadId, `${row.seq}`, row.role, row.text, row.calls, row.callId, row.toolName]);
    if (!wrote.ok) {
      rollbackTransaction(db);
      return wrote.error;
    }
    i = i + 1;
  }

  let done = commitTransaction(db);
  if (!done.ok) {
    rollbackTransaction(db);
    return done.error;
  }
  return "";
}

// Whether a round's turns are actually in the table.
//
// `appendTurns` returns "" for success, and a round that failed before it was
// ever called leaves that same "" behind — so the sentinel alone says both
// "the append succeeded" and "no append was attempted". Read as success, a
// failed round's retrieved chunk ids get filed under a seq the table does not
// hold, and `chunksShownSince` then excludes them from every later retrieval
// in that thread, permanently, while the replay never carries them.
export function roundIsStored(runOk: bool, appendProblem: string): bool {
  return runOk && appendProblem == "";
}

// --- trimming -----------------------------------------------------------------------

// How much of a thread is replayed, in characters.
//
// Characters rather than tokens because this package cannot count tokens
// without asking a provider, and a character budget that is roughly right beats
// a token count that costs a request. Four characters to a token is the usual
// rule, so this is on the order of 25k tokens.
const THREAD_BUDGET_CHARS: int = 100000;

// The tail of a thread that fits, cut on round boundaries.
//
// A round is a user turn and everything that answered it — the assistant turns
// and their tool results. Cutting inside one leaves a tool result whose call is
// gone, which is not merely untidy: a provider rejects the request, so a thread
// that grew too long would stop working rather than forget its beginning.
export function withinBudget(turns: Turn[], budget: int): Turn[] {
  let total: int = 0;
  let i: int = 0;
  while (i < turns.length) { total = total + turnSize(turns[i]); i = i + 1; }
  if (total <= budget) { return turns; }

  // Drop whole rounds from the front until it fits. A round starts at a user
  // turn that is not a tool result.
  let start: int = 0;
  while (start < turns.length && total > budget) {
    let next = nextRound(turns, start);
    if (next >= turns.length) { break; }
    let d: int = start;
    while (d < next) { total = total - turnSize(turns[d]); d = d + 1; }
    start = next;
  }

  let out: Turn[] = [];
  let k: int = start;
  while (k < turns.length) { out.push(turns[k]); k = k + 1; }
  return out;
}

// Where the round after the one at `from` begins.
export function nextRound(turns: Turn[], from: int): int {
  let i = from + 1;
  while (i < turns.length) {
    if (turns[i].role == "user") { return i; }
    i = i + 1;
  }
  return turns.length;
}

// What a turn costs, near enough. The arguments and results count: a tool that
// returned four thousand lines is the reason a thread needs trimming at all.
function turnSize(turn: Turn): int {
  let n = turn.text.length + turn.toolName.length;
  let i: int = 0;
  while (i < turn.calls.length) {
    n = n + turn.calls[i].name.length + turn.calls[i].args.length;
    i = i + 1;
  }
  return n;
}

export function threadBudget(): int {
  return THREAD_BUDGET_CHARS;
}

// The opening of what asContext writes. Kept here beside the check that uses
// it so the two cannot drift apart silently.
const CONTEXT_PREFIX = "Use only the following context.";

// --- continuing a conversation ---------------------------------------------------

// One clock for the rows extraction writes. The run loop and the API each
// keep a private copy of this line for the same reason: a shared helper is
// worth a deliberate home, not a side effect of a feature change.
function stamp(): string { return `${Date.now()}`; }

// What asking a thread produces: the run, and what the thread now remembers.
//
// `run.text` stays the RAW reply — fences, bodies and all — because the run
// log is the audit trail and must hold what the model actually said. `text`
// is the reply as the thread stores it: each saved fence replaced by its
// nonce-minted reference marker, every marker-lookalike flattened. The wire
// serves `text` with the nonce stripped, never `run.text`.
export type ThreadReply = {
  run: AgentRun,
  text: string,
  // The round's base turn seq — the number every artifact write of the round
  // is stamped with — or TURN_SEQ_NONE when the thread named no agent and no
  // round was stored.
  baseSeq: int,
  // Extraction's refusals and rewrites, in words, for the run log.
  notes: string[],
};

// Ask a thread. Everything it already holds is replayed, this question is
// added, and whatever the run produced is appended.
//
// Retrieval still happens for the new question: the passages already in the
// thread were fetched for older ones, and "and in Rotterdam?" needs its own.
export function runInThread(db: Db, threadId: string, userText: string, master: string, tracer: Tracer): ThreadReply {
  let agentId = threadAgent(db, threadId);
  if (agentId == "") {
    let noThread: Turn[] = [];
    let path: string[] = [];
    // Runs against an agent that does not exist, which reports "no agent " and
    // is the truth: this thread names nothing runnable.
    let noChunks: string[] = [];
    let refused = runAgentAt(db, "", userText, master, { depth: 0, path: path, tracer: tracer, parentSpan: "", prior: noThread, threadId: "", excludeChunks: noChunks, baseSeq: TURN_SEQ_NONE });
    let noNotes: string[] = [];
    let bare: ThreadReply = { run: refused, text: refused.text, baseSeq: TURN_SEQ_NONE, notes: noNotes };
    return bare;
  }

  let held = threadTurns(db, threadId);
  let replayed = withinBudget(held, threadBudget());
  // The replay's first surviving turn: chunks shown before it were trimmed
  // away with their rounds and may be retrieved afresh.
  let firstReplayed = held.length - replayed.length;
  let alreadyShown = chunksShownSince(db, threadId, firstReplayed);
  let path: string[] = [];
  // The round's base is the thread's stored turn count, not the replayed
  // one: trimming affects what the model is shown, never the numbering — and
  // this is the seq every artifact write of the round is stamped with, the
  // same number `appendTurns` below files the round's turns from.
  let run = runAgentAt(db, agentId, userText, master, { depth: 0, path: path, tracer: tracer, parentSpan: "", prior: replayed, threadId: threadId, excludeChunks: alreadyShown, baseSeq: held.length });

  // What this run added: everything in its context past what was replayed.
  // Stored under the thread's own numbering, which continues from what is
  // there rather than from what was replayed — trimming affects what the model
  // is shown, never what is kept.
  let added: Turn[] = [];
  let i: int = replayed.length;
  while (i < run.context.length) { added.push(run.context[i]); i = i + 1; }
  if (run.text != "") {
    let noCalls: ToolCall[] = [];
    added.push(assistantTurn(run.text, noCalls));
  }

  // Turns first, with the RAW text — extraction only runs against a round the
  // table actually holds, because turn_seq names a stored round and a file the
  // transcript cannot account for is worse than a fence left in prose.
  let notes: string[] = [];
  let kept = run.text;
  // A round that produced no answer is not a round.
  //
  // The question still reached `context` before the provider failed, so
  // storing what the run built would file the user's turn under a round that
  // never happened — and the console's Retry sends the same text again, so
  // the next attempt replays the stored copy AND appends a fresh one. The
  // provider then sees the question twice, which is the least of it: the
  // duplicate is permanent and every later replay carries it.
  let appended = "";
  if (run.ok) {
    appended = appendTurns(db, threadId, added, held.length);
  } else {
    notes.push("the round was not stored: " + run.error);
  }
  // Whether the round's turns are in the table — which "" alone cannot say,
  // since a round nobody tried to store returns the same "".
  let stored = roundIsStored(run.ok, appended);
  if (!run.ok) {
    // Nothing stored, nothing to extract against, and no marker in this text
    // can be genuine.
    kept = neutraliseMarkers(run.text, crypto.randomUUID()).text;
  } else if (appended != "") {
    notes.push("this round could not be stored (" + appended + "), so no files were extracted from the reply");
    // Nothing was written this round, so no marker in this text can be
    // genuine — flattening against a nonce nothing carries turns every
    // lookalike into the honest sentence. Without this, the one reply that
    // failed to store was also the one whose forged markers reached the wire
    // as cards.
    kept = neutraliseMarkers(run.text, crypto.randomUUID()).text;
  } else if (run.text != "") {
    let out = extractFiles(db, threadId, held.length, run.text, stamp());
    kept = out.text;
    let en: int = 0;
    while (en < out.notes.length) { notes.push(out.notes[en]); en = en + 1; }
    if (kept != run.text) {
      // Re-persist only the final assistant row, now carrying references
      // instead of bodies. `persist` is right here and wrong above: the row
      // exists and updating it is the intent, so the upsert lands on the id
      // the append just wrote rather than colliding on migration 54's index.
      let seq = held.length + added.length - 1;
      let noCalls: ToolCall[] = [];
      let rewritten: ThreadTurnRow = {
        id: threadId + "-" + `${seq}`,
        threadId: threadId,
        seq: seq,
        role: "assistant",
        text: kept,
        calls: callsJson(noCalls),
        callId: "",
        toolName: "",
      };
      let moved = persist(db, threadTurnsMapping(), JSON.stringify(rewritten));
      if (!moved.ok) {
        // The thread keeps the raw reply, which still reads fine — it merely
        // shows fences where references should be. Said in the notes rather
        // than swallowed, because the extraction DID write the files.
        notes.push("the reply could not be rewritten to references (" + moved.error + "); the raw fences remain in the transcript");
      }
    }
  }

  // What this round showed, filed under its first turn's seq so exclusion
  // follows the trim boundary.
  let shown: string[] = [];
  let r: int = 0;
  while (r < run.retrieved.length) { shown.push(run.retrieved[r].id); r = r + 1; }
  // Only for a stored round: chunks filed under a seq the table does not hold
  // would be excluded from future retrieval by chunksShownSince while the
  // replay never actually carried them.
  if (stored && shown.length > 0) { recordChunks(db, threadId, held.length, shown); }
  let reply: ThreadReply = { run: run, text: kept, baseSeq: held.length, notes: notes };
  return reply;
}

// The conversation a person reads: the questions and the answers, without the
// tool calls, the results or the passages.
//
// The same rows serve both — what differs is which turns are shown. A model
// needs the working; a reader needs the conclusion.
export function threadMessages(db: Db, threadId: string): Turn[] {
  let out: Turn[] = [];
  let rows = threadMessageRows(db, threadId);
  let i: int = 0;
  while (i < rows.length) {
    out.push(turnOf(rows[i]));
    i = i + 1;
  }
  return out;
}

// The same conversation as stored rows, seq kept. The wire needs the number:
// a message's artifact cards come from the join on the round's turn_seq, and
// Turn — the provider's shape — deliberately does not carry one.
export function threadMessageRows(db: Db, threadId: string): ThreadTurnRow[] {
  let out: ThreadTurnRow[] = [];
  let keys: DbOrder[] = [asc("seq")];
  let listed = listOrdered(db, threadTurnsMapping(), "thread_id = " + placeholderAt(db, 1), [threadId], keys);
  if (listed == "" || listed == "[]") { return out; }
  let rows: ThreadTurnRow[] = JSON.parse<ThreadTurnRow[]>(listed);
  let i: int = 0;
  while (i < rows.length) {
    // A user turn carrying retrieved passages is context, not something the
    // person typed, and an assistant turn that is only tool calls said nothing.
    //
    // The passages are recognised by the sentence asContext puts in front of
    // them. Matching on text is a seam — a marker on the turn would be better —
    // but Turn is the provider's shape and a field the wire does not carry has
    // to be justified by more than this.
    if (rows[i].role == "user" && !rows[i].text.startsWith(CONTEXT_PREFIX)) { out.push(rows[i]); }
    else if (rows[i].role == "assistant" && rows[i].text != "" && jsonList(rows[i].calls).length == 0) { out.push(rows[i]); }
    i = i + 1;
  }
  return out;
}

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
import { DbField, DbOrder, DbRepository, field, repository, asc, desc, persist, findById, listOrdered, pageOrdered, executeWith, placeholderAt, createTableSql, execute } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { Turn, ToolCall, toolCall, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { AgentRun, runAgentAt } from "./run.ts";
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

// Append turns to a thread, continuing its numbering.
export function appendTurns(db: Db, threadId: string, turns: Turn[], from: int): string {
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
    let written = persist(db, threadTurnsMapping(), JSON.stringify(row));
    if (!written.ok) { return written.error; }
    i = i + 1;
  }
  return "";
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

// Ask a thread. Everything it already holds is replayed, this question is
// added, and whatever the run produced is appended.
//
// Retrieval still happens for the new question: the passages already in the
// thread were fetched for older ones, and "and in Rotterdam?" needs its own.
export function runInThread(db: Db, threadId: string, userText: string, master: string, tracer: Tracer): AgentRun {
  let agentId = threadAgent(db, threadId);
  if (agentId == "") {
    let noThread: Turn[] = [];
    let path: string[] = [];
    // Runs against an agent that does not exist, which reports "no agent " and
    // is the truth: this thread names nothing runnable.
    let noChunks: string[] = [];
    return runAgentAt(db, "", userText, master, { depth: 0, path: path, tracer: tracer, parentSpan: "", prior: noThread, threadId: "", excludeChunks: noChunks });
  }

  let held = threadTurns(db, threadId);
  let replayed = withinBudget(held, threadBudget());
  // The replay's first surviving turn: chunks shown before it were trimmed
  // away with their rounds and may be retrieved afresh.
  let firstReplayed = held.length - replayed.length;
  let alreadyShown = chunksShownSince(db, threadId, firstReplayed);
  let path: string[] = [];
  let run = runAgentAt(db, agentId, userText, master, { depth: 0, path: path, tracer: tracer, parentSpan: "", prior: replayed, threadId: threadId, excludeChunks: alreadyShown });

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
  appendTurns(db, threadId, added, held.length);
  // What this round showed, filed under its first turn's seq so exclusion
  // follows the trim boundary.
  let shown: string[] = [];
  let r: int = 0;
  while (r < run.retrieved.length) { shown.push(run.retrieved[r].id); r = r + 1; }
  if (shown.length > 0) { recordChunks(db, threadId, held.length, shown); }
  return run;
}

// The conversation a person reads: the questions and the answers, without the
// tool calls, the results or the passages.
//
// The same rows serve both — what differs is which turns are shown. A model
// needs the working; a reader needs the conclusion.
export function threadMessages(db: Db, threadId: string): Turn[] {
  let out: Turn[] = [];
  let all = threadTurns(db, threadId);
  let i: int = 0;
  while (i < all.length) {
    // A user turn carrying retrieved passages is context, not something the
    // person typed, and an assistant turn that is only tool calls said nothing.
    //
    // The passages are recognised by the sentence asContext puts in front of
    // them. Matching on text is a seam — a marker on the turn would be better —
    // but Turn is the provider's shape and a field the wire does not carry has
    // to be justified by more than this.
    if (all[i].role == "user" && !all[i].text.startsWith(CONTEXT_PREFIX)) { out.push(all[i]); }
    else if (all[i].role == "assistant" && all[i].text != "" && all[i].calls.length == 0) { out.push(all[i]); }
    i = i + 1;
  }
  return out;
}

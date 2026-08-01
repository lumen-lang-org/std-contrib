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
import { TURN_SEQ_NONE, listArtifacts } from "./artifacts.ts";
import { forgetRound, forgetThoughts } from "./steps.ts";
import { extractFiles, neutraliseMarkers } from "./artifacts-fence.ts";
import { Tracer, noTracer } from "../tracing/tracing.ts";
import { jsonRaw, jsonList, jsonText } from "./scan.ts";
import { ModelChoiceRow, ModelRouterRow, enabledChoices, configForChoice, configAndModel, modelChoicesMapping, modelRoutersMapping } from "./schema.ts";
import { RouteAsk, candidatesFrom, indexOfKey, routeTurn } from "./router.ts";
import { credentialFor } from "./credentials.ts";
import { ownerClause, documentIsOwned } from "./owner.ts";

// A thread belongs to one agent. Moving a conversation to a different agent
// would replay tool calls naming tools the new agent may not have, so it is
// not offered.
export type ThreadRow = {
  id: string,
  agentId: string,
  // Whose conversation this is: one opaque tag a trusted proxy named, or ""
  // for a thread nobody claimed — every thread written before there were
  // owners, and every thread written by a deployment with no proxy in front
  // (GATEWAY.md). Never NULL: "unowned" splitting into two spellings is a
  // filter that misses half of them.
  owner: string,
  // Which row of the model menu this conversation last chose, or "" for the
  // agent's own config — which is what every thread written before this
  // feature means, so nothing is backfilled.
  //
  // Per thread rather than per message, and a thread is therefore the memory
  // of the last override: reopening a conversation keeps answering with what
  // was last picked. Changing it applies to the next turn, since the choice
  // travels with the message (MODEL-CHOICE.md, "Where the choice is stored").
  // History is never rewritten — turns are stored provider-neutrally, so a
  // thread whose rounds were answered by different models replays with no
  // special handling.
  modelChoiceId: string,
  // The candidate key this conversation last routed to, "" when it has not
  // routed. Only a router ever writes it, and only two things read it.
  //
  // `escalateOnly` is the first: the ratchet is defined as "may only move UP
  // the candidate order WITHIN A THREAD", so it needs the position the thread
  // reached, and there is nowhere else it could come from — `runs` is a log a
  // sweep may thin, and a note in prose is not a key. Without this column
  // `RouteAsk.previousKey` was always "", `notEarlier` returned at its first
  // line, and the flag was a column with tests and no effect.
  //
  // `routeEvery: "thread"` is the second, and for the same reason: "has this
  // conversation already routed" is a fact about the conversation.
  //
  // A key and not a config id, because that is what the ratchet compares — the
  // order is the operator's candidate list, and a config can appear twice in
  // it. A key that is no longer a candidate imposes no floor; `indexOfKey`
  // answers -1 and `notEarlier` says so.
  routeKey: string,
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

// The shape migration 19 recorded, frozen — the `modelsMappingV1` precedent in
// schema.ts, for the same reason. Migration 19 generates its CREATE from a
// mapping, and a migration's text is checksummed: adding `owner` to the live
// mapping below would rewrite 19 and every database that has already run it
// would refuse the whole plan, while a fresh one migrated happily and CI
// stayed green. A new column is an ALTER at a new version, never an edit here.
function threadsMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentId", "agent_id", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("threads", "id", "id", fs);
}

export function threadsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentId", "agent_id", "text"),
    // Added after 19 shipped, so it arrives as an ALTER at 71.
    field("owner", "owner", "text"),
    // The same, at 85 and 85.1.
    field("modelChoiceId", "model_choice_id", "text"),
    field("routeKey", "route_key", "text"),
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
    migration("19", "threads", createTableSql(db, threadsMappingV1())),
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
    // Whose thread it is. Two migrations because they are two facts: the
    // column, and the index the sidebar's read needs — the list is scoped in
    // SQL, so every page of every owner walks this.
    //
    // DEFAULT '' and NOT NULL: the threads already in the table belong to
    // nobody, and one spelling of "nobody" is what makes the backfill a
    // WHERE owner = '' rather than an archaeology exercise.
    migration("71", "a thread has an owner",
      "ALTER TABLE threads ADD COLUMN owner " + db.textType + " NOT NULL DEFAULT ''"),
    migration("72", "threads by owner",
      "CREATE INDEX IF NOT EXISTS threads_by_owner ON threads (owner, created_at)"),
    // Which model the person chose. No index: it is read by id along with the
    // rest of the row and never filtered on, so an index here would be paid
    // for on every open and never used.
    //
    // DEFAULT '' and NOT NULL for the same reason `owner` is: "" already means
    // "the agent's own config" everywhere else, so every existing thread is
    // correct without being touched.
    migration("85", "a thread remembers the model that was chosen",
      "ALTER TABLE threads ADD COLUMN model_choice_id " + db.textType + " NOT NULL DEFAULT ''"),
    // And where the routing got to, which is a different fact from which menu
    // row is in force: one is what a person picked, the other is what the
    // router decided under it. No index, for the reason above — read by id
    // with the rest of the row, never filtered on.
    //
    // 85.1 rather than a number after the seed: it belongs beside the column
    // it completes, and a dotted version is compared numerically so it lands
    // between 85 and 86. `migrate` refuses a step below what a database has
    // already applied, which is why this is not simply appended at the end —
    // the whole 82-to-87 block is unapplied wherever 85 is.
    migration("85.1", "a thread remembers where the routing got to",
      "ALTER TABLE threads ADD COLUMN route_key " + db.textType + " NOT NULL DEFAULT ''"),
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

// What opening a conversation needs to know. A record and not three strings:
// `agentId`, `owner` and `now` are all text, and a caller that swapped two of
// them would file somebody else's thread under a timestamp.
export type ThreadOpen = {
  agentId: string,
  owner: string,
  now: string,
};

export function openThread(db: Db, open: ThreadOpen): string {
  let id = crypto.randomUUID();
  // A thread opens on the agent's own model. The composer's picker travels
  // with the message, so an opening choice is an UPDATE the messages POST
  // makes on the first turn rather than a second argument here — which also
  // keeps `POST /threads` and `POST /threads/:id/messages` reading the field
  // from exactly one place.
  let row: ThreadRow = { id: id, agentId: open.agentId, owner: open.owner, modelChoiceId: "", routeKey: "", createdAt: open.now };
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

// Which page of whose threads. An empty `tags` is the unscoped read — the
// community edition, every thread there is; see owner.ts.
export type ThreadPage = {
  tags: string[],
  limit: int,
  offset: int,
};

// How long a thread may sit empty before the sweep may take it, read from
// `AGENTS_SWEEP_IDLE_MS`; 0 means never, and never is the default.
//
// Opt-in, not merely configurable. Nothing has ever deleted a thread row in
// this engine, so a sweeper that ran on the numbers it liked would be new data
// loss arriving with an upgrade, in the edition that has no operator watching.
// An operator who wants abandoned opens collected says how old is abandoned;
// everyone else keeps every row they have.
//
// Unreadable is off for the same reason `bytesCap` treats unreadable as the
// default: a typo in a unit file must not be read as a deletion policy.
export function sweepIdleMs(said: string): int {
  let text = said.trim();
  if (text == "") { return 0; }
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) { return 0; }
    i = i + 1;
  }
  let n = parseInt(text, 10) ?? 0;
  if (n < 1) { return 0; }
  return n;
}

// A thread that never said anything, produced nothing and ran nothing is a
// row someone abandoned before it became a conversation — an aborted open, a
// test's leftover. Taken once it is old, and only where an operator asked for
// that; anything with a turn, an artifact, an uploaded file, a failed round's
// steps or a run is history and stays.
//
// The workspace and runs clauses are not symmetry with the other two, they are
// the two states a thread reaches while still holding nothing else. A thread
// opened by dropping a file in holds no turn until the first question is
// asked. A thread whose first round failed holds no turn either — a round that
// produced no answer is not a round (`appendTurns` below), and a provider that
// never answered dispatched no tool call, so there is no step row either — but
// it holds a `runs` row, and the person looking at the failure is about to
// press Retry.
export function sweepEmptyThreads(db: Db, before: string): void {
  executeWith(db,
    "DELETE FROM threads WHERE created_at < " + placeholderAt(db, 1)
    + " AND NOT EXISTS (SELECT 1 FROM thread_turns t WHERE t.thread_id = threads.id)"
    + " AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.thread_id = threads.id)"
    + " AND NOT EXISTS (SELECT 1 FROM thread_steps s WHERE s.thread_id = threads.id)"
    + " AND NOT EXISTS (SELECT 1 FROM workspace_files w WHERE w.thread_id = threads.id)"
    + " AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = threads.id)",
    [before]);
}

// The threads, newest first. The title costs one query per row, which is fine
// for a sidebar page of fifty and wrong for anything unbounded — hence the
// limit is required, not defaulted.
//
// The owner filter is in the WHERE and never a pass over the answer; owner.ts
// says why.
export function listThreads(db: Db, page: ThreadPage): ThreadListing[] {
  let out: ThreadListing[] = [];
  let newest: DbOrder[] = [desc("created_at")];
  let mine = pageOrdered(db, threadsMapping(), ownerClause(db, page.tags, 1), page.tags, newest, page.limit, page.offset);
  if (mine == "" || mine == "[]") { return out; }
  let rows: ThreadRow[] = JSON.parse<ThreadRow[]>(mine);
  let i: int = 0;
  while (i < rows.length) {
    let said = threadMessages(db, rows[i].id);
    let title = "";
    let m: int = 0;
    while (m < said.length) {
      if (said[m].role == "user") { title = said[m].text; break; }
      m = m + 1;
    }
    // A thread opened by an upload has no words yet; the file's own name is
    // the only honest title it has. Only when no round stored — a sentence,
    // once one exists, outranks a filename.
    if (title == "") {
      let held = listArtifacts(db, rows[i].id);
      if (held.length > 0) { title = held[0].path; }
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

// The agent of a thread this caller may reach, or "" — which every route reads
// as a 404. A thread owned by somebody else answers exactly as a thread that
// was never opened: 403 would confirm the id names something real, and an id
// is the whole of a thread's secrecy here.
//
// This is the one place a `/threads/:id/...` route resolves an id. Nine routes
// repeated the ownerless version of this check inline and seven resolved the
// file or the artifact directly without it — and the seven are why this is a
// function rather than a line to copy again.
// Whose thread it is, "" for a thread nobody claimed or a thread that is not
// there. Read by the routes that stamp a second row with the same owner — a
// run log line, today — because ownership follows the conversation and not
// whoever happens to be asking in it.
export function threadOwner(db: Db, threadId: string): string {
  let document = findById(db, threadsMapping(), threadId);
  if (document == "") { return ""; }
  return jsonText(document, "owner");
}

export function ownedThread(db: Db, threadId: string, tags: string[]): string {
  let document = findById(db, threadsMapping(), threadId);
  if (document == "") { return ""; }
  if (!documentIsOwned(document, tags)) { return ""; }
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
// it so the two cannot drift apart silently — and they did drift once anyway,
// when the sentence was rewritten in knowledge.ts and this copy kept the old
// words; the knowledge suite pins the two together now.
const CONTEXT_PREFIX = "Passages retrieved from the knowledge base";

// --- which model answers ------------------------------------------------------------

// What this conversation last chose: a `model_choices` id, or "" for the
// agent's own config — which a thread that is not there answers too, since a
// conversation nobody can find has nothing to run on either way.
export function threadChoice(db: Db, threadId: string): string {
  let document = findById(db, threadsMapping(), threadId);
  if (document == "") { return ""; }
  return jsonText(document, "modelChoiceId");
}

// Where this conversation's routing got to: a candidate key, or "" for a
// thread that has not routed — which includes every thread that has never used
// a router choice and every thread whose every routing attempt fell back.
export function threadRouteKey(db: Db, threadId: string): string {
  let document = findById(db, threadsMapping(), threadId);
  if (document == "") { return ""; }
  return jsonText(document, "routeKey");
}

// Remember where the routing got to. Returns the database's sentence, or "".
//
// A one-column UPDATE for the reason `rememberChoice` is one: `persist` would
// write the whole row back from a document, which is a wider write for a
// one-column fact and an upsert that would re-create a thread the sweep took
// between the read and the write.
//
// Only a decision that actually chose a candidate is written. A fallback
// leaves the floor where it was: the run happened on the fallback config, but
// no candidate was picked, so recording one would let a dead provider quietly
// ratchet a conversation somewhere nobody routed it.
export function rememberRouteKey(db: Db, threadId: string, key: string): string {
  if (key == "") { return ""; }
  let wrote = executeWith(db,
    "UPDATE threads SET route_key = " + placeholderAt(db, 1)
    + " WHERE id = " + placeholderAt(db, 2),
    [key, threadId]);
  if (wrote.ok) { return ""; }
  return wrote.error;
}

// Whether an id names a row the menu currently offers.
//
// Asked over `enabledChoices` — the same read the menu itself is built from —
// rather than by fetching the one row: a choice that stops being offered stops
// being resolvable here on the same day, without two definitions of "offered"
// to keep in step. The menu is a handful of rows an operator curates, not a
// table that grows with traffic, so the scan is cheaper than the second
// definition would be.
function inMenu(db: Db, choiceId: string): bool {
  let rows: ModelChoiceRow[] = enabledChoices(db);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].id == choiceId) { return true; }
    i = i + 1;
  }
  return false;
}

// Remember what was chosen, so the next message carrying no override keeps
// answering with it — a thread is the memory of the last override
// (MODEL-CHOICE.md, "API"). Returns the database's sentence, or "".
//
// An UPDATE of the one column rather than `persist`: persist writes a whole row
// from a document, so keeping one field would mean reading the thread back and
// writing `owner`, `agent_id` and `created_at` out again from what was read —
// a wider write for a one-column fact, and an upsert that would re-create a
// thread the sweep took between the read and the write.
export function rememberChoice(db: Db, threadId: string, choiceId: string): string {
  let wrote = executeWith(db,
    "UPDATE threads SET model_choice_id = " + placeholderAt(db, 1)
    + " WHERE id = " + placeholderAt(db, 2),
    [choiceId, threadId]);
  if (wrote.ok) { return ""; }
  return wrote.error;
}

// The turn's model, decided.
export type ChosenModel = {
  // The menu row that was actually in force, or "" when nothing was chosen —
  // and "" as well when what was chosen no longer exists, because a run row
  // naming a choice that did not answer is worse than one naming none.
  choiceId: string,
  // The `model_configs` row to run on, "" for the agent's own.
  configId: string,
  // One line for `runs.route_note` when the choice did not end up answering,
  // "" when it did and when there was nothing to choose. The only place a
  // silent fallback is written down.
  note: string,
};

// What a message said about the model, which is three states and not two.
//
// A record rather than a bare string because the two facts are only useful
// together: what was picked, and whether anything was picked at all. Read off
// a body by `askedPick` in api.ts, defaulted to "said nothing" by
// `runInThread`.
//
// The state that was missing: "" as an ID is the menu's last row, "Agent
// default", and it is a choice a person makes with a click. Collapsed into
// "the caller said nothing" — which is what a single string forces — picking
// it left the thread's memory in place, the next turn answered on the model
// the person had just moved away from, and reopening the conversation snapped
// the picker back to it. There was no value the wire could carry that meant
// "clear", which made one row of the menu permanently inert.
export type ModelPick = {
  // The `model_choices` id, "" for the agent's own config.
  choiceId: string,
  // Whether the message said anything about the model. false inherits the
  // thread's memory; true is a statement, "" included.
  sent: bool,
};

// A message that said nothing about the model — every caller written before
// the picker existed, and `runInThread`.
export function inheritedPick(): ModelPick {
  let none: ModelPick = { choiceId: "", sent: false };
  return none;
}

// message override > threads.model_choice_id > the agent's own config
// (MODEL-CHOICE.md, "API"). The precedence is one function because the doc's
// "every read site uses the same one" stays true only while there is one — two
// columns encoding one choice was rejected for the same reason.
//
// Nothing here can stop a turn. An override naming a row that was retired, a
// thread remembering one that was, an id nobody ever created: each answers
// "the agent's own" and says so in `note`. A run that would have happened must
// still happen — silently to the person typing, recorded for the operator,
// which is the posture `routeChoice` below inherits.
//
// This is the SYNCHRONOUS half only. A router choice resolves to "the agent's
// own, and here is why" — see `configForChoice` — because which config a router
// lands on is not known until a completion has been made and this makes none.
// `routeChoice` is the other half, and the two are separate so that resolution
// stays a function of the database that a test can ask without a provider.
export function chooseModel(db: Db, threadId: string, pick: ModelPick): ChosenModel {
  let choiceId = pick.choiceId;
  // Absence inherits; a statement stands, and a statement of "" is the way
  // back to the agent's own model.
  if (!pick.sent) { choiceId = threadChoice(db, threadId); }
  if (choiceId == "") {
    let own: ChosenModel = { choiceId: "", configId: "", note: "" };
    return own;
  }
  // Whether the menu offers it at all, asked BEFORE the config is resolved:
  // `configForChoice` answers "" for a router row and for a typo alike, and
  // those two must not be treated the same way. One is a choice the operator
  // published; the other is nothing, and remembering it would overwrite a
  // working pick with a dead one.
  if (!inMenu(db, choiceId)) {
    let gone: ChosenModel = { choiceId: "", configId: "",
      note: "the chosen model " + choiceId + " is not in the menu; the agent's own answered" };
    return gone;
  }
  let configId = configForChoice(db, choiceId);
  if (configId == "") {
    // A router row, and this phase makes no completion. The note is the
    // caller's cue as much as the operator's: `routeChoice` is what turns this
    // into a decision, and a turn that reaches a run with this note still on it
    // is a turn where nothing routed — which is what the sentence says.
    let routed: ChosenModel = { choiceId: choiceId, configId: "",
      note: "the chosen model " + choiceId + " routes, and nothing routed this turn; the agent's own answered" };
    return routed;
  }
  let chosen: ChosenModel = { choiceId: choiceId, configId: configId, note: "" };
  return chosen;
}

// Whether a resolved choice still has a routing decision owed to it: a menu row
// is in force, and no config has been settled on.
function awaitsRouting(chosen: ChosenModel): bool {
  return chosen.choiceId != "" && chosen.configId == "";
}

// What the routing phase is given. A record because `threadId`, `userText` and
// `master` are three strings, and a caller that swapped the last two would post
// the master key to a provider as the message being classified.
export type RouteRun = {
  threadId: string,
  // What `chooseModel` resolved. Anything that is not a router choice comes
  // back untouched, so this is safe to call on every turn and the caller does
  // not have to know which rows route.
  chosen: ChosenModel,
  // The message being classified, before it is appended to the thread.
  userText: string,
  // The conversation so far. `recentTurns` takes the tail it wants.
  tail: Turn[],
  master: string,
};

// A choice that routes, routed — the asynchronous half of `chooseModel`.
//
// This is the function that was missing, and its absence was not visible from
// any test: `routeTurn` had a suite, `model_routers` had a mapping and a seed,
// and the menu's LEAD row — "Auto", rank 1, the first thing a person sees —
// resolved to "the agent's own config" on every single turn, with a note
// politely explaining that nothing had routed. Everything was built except the
// call between the two halves.
//
// Every path out of here still leaves the run a config, or leaves it "" and
// lets the agent's own answer. `routeTurn` guarantees that much on its own
// arguments; what is added here is the same promise for the rows it needs —
// a router row deleted under a live menu entry, a router config whose model is
// gone, a credential that will not open. Each answers with a sentence in
// `note` rather than an exception, because the note is the only place a person
// ever finds out (MODEL-CHOICE.md, "The router never blocks the run").
export function routeChoice(db: Db, run: RouteRun): ChosenModel {
  let chosen = run.chosen;
  if (!awaitsRouting(chosen)) { return chosen; }

  // The row is in the menu — `chooseModel` established that — so this read is
  // for `routerId` alone.
  let choiceDoc = findById(db, modelChoicesMapping(), chosen.choiceId);
  if (choiceDoc == "") { return chosen; }
  let choice: ModelChoiceRow = JSON.parse<ModelChoiceRow>(choiceDoc);
  if (choice.kind != "router" || choice.routerId == "") { return chosen; }

  let routerDoc = findById(db, modelRoutersMapping(), choice.routerId);
  if (routerDoc == "") {
    let missing: ChosenModel = { choiceId: chosen.choiceId, configId: "",
      note: "the router " + choice.routerId + " is gone; the agent's own answered" };
    return missing;
  }
  let router: ModelRouterRow = JSON.parse<ModelRouterRow>(routerDoc);

  let candidates = candidatesFrom(router.candidatesJson);
  let previousKey = threadRouteKey(db, run.threadId);
  // Paying once per conversation instead of once per turn, which is what
  // `routeEvery` is for. Only while the stored key is still one of the
  // operator's candidates: a list rewritten between turns leaves the thread
  // pointing at a position that no longer exists, and reusing it would answer
  // on whatever config happens to sit there now.
  if (router.routeEvery == "thread" && previousKey != "") {
    let held = indexOfKey(candidates, previousKey);
    if (held >= 0) {
      let again: ChosenModel = { choiceId: chosen.choiceId, configId: candidates[held].configId,
        note: "routed to " + candidates[held].key + ": this thread already routed, and this router routes once" };
      return again;
    }
  }

  // The router's own row pair. A dead one is a fallback rather than a dead
  // run, and it is named — an operator who deleted the config under their
  // router should read which config, not "routing failed".
  let pair = configAndModel(db, router.routerConfigId);
  if (pair.problem != "") {
    let broken: ChosenModel = { choiceId: chosen.choiceId, configId: router.fallbackConfigId,
      note: "fell back: the router cannot run (" + pair.problem + ")" };
    return broken;
  }
  // "" is not special-cased. `complete` refuses without a key and says so, and
  // `routeTurn` turns that refusal into the fallback with the provider's own
  // sentence in the note — which is more useful than a guess made here.
  let apiKey = credentialFor(db, pair.model.provider, run.master);

  let ask: RouteAsk = { userText: run.userText, tail: run.tail, previousKey: previousKey };
  let decided = routeTurn(router, pair.model, pair.config, ask, apiKey);
  // Only a real candidate moves the floor; a fallback leaves it where it was.
  // Written before the run rather than after, for the reason the choice is:
  // a round that dies at the provider must not leave the next turn routing
  // from a different position than the attempt it is retrying.
  rememberRouteKey(db, run.threadId, decided.key);

  // `decided.configId` is the fallback on every failure path, and "" only for
  // a router row whose fallback an operator left empty — which is a row that
  // should not be enabled, and which lands on the agent's own model rather
  // than on nothing at all.
  let routed: ChosenModel = { choiceId: chosen.choiceId, configId: decided.configId, note: decided.note };
  return routed;
}

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
  // Which menu row was in force for this turn, and why the model that answered
  // was the one that did — the two columns migration 86 added to `runs`, ready
  // for the `recordRun` beside the caller.
  //
  // Carried out rather than written here: the `runs` row is written after this
  // returns, by whoever asked (the messages POST), so handing the decision back
  // is the only way it reaches the row. Recomputing it there from the config
  // that answered would be a different, unauditable claim — "the run used
  // c-flash" is not "a person chose Fast".
  modelChoiceId: string,
  routeNote: string,
};

// What one turn is asked with.
//
// A record rather than four more positional arguments, for the reason
// RunContext gives: `userText`, `master` and `modelChoiceId` are all text, and
// a caller that swapped two of them would send the master key to a provider as
// a question and nothing would report it.
export type ThreadAsk = {
  userText: string,
  master: string,
  tracer: Tracer,
  // What this MESSAGE said about the model. The selection travels with the
  // message (MODEL-CHOICE.md, "API"): what the composer's picker shows is what
  // the next send carries, so changing it is never a request of its own and
  // never rewrites history.
  //
  // Applied to this turn AND remembered on the thread — those are one act, not
  // two, which is why there is no separate "set the thread's model" door to
  // get out of step with this one. A pick of "" that was actually SENT is the
  // way back to the agent's own model, and is remembered as such; see
  // `ModelPick`.
  pick: ModelPick,
};

// Ask a thread. Everything it already holds is replayed, this question is
// added, and whatever the run produced is appended.
//
// Retrieval still happens for the new question: the passages already in the
// thread were fetched for older ones, and "and in Rotterdam?" needs its own.
export function runInThread(db: Db, threadId: string, userText: string, master: string, tracer: Tracer): ThreadReply {
  let plain: ThreadAsk = { userText: userText, master: master, tracer: tracer, pick: inheritedPick() };
  return runInThreadWith(db, threadId, plain);
}

// The same turn, carrying what the composer's picker had selected when the
// message was sent. The pair is `runAgent`/`runAgentAt`'s: the short call is
// the one most callers want, and the record carries what only one door needs.
export function runInThreadWith(db: Db, threadId: string, ask: ThreadAsk): ThreadReply {
  let userText = ask.userText;
  let master = ask.master;
  let tracer = ask.tracer;
  let agentId = threadAgent(db, threadId);
  if (agentId == "") {
    let noThread: Turn[] = [];
    let path: string[] = [];
    // Runs against an agent that does not exist, which reports "no agent " and
    // is the truth: this thread names nothing runnable.
    let noChunks: string[] = [];
    let refused = runAgentAt(db, "", userText, master, { depth: 0, path: path, tracer: tracer, parentSpan: "", prior: noThread, threadId: "", excludeChunks: noChunks, modelConfigId: "", baseSeq: TURN_SEQ_NONE });
    let noNotes: string[] = [];
    // Nothing was chosen because nothing was asked: a thread that names no
    // runnable agent has no round for a choice to apply to, and remembering an
    // override against it would file a preference on a conversation that
    // cannot have one.
    let bare: ThreadReply = { run: refused, text: refused.text, baseSeq: TURN_SEQ_NONE, notes: noNotes, modelChoiceId: "", routeNote: "" };
    return bare;
  }

  // Extraction's notes, and the choice's, in the order they happened.
  let notes: string[] = [];
  // Decided and remembered before the run, because the picker's memory is not
  // the round's: a round that fails at the provider still leaves the thread
  // pointing at what was picked, and the console's Retry sends the same message
  // again — landing it on a different model than the attempt it is retrying
  // would make the failure unreproducible.
  //
  // Only when the message actually said something AND what it said survived
  // resolution. A typo must not overwrite a working pick with a dead id, and a
  // message that carried no field at all must not rewrite the memory with what
  // it merely inherited. A sent "" survives resolution as "" — it is the way
  // back to the agent's own model — so it is remembered like any other pick,
  // which is the whole of what makes the menu's last row work.
  let chosen = chooseModel(db, threadId, ask.pick);
  if (ask.pick.sent && chosen.choiceId == ask.pick.choiceId) {
    let kept = rememberChoice(db, threadId, ask.pick.choiceId);
    if (kept != "") {
      notes.push("this turn ran on the model that was chosen, but the thread could not remember it (" + kept + "), so the next message falls back to the previous choice");
    }
  }

  let held = threadTurns(db, threadId);
  // And now the half `chooseModel` could not make: if what is in force is a
  // router, one small completion decides which config answers.
  //
  // Here rather than beside `chooseModel` because it needs `held` — the router
  // is shown the last two turns, and "and shorter?" means nothing without the
  // thing it is shortening. Before `forgetRound` below only by accident of
  // reading order; what matters is that it is before `runAgentAt`, since its
  // whole job is to decide what that call runs on.
  //
  // Not a tool step and not a trace span: it is a decision ABOUT the round
  // rather than something the round did, and `runs.route_note` is where it is
  // written down. A router that fails costs this turn nothing but the note.
  chosen = routeChoice(db, { threadId: threadId, chosen: chosen, userText: userText, tail: held, master: master });

  // This round owns its seq. A round that failed stored nothing, so the count
  // below has not moved and this run reuses its number — and its dispatched
  // calls are still in the table under it. Clearing first is what keeps a
  // message's card describing the round that produced it.
  forgetRound(db, threadId, held.length);
  forgetThoughts(db, threadId, held.length);
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
  // `chosen.configId` is "" whenever nothing was chosen, which is what every
  // run before this feature passed and what run.ts reads as "the agent's own".
  let run = runAgentAt(db, agentId, userText, master, { depth: 0, path: path, tracer: tracer, parentSpan: "", prior: replayed, threadId: threadId, excludeChunks: alreadyShown, modelConfigId: chosen.configId, baseSeq: held.length });

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
  let reply: ThreadReply = { run: run, text: kept, baseSeq: held.length, notes: notes,
    modelChoiceId: chosen.choiceId, routeNote: chosen.note };
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

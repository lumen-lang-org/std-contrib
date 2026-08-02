// Threads: what is replayed, what is trimmed, and what a person sees.
//
//   cd packages/agents && lumen test threads.test.ts

import { Turn, ToolCall, toolCall, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { ModelPick, ThreadReply, ThreadListing, Naming, TITLE_MAX, TITLE_MAX_TOKENS, withinBudget, cutPoint, budgetFor, SUMMARY_MAX_CHARS, nextRound, threadBudget, threadPlan, threadsMapping, openThread, listThreads, sweepEmptyThreads, sweepIdleMs, recordChunks, chunksShownSince, appendTurns, roundIsStored, chooseModel, inheritedPick, threadChoice, threadRouteKey, rememberChoice, runInThreadWith, markReplayable, isReplayable, listReplayable, remixThread, cleanTitle, withinTitleBudget, titleFrom, threadTitle, nameThread, titlingConfigId, titleThread } from "./threads.ts";
import { workspacePlan, putFile, listFiles } from "./workspace.ts";
import { artifactPlan, putArtifact, listArtifacts, TURN_SEQ_NONE } from "./artifacts.ts";
import { stepPlan } from "./steps.ts";
import { RunRow, runsMapping, runLogPlan } from "./runlog.ts";
import { ModelRow, ModelConfigRow, ModelChoiceRow, ModelRouterRow, PromptRow, AgentRow, modelsMapping, modelConfigsMapping, modelChoicesMapping, modelRoutersMapping, promptsMapping, mcpServersMapping, agentsMapping, schemaPlan } from "./schema.ts";
import { noTracer } from "../tracing/tracing.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, dropTable, execute, executeWith, findById, persist, placeholderAt } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";

let database: Db = sqlite();

// A round: a question, an assistant turn that called a tool, the result, and
// the answer.
function round(question: string, callId: string, result: string, answer: string): Turn[] {
  let calls: ToolCall[] = [toolCall(callId, "warehouse_stock", "{}")];
  let none: ToolCall[] = [];
  let out: Turn[] = [
    userTurn(question),
    assistantTurn("", calls),
    toolTurn(callId, "warehouse_stock", result),
    assistantTurn(answer, none),
  ];
  return out;
}

function conversation(rounds: int): Turn[] {
  let out: Turn[] = [];
  let i: int = 0;
  while (i < rounds) {
    let r = round("question " + `${i}`, "c" + `${i}`, "result " + `${i}`, "answer " + `${i}`);
    let j: int = 0;
    while (j < r.length) { out.push(r[j]); j = j + 1; }
    i = i + 1;
  }
  return out;
}

test("a thread that fits is replayed whole", () => {
  let turns = conversation(3);
  expect(withinBudget(turns, 100000).length == turns.length);
});

test("trimming drops whole rounds, never half of one", () => {
  // The sharp edge: a tool turn whose assistant turn was dropped is a result
  // answering nothing, and every provider refuses the request. A thread that
  // grew too long would stop working rather than forget its beginning.
  let turns = conversation(4);
  let kept = withinBudget(turns, 60);
  expect(kept.length < turns.length);
  // Whatever survived starts a round: a user turn, not a tool result.
  expect(kept[0].role == "user");
  // And every tool turn still has an assistant turn before it.
  let i: int = 0;
  while (i < kept.length) {
    if (kept[i].role == "tool") { expect(i > 0 && kept[i - 1].role != "user"); }
    i = i + 1;
  }
});

test("the most recent round is the one kept", () => {
  // Forgetting the beginning is survivable; forgetting what was just said is
  // not what a continuing conversation means.
  let turns = conversation(4);
  let kept = withinBudget(turns, 60);
  expect(kept[0].text == "question 3" || kept[0].text == "question 2");
});

test("a round boundary is the next user turn", () => {
  let turns = conversation(2);
  // Round one is turns 0..3, so the next begins at 4.
  expect(nextRound(turns, 0) == 4);
  // Past the last round there is no next one.
  expect(nextRound(turns, 4) == turns.length);
});

test("a budget too small for even one round keeps that round rather than nothing", () => {
  // An empty replay would silently turn a thread into a series of unrelated
  // questions, which is worse than exceeding a budget by a little.
  let turns = conversation(2);
  let kept = withinBudget(turns, 1);
  expect(kept.length > 0);
  expect(kept[0].role == "user");
});

test("the budget is a number this package states", () => {
  expect(threadBudget() > 0);
});

// --- storing a round --------------------------------------------------------------

function freshThreads(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_threads_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP INDEX IF EXISTS chunks_by_thread");
  execute(database, "DROP INDEX IF EXISTS turns_by_thread");
  execute(database, "DROP TABLE IF EXISTS thread_chunks");
  execute(database, "DROP TABLE IF EXISTS thread_turns");
  execute(database, "DROP TABLE IF EXISTS threads");
  migrate(database, threadPlan(database));
}

function turnCount(threadId: string): int {
  if (!database.query("SELECT COUNT(*) FROM thread_turns WHERE thread_id = " + placeholderAt(database, 1), [threadId])) {
    return -1;
  }
  return parseInt(database.value(0, 0)) ?? -1;
}

test("a round that cannot be stored whole is not stored at all", () => {
  freshThreads();
  // Something already occupies this round's second seq — the other half of a
  // race, or a NUL byte in the tool result that PostgreSQL refuses. Whatever
  // the cause, stopping at the failure and keeping what went before leaves the
  // thread holding an assistant turn that announces a call whose tool turn
  // never arrived: the provider refuses that replay, so the conversation is
  // permanently unreplayable, and the caller is told "the round was not
  // stored", which is not true.
  executeWith(database,
    "INSERT INTO thread_turns (id, thread_id, seq, role, text, calls, call_id, tool_name) VALUES ("
    + placeholderAt(database, 1) + ", " + placeholderAt(database, 2) + ", " + placeholderAt(database, 3) + ", "
    + placeholderAt(database, 4) + ", " + placeholderAt(database, 5) + ", " + placeholderAt(database, 6) + ", "
    + placeholderAt(database, 7) + ", " + placeholderAt(database, 8) + ")",
    ["t9-1", "t9", "1", "user", "taken", "[]", "", ""]);
  expect(turnCount("t9") == 1);

  let calls: ToolCall[] = [toolCall("c1", "warehouse_stock", "{}")];
  let half: Turn[] = [assistantTurn("", calls), toolTurn("c1", "warehouse_stock", "12 pallets")];
  let problem = appendTurns(database, "t9", half, 0);
  expect(problem != "");
  // Only the row that was already there.
  expect(turnCount("t9") == 1);
});

test("a round that stores whole is all there", () => {
  freshThreads();
  let calls: ToolCall[] = [toolCall("c1", "warehouse_stock", "{}")];
  let none: ToolCall[] = [];
  let whole: Turn[] = [userTurn("how many?"), assistantTurn("", calls), toolTurn("c1", "warehouse_stock", "12"), assistantTurn("12 pallets", none)];
  expect(appendTurns(database, "t8", whole, 0) == "");
  expect(turnCount("t8") == 4);
});

test("a round nobody tried to store is not a stored round", () => {
  // `appendTurns` returns "" for success, and a round that failed before it
  // was ever called leaves that same "" behind. Read as success, the round's
  // retrieved chunk ids get filed under a seq the table does not hold — and
  // chunksShownSince then excludes them from every later retrieval in this
  // thread, permanently, while the replay never carries them.
  expect(roundIsStored(true, ""));
  expect(!roundIsStored(false, ""));
  expect(!roundIsStored(true, "invalid byte sequence for encoding \"UTF8\": 0x00"));
  expect(!roundIsStored(false, "invalid byte sequence for encoding \"UTF8\": 0x00"));
});

// --- what is abandoned, and what only looks abandoned ------------------------------

// The sweep reads five tables that five modules own, so the fixture is those
// five plans, the shipped ones. A CREATE written out here would keep passing
// while the real columns moved.
function freshSweep(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_threads_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS thread_chunks");
  execute(database, "DROP TABLE IF EXISTS thread_turns");
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, "DROP TABLE IF EXISTS workspace_files");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  execute(database, "DROP TABLE IF EXISTS thread_steps");
  execute(database, "DROP TABLE IF EXISTS run_steps");
  execute(database, "DROP TABLE IF EXISTS runs");
  // Dropped too, or the file left by a previous run keeps its `depth` column
  // and migration 63's ALTER fails — which stops the plan, so every migration
  // numbered above it silently never runs and the failure surfaces as a table
  // missing a column nobody edited.
  execute(database, "DROP TABLE IF EXISTS thread_thoughts");
  let plan = threadPlan(database);
  let files = workspacePlan(database);
  let w: int = 0;
  while (w < files.length) { plan.push(files[w]); w = w + 1; }
  let held = artifactPlan(database);
  let a: int = 0;
  while (a < held.length) { plan.push(held[a]); a = a + 1; }
  let live = stepPlan(database);
  let s: int = 0;
  while (s < live.length) { plan.push(live[s]); s = s + 1; }
  let ran = runLogPlan(database);
  let r: int = 0;
  while (r < ran.length) { plan.push(ran[r]); r = r + 1; }
  migrate(database, plan);
}

// A run row against a thread, with nothing else written: what a first round
// that failed at the provider leaves behind.
function failedRun(threadId: string, when: string): void {
  let row: RunRow = {
    id: "r-" + threadId, agentId: "a1", threadId: threadId, owner: "",
    agentName: "lead", promptVersion: 1, modelApiName: "claude-opus-5",
    question: "how many A-114 are in Lyon?", answer: "", ok: false,
    stopReason: "error", rounds: 0, error: "401 from the provider",
    inputTokens: 0, outputTokens: 0, modelChoiceId: "", routeNote: "", createdAt: when,
  };
  persist(database, runsMapping(), JSON.stringify(row));
}

test("a thread whose only content is an uploaded file is not swept", () => {
  freshSweep();
  let old = "1000000000000";
  let abandoned = openThread(database, { agentId: "a1", owner: "", now: old });
  let uploaded = openThread(database, { agentId: "a1", owner: "", now: old });
  let spoken = openThread(database, { agentId: "a1", owner: "", now: old });
  let young = openThread(database, { agentId: "a1", owner: "", now: "3000000000000" });
  putFile(database, { threadId: uploaded, fileName: "notes.md", mime: "text/markdown", origin: "uploaded", body: "dropped in, not yet asked about", documentId: "", now: old });
  let said: Turn[] = [userTurn("how many A-114 are in Lyon?")];
  expect(appendTurns(database, spoken, said, 0) == "");

  sweepEmptyThreads(database, "2000000000000");

  // The bug: a thread opened by dropping a file in holds no turn until the
  // first question is asked, so it was deleted an hour later and its
  // workspace_files rows left addressed to a thread that no longer exists.
  expect(findById(database, threadsMapping(), uploaded) != "");
  expect(listFiles(database, uploaded).length == 1);
  expect(findById(database, threadsMapping(), spoken) != "");
  expect(findById(database, threadsMapping(), young) != "");
  // And it still takes the one nobody put anything in.
  expect(findById(database, threadsMapping(), abandoned) == "");
});

test("a thread whose first round failed is not swept", () => {
  freshSweep();
  let old = "1000000000000";
  let failed = openThread(database, { agentId: "a1", owner: "", now: old });
  let abandoned = openThread(database, { agentId: "a1", owner: "", now: old });
  // A round that produced no answer is not a round, so `appendTurns` was never
  // called; a provider that never answered dispatched no tool call, so there is
  // no step row. One `runs` row is the entire trace of the failure — and the
  // person looking at it is about to press Retry.
  failedRun(failed, old);

  sweepEmptyThreads(database, "2000000000000");

  expect(findById(database, threadsMapping(), failed) != "");
  expect(findById(database, threadsMapping(), abandoned) == "");
});

test("no age configured is no sweep at all", () => {
  // The default, and the property that matters most: this engine has never
  // deleted a thread row, so an operator who sets nothing keeps every row.
  expect(sweepIdleMs("") == 0);
  expect(sweepIdleMs("   ") == 0);
  // And a typo is not a deletion policy, by the same argument `bytesCap` makes.
  expect(sweepIdleMs("1h") == 0);
  expect(sweepIdleMs("-1") == 0);
  expect(sweepIdleMs("0") == 0);
  expect(sweepIdleMs("3600000") == 3600000);
  expect(sweepIdleMs("  3600000  ") == 3600000);
});

// --- which model answers -----------------------------------------------------------

// A menu, an agent, and two providers to tell apart.
//
// The refusal is the instrument. run.ts resolves the config, then the model,
// then the provider, and only then looks for a credential — and no credential
// is stored here, so a run that never reached the network still names the
// provider it was about to call. Which model would have answered is therefore
// readable without a live key and without a fake provider, which is the same
// trick run.test.ts uses on every one of its refusals.
function seededMenu(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_threads_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  // Everything the schema plan ALTERs has to go, not only what it creates:
  // forgetMigrations makes the whole plan pending again, so a table left
  // standing means an ALTER re-adds a column that is already there, the
  // database refuses, and the plan STOPS — every migration after it silently
  // never runs. schema.test.ts's wipe drops exactly this set for that reason.
  execute(database, "DROP TABLE IF EXISTS provider_credentials");
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, modelChoicesMapping());
  dropTable(database, modelRoutersMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  // The tables later migrations ALTER, or a second run of this suite meets a
  // duplicate column, the plan stops there, and every migration above it —
  // including the ones this test needs — silently never runs.
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP TABLE IF EXISTS thread_summaries");
  execute(database, "DROP TABLE IF EXISTS plugins");
  execute(database, "DROP TABLE IF EXISTS plugin_items");
  execute(database, "DROP INDEX IF EXISTS chunks_by_thread");
  execute(database, "DROP INDEX IF EXISTS turns_by_thread");
  execute(database, "DROP TABLE IF EXISTS thread_chunks");
  execute(database, "DROP TABLE IF EXISTS thread_turns");
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, "DROP TABLE IF EXISTS thread_steps");
  execute(database, "DROP TABLE IF EXISTS thread_thoughts");

  let plan = schemaPlan(database);
  let conversations = threadPlan(database);
  let c: int = 0;
  while (c < conversations.length) { plan.push(conversations[c]); c = c + 1; }
  // The round clears its own steps and thoughts before it starts, so those two
  // tables are part of running a turn even when no tool is ever called.
  let live = stepPlan(database);
  let s: int = 0;
  while (s < live.length) { plan.push(live[s]); s = s + 1; }
  migrate(database, plan);

  let own: ModelRow = { id: "m-own", label: "The agent's own", apiName: "own-1", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  let picked: ModelRow = { id: "m-picked", label: "Thinking", apiName: "picked-1", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(own));
  persist(database, modelsMapping(), JSON.stringify(picked));

  let cOwn: ModelConfigRow = { id: "c-own", modelId: "m-own", temperature: 0.0, maxTokens: 32, topP: 1.0, extra: "{}", thinking: "", label: "Standard", selectable: true, rank: 1 };
  let cPicked: ModelConfigRow = { id: "c-picked", modelId: "m-picked", temperature: 0.0, maxTokens: 32, topP: 1.0, extra: "{}", thinking: "8192", label: "Thinking", selectable: true, rank: 2 };
  persist(database, modelConfigsMapping(database), JSON.stringify(cOwn));
  persist(database, modelConfigsMapping(database), JSON.stringify(cPicked));

  let p: PromptRow = { id: "p1", promptName: "terse", version: 1, body: "Be brief.", createdAt: "t" };
  persist(database, promptsMapping(), JSON.stringify(p));
  let a: AgentRow = { id: "a1", agentName: "docflow", description: "d", modelConfigId: "c-own", promptId: "p1", scriptImageId: "", isDefault: true, enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a));

  let standard: ModelChoiceRow = { id: "ch-own", label: "Standard", description: "the everyday one", kind: "config", configId: "c-own", routerId: "", tier: "", enabled: true, rank: 1 };
  let thinking: ModelChoiceRow = { id: "ch-picked", label: "Thinking", description: "slower, more careful", kind: "config", configId: "c-picked", routerId: "", tier: "premium", enabled: true, rank: 2 };
  let auto: ModelChoiceRow = { id: "ch-auto", label: "Auto", description: "picks for you", kind: "router", configId: "", routerId: "r1", tier: "", enabled: true, rank: 0 };
  persist(database, modelChoicesMapping(), JSON.stringify(standard));
  persist(database, modelChoicesMapping(), JSON.stringify(thinking));
  persist(database, modelChoicesMapping(), JSON.stringify(auto));
}

// The router `ch-auto` points at, written after the menu so a test can choose
// its shape. Its own config is `c-own`, so a routing call would be a mistral
// call — and there is no credential in this suite, which is what keeps every
// test below off the network.
function seedRouter(candidatesJson: string, routeEvery: string, escalateOnly: bool): void {
  let r: ModelRouterRow = {
    id: "r1", label: "Auto", routerConfigId: "c-own",
    candidatesJson: candidatesJson, fallbackConfigId: "c-picked",
    routeEvery: routeEvery, escalateOnly: escalateOnly, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(r));
}

// Two candidates in order: the cheap one first, the careful one second — which
// is the order `escalateOnly` means by "up".
function twoCandidates(): string {
  return "[{\"key\":\"fast\",\"configId\":\"c-own\",\"when\":\"greetings\"},"
    + "{\"key\":\"deep\",\"configId\":\"c-picked\",\"when\":\"a plan\"}]";
}

function testKey(): string { return "0123456789abcdef0123456789abcdef"; }

// One turn, carrying what the picker was showing when it was sent — including
// "Agent default", which is the id "" SENT rather than the field left out.
function ask(threadId: string, choiceId: string): ThreadReply {
  let said: ModelPick = { choiceId: choiceId, sent: true };
  return runInThreadWith(database, threadId, { userText: "how many A-114 are in Lyon?", master: testKey(), tracer: noTracer(), pick: said });
}

// One turn that says nothing about the model at all: every caller written
// before the picker existed, and every curl that leaves the field out.
function asks(threadId: string): ThreadReply {
  return runInThreadWith(database, threadId, { userText: "how many A-114 are in Lyon?", master: testKey(), tracer: noTracer(), pick: inheritedPick() });
}

test("a message's choice answers that turn and the thread remembers it", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  // The agent's own model is mistral's; the choice names an anthropic one.
  // Naming the provider it was about to call is how a run with no credential
  // still says which model would have answered.
  let chose = ask(id, "ch-picked");
  expect(chose.run.error.indexOf("anthropic") >= 0);
  expect(chose.modelChoiceId == "ch-picked");
  expect(chose.routeNote == "");
  // Remembered, so the composer reopens on what was last picked.
  expect(threadChoice(database, id) == "ch-picked");

  // And the next message, carrying nothing, keeps answering with it — a thread
  // is the memory of the last override.
  let again = asks(id);
  expect(again.run.error.indexOf("anthropic") >= 0);
  expect(again.modelChoiceId == "ch-picked");
});

test("the message outranks the thread, and the thread outranks the agent", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  // Nothing chosen: the agent's own, which is what every thread written before
  // the menu existed means.
  expect(asks(id).run.error.indexOf("mistral") >= 0);

  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);
  // The thread now says anthropic and this message says otherwise. The message
  // wins, and the memory moves with it — one act, not two.
  let back = ask(id, "ch-own");
  expect(back.run.error.indexOf("mistral") >= 0);
  expect(back.modelChoiceId == "ch-own");
  expect(threadChoice(database, id) == "ch-own");
});

test("an unknown choice runs anyway, on the agent's own", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);

  // A run that would have happened must still happen. Silently to the person
  // typing — the answer arrives on the agent's own model rather than not at
  // all — and written down for whoever reads the log.
  let typo = ask(id, "ch-thinkng");
  expect(typo.run.error.indexOf("mistral") >= 0);
  // Nothing was in force, so the run row names no choice: a row claiming
  // "Thinking" answered when it did not is worse than one claiming nothing.
  expect(typo.modelChoiceId == "");
  expect(typo.routeNote.indexOf("ch-thinkng") >= 0);
  expect(typo.routeNote.indexOf("not in the menu") >= 0);
  // And the typo did not overwrite the working pick: the next message keeps
  // answering with what was actually chosen.
  expect(threadChoice(database, id) == "ch-picked");
  expect(asks(id).run.error.indexOf("anthropic") >= 0);
});

test("a choice retired after it was picked falls back, and comes back if it is re-enabled", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);

  // The operator takes the row out of the menu. Somebody's thread still points
  // at it, and that thread must not stop working.
  execute(database, "UPDATE model_choices SET enabled = 0 WHERE id = 'ch-picked'");
  let after = asks(id);
  expect(after.run.error.indexOf("mistral") >= 0);
  expect(after.modelChoiceId == "");
  expect(after.routeNote.indexOf("ch-picked") >= 0);
  // The memory is left alone rather than cleared, so putting the row back puts
  // the conversation back too.
  expect(threadChoice(database, id) == "ch-picked");
  execute(database, "UPDATE model_choices SET enabled = 1 WHERE id = 'ch-picked'");
  expect(asks(id).run.error.indexOf("anthropic") >= 0);
});

test("a router choice actually routes, and lands its run on the fallback when the call cannot be made", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  // The wiring this asserts is the one that was missing: `chooseModel` resolves
  // a router row to "the agent's own, and here is why", and `routeChoice` is
  // what turns that into a decision. Without the call between them, "Auto" —
  // the LEAD row of the menu — ran the agent's own model on every turn while
  // reporting that nothing had routed.
  //
  // There is no credential here, so the routing completion refuses before it
  // opens a socket and every path lands on `fallbackConfigId`. That is c-picked,
  // an anthropic row, where the AGENT's own is mistral — so which provider the
  // run names is the proof that the fallback and not the agent answered.
  let auto = ask(id, "ch-auto");
  expect(auto.run.error.indexOf("anthropic") >= 0);
  expect(auto.modelChoiceId == "ch-auto");
  expect(auto.routeNote.indexOf("fell back") >= 0);
  // The picker goes on showing "Auto": the choice is what a person picked, the
  // route note is what happened underneath it.
  expect(threadChoice(database, id) == "ch-auto");
  // And nothing was ratcheted. A fallback picked no candidate, so recording one
  // would let a dead provider move a floor nobody routed to.
  expect(threadRouteKey(database, id) == "");
});

test("a router with one candidate answers without a call, and the thread remembers where it got to", () => {
  seededMenu();
  // `routeTurn` refuses to spend a completion on a list of one, which is the
  // only way this suite can watch a decision that did NOT fall back — there is
  // no credential anywhere in it.
  seedRouter("[{\"key\":\"deep\",\"configId\":\"c-picked\",\"when\":\"anything\"}]", "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  let auto = ask(id, "ch-auto");
  expect(auto.run.error.indexOf("anthropic") >= 0);
  expect(auto.routeNote.indexOf("routed to deep") >= 0);
  // The column migration 85.1 adds, written. Before it existed `previousKey`
  // had no source at all: `escalateOnly` could never impose a floor and
  // `routeEvery: "thread"` was unimplementable, because nothing recorded that a
  // conversation had already routed.
  expect(threadRouteKey(database, id) == "deep");
});

test("routeEvery \"thread\" pays once and reuses what the conversation already routed to", () => {
  seededMenu();
  seedRouter(twoCandidates(), "thread", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  // As if a previous turn had routed here. The reuse path makes no completion
  // at all, which is the whole point of the setting — one extra call per turn
  // is small but not free, and a deployment may would rather pay once.
  executeWith(database, "UPDATE threads SET route_key = 'deep' WHERE id = " + placeholderAt(database, 1), [id]);
  let again = ask(id, "ch-auto");
  expect(again.run.error.indexOf("anthropic") >= 0);
  expect(again.routeNote.indexOf("already routed") >= 0);
  expect(again.routeNote.indexOf("fell back") < 0);

  // A key the operator has since taken out of the list imposes nothing: the
  // thread is pointing at a position that no longer exists, so the turn routes
  // afresh — and with no credential, falls back.
  executeWith(database, "UPDATE threads SET route_key = 'gone' WHERE id = " + placeholderAt(database, 1), [id]);
  expect(ask(id, "ch-auto").routeNote.indexOf("fell back") >= 0);
});

test("a router row deleted under a live menu entry is a sentence, not a dead conversation", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  execute(database, "DELETE FROM model_routers WHERE id = 'r1'");
  let auto = ask(id, "ch-auto");
  // A run that would have happened still happens — on the agent's own model,
  // because there is no fallback to read once the row naming it is gone.
  expect(auto.run.error.indexOf("mistral") >= 0);
  expect(auto.modelChoiceId == "ch-auto");
  expect(auto.routeNote.indexOf("r1") >= 0);
});

test("the menu's last row is reachable: a sent \"\" clears the thread's memory", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);
  expect(threadChoice(database, id) == "ch-picked");

  // "Agent default" in the composer sends the id "". Read as "the caller said
  // nothing" it would inherit — and the thread would answer on Thinking for
  // ever, with no value the wire could carry to get back. It is a statement,
  // so it stands and it is remembered.
  let back = ask(id, "");
  expect(back.run.error.indexOf("mistral") >= 0);
  expect(back.modelChoiceId == "");
  expect(threadChoice(database, id) == "");
  // And it stays cleared for the next message, which is the half that made the
  // picker look broken: reopening the conversation showed Thinking again.
  expect(asks(id).run.error.indexOf("mistral") >= 0);

  // A message that carries no field at all still inherits, which is every
  // request written before the picker existed.
  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);
  expect(asks(id).run.error.indexOf("anthropic") >= 0);
  expect(threadChoice(database, id) == "ch-picked");
});

test("a chosen config that is gone is refused by name, not answered by something else", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  // The asymmetry configForChoice states: an unknown CHOICE falls back, a
  // choice whose target CONFIG was deleted does not. Answering on the agent's
  // own here would leave "Thinking" quietly not thinking, with nothing to read
  // anywhere; the refusal is a sentence somebody can act on.
  execute(database, "DELETE FROM model_configs WHERE id = 'c-picked'");
  let broken = ask(id, "ch-picked");
  expect(!broken.run.ok);
  expect(broken.run.error.indexOf("no model config c-picked") >= 0);
});

test("resolution is a function, and it answers before anything is run", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  // Nothing chosen anywhere: no choice, no config, nothing to say about it.
  let none = chooseModel(database, id, inheritedPick());
  expect(none.choiceId == "" && none.configId == "" && none.note == "");

  let message = chooseModel(database, id, { choiceId: "ch-picked", sent: true });
  expect(message.choiceId == "ch-picked" && message.configId == "c-picked");

  // Resolution does NOT remember: the message's turn does, once, and a helper
  // that wrote as a side effect of being asked would move the thread every
  // time anything wanted to know what was chosen.
  expect(threadChoice(database, id) == "");
  expect(rememberChoice(database, id, "ch-picked") == "");
  expect(threadChoice(database, id) == "ch-picked");
  expect(chooseModel(database, id, inheritedPick()).configId == "c-picked");

  // A thread that is not there has nothing chosen and does not invent one.
  expect(chooseModel(database, "no-such-thread", inheritedPick()).choiceId == "");
});

// --- naming a conversation ---------------------------------------------------------

// The pure half first: no database, no provider. What titling gets wrong is
// never the HTTP call — it is what a 400-character apology looks like in a
// sidebar, and none of that needs a network to exercise.

test("a title is cut to sixty characters, whatever the model sent", () => {
  // The cap the sidebar is sized for, and the one property every case below
  // shares: nothing longer than TITLE_MAX is ever handed back.
  let essay = "Certainly! Here is a name for this conversation about warehouse stock levels in Lyon and Rotterdam";
  let cut = cleanTitle(essay);
  expect(cut.length <= TITLE_MAX);
  expect(cut.endsWith("..."));

  // The boundary is exact rather than off by the three dots: sixty characters
  // is kept whole, sixty-one is clipped.
  let sixty = "123456789012345678901234567890123456789012345678901234567890";
  expect(sixty.length == TITLE_MAX);
  expect(cleanTitle(sixty) == sixty);
  expect(cleanTitle(sixty + "1").length == TITLE_MAX);
});

test("a title is one line, unquoted, unprefixed and unpunctuated", () => {
  // Each of these is a thing a model actually does when it is asked for a name.
  expect(cleanTitle("  Lyon stock levels  ") == "Lyon stock levels");
  expect(cleanTitle("\"Lyon stock levels\"") == "Lyon stock levels");
  expect(cleanTitle("'Lyon stock levels'") == "Lyon stock levels");
  expect(cleanTitle("Title: Lyon stock levels") == "Lyon stock levels");
  expect(cleanTitle("Title: \"Lyon stock levels\"") == "Lyon stock levels");
  expect(cleanTitle("Lyon stock levels.") == "Lyon stock levels");
  // Newlines flattened and the whitespace they leave behind collapsed — a
  // title with a line break in it is a sidebar row that is two rows tall.
  expect(cleanTitle("Lyon stock\nlevels") == "Lyon stock levels");
  expect(cleanTitle("Lyon\n\n  stock   levels") == "Lyon stock levels");
  // A marker the model parroted out of an earlier turn loses the bracket that
  // makes it one, so no client's marker pass can read a title as a card for a
  // file nobody wrote.
  expect(cleanTitle("[artifact:abc:1@v2] plan").indexOf("[artifact:") < 0);
  // And anything that cleans away to nothing is nothing, never a blank row.
  expect(cleanTitle("") == "");
  expect(cleanTitle("   \n  ") == "");
  expect(cleanTitle("\"\"") == "");
  expect(cleanTitle(".") == "");
});

test("the naming call is capped whatever config it lands on", () => {
  // A config pointed at cheap work by mistake must not let "explain at length"
  // bill an essay per new conversation. The seed's own router config shared a
  // row with a chat choice at 8192 once, which is the whole argument.
  let roomy: ModelConfigRow = { id: "c-big", modelId: "m1", temperature: 0.0, maxTokens: 8192, topP: 1.0, extra: "{}", thinking: "8192", label: "Thinking", selectable: true, rank: 1 };
  let capped = withinTitleBudget(roomy);
  expect(capped.maxTokens == TITLE_MAX_TOKENS);
  // `thinking` goes with the ceiling rather than being left behind: an
  // Anthropic budget is clamped to maxTokens - 1, so 8192 thinking tokens
  // under this ceiling is a request below the provider's own floor and a 400
  // on every attempt.
  expect(capped.thinking == "");
  // Everything else is the operator's and is left alone.
  expect(capped.id == "c-big" && capped.modelId == "m1" && capped.label == "Thinking");
});

test("a reply is read for its assistant text and never handed back as an envelope", () => {
  // The live failure `answerFrom` was written for, one function over:
  // `Completion.text` is the provider's RAW BODY, and a reader that falls back
  // to the body when it finds no assistant text puts an envelope in somebody's
  // sidebar.
  let openai = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Lyon stock levels\"},\"finish_reason\":\"stop\"}]}";
  expect(titleFrom("openai", openai).title == "Lyon stock levels");
  expect(titleFrom("openai", openai).note == "");

  let anthropic = "{\"content\":[{\"type\":\"text\",\"text\":\"Lyon stock levels\"}],\"stop_reason\":\"end_turn\"}";
  expect(titleFrom("anthropic", anthropic).title == "Lyon stock levels");

  // The exact live shape: truncated, so `content` is null and there is no
  // assistant text to find. No title, a note naming the ceiling, and the body
  // itself nowhere in it.
  let cut = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":null},\"finish_reason\":\"length\"}]}";
  let truncated: Naming = titleFrom("openai", cut);
  expect(truncated.title == "");
  expect(truncated.note.indexOf("ran out of room") >= 0);
  expect(truncated.note.indexOf("choices") < 0);

  // A shape with no assistant text in it at all is quoted, briefly, for
  // whoever is debugging a provider — and is never a title.
  let strange = titleFrom("openai", "{\"error\":{\"message\":\"model not found\"}}");
  expect(strange.title == "");
  expect(strange.note != "");
});

// --- and the half that needs the database ------------------------------------------

test("migration 88 adds the column, and every thread already there is untitled", () => {
  freshThreads();
  let plan = threadPlan(database);
  let found = false;
  let i: int = 0;
  while (i < plan.length) {
    if (plan[i].version == "88") { found = true; }
    i = i + 1;
  }
  expect(found);

  // A row written the way every row was written before the column existed.
  // NOT NULL DEFAULT '' is what keeps the read a `title != ""` test rather
  // than a NULL-versus-empty archaeology exercise.
  executeWith(database,
    "INSERT INTO threads (id, agent_id, created_at) VALUES ("
    + placeholderAt(database, 1) + ", " + placeholderAt(database, 2) + ", " + placeholderAt(database, 3) + ")",
    ["t-old", "a1", "1000000000000"]);
  expect(threadTitle(database, "t-old") == "");
  // And a thread that is not there answers the same, rather than inventing one.
  expect(threadTitle(database, "no-such-thread") == "");
});

test("a thread is named once and is never renamed", () => {
  freshThreads();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(threadTitle(database, id) == "");

  expect(nameThread(database, id, "Lyon stock levels") == "");
  expect(threadTitle(database, id) == "Lyon stock levels");

  // The never-re-titled guarantee, and it is in the UPDATE's WHERE rather than
  // in a read-then-write, because two first messages racing on one fresh
  // thread both pass a read-then-write. The loser matches no row and says so
  // by saying nothing.
  expect(nameThread(database, id, "Something else entirely") == "");
  expect(threadTitle(database, id) == "Lyon stock levels");

  // Text that cleans away to nothing is refused rather than stored: "" is the
  // column's word for "unnamed", and writing one would take the first-message
  // fallback away without putting anything in its place.
  let blank = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(nameThread(database, blank, "   \n  ") == "");
  expect(threadTitle(database, blank) == "");

  // The writer caps too, so a caller that has its own idea of a title cannot
  // get past TITLE_MAX by not knowing about it.
  let long = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  nameThread(database, long, "Certainly! Here is a name for this conversation about warehouse stock in Lyon");
  expect(threadTitle(database, long).length <= TITLE_MAX);
});

test("the sidebar prefers the name, and keeps every fallback it had", () => {
  freshSweep();
  let named = openThread(database, { agentId: "a1", owner: "", now: "1000000000003" });
  let spoken = openThread(database, { agentId: "a1", owner: "", now: "1000000000002" });
  let uploaded = openThread(database, { agentId: "a1", owner: "", now: "1000000000001" });

  let asked: Turn[] = [userTurn("how many A-114 are in Lyon?")];
  expect(appendTurns(database, named, asked, 0) == "");
  expect(appendTurns(database, spoken, asked, 0) == "");
  expect(nameThread(database, named, "Lyon stock levels") == "");
  putArtifact(database, { threadId: uploaded, path: "/plan.md", title: "Plan", content: "a plan", note: "", origin: "uploaded", mustCreate: true, turnSeq: TURN_SEQ_NONE, now: "1000000000001" });

  let rows: ThreadListing[] = listThreads(database, { tags: [], limit: 50, offset: 0 });
  expect(rows.length == 3);
  let i: int = 0;
  while (i < rows.length) {
    // The column when there is one; otherwise exactly what the sidebar showed
    // before this feature existed — the first thing the user said, and the
    // file's own name for a thread opened by dropping one in.
    if (rows[i].id == named) { expect(rows[i].title == "Lyon stock levels"); }
    if (rows[i].id == spoken) { expect(rows[i].title == "how many A-114 are in Lyon?"); }
    if (rows[i].id == uploaded) { expect(rows[i].title == "/plan.md"); }
    i = i + 1;
  }
});

test("the cheap config is the router's, then the menu's first, then nothing", () => {
  seededMenu();
  // `AGENTS_TITLE_CONFIG_ID` is not exercised here: this suite cannot set a
  // variable the process read at start-up. What it can pin is the rule that
  // matters more — every step falls THROUGH, so a box that offers nothing is a
  // box that names nothing rather than a box that fails.

  // A router on the menu, and its own config is the deployment's cheap-work
  // row: MODEL-CHOICE.md defines router_config_id as "small, fast, cheap", and
  // 87.10 built exactly that kind of non-menu plumbing config.
  let cheap: ModelRouterRow = {
    id: "r1", label: "Auto", routerConfigId: "c-picked",
    candidatesJson: twoCandidates(), fallbackConfigId: "c-own",
    routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(cheap));
  expect(titlingConfigId(database) == "c-picked");

  // Switched off, and the rule becomes "the first config in rank order", which
  // is the same rule migration 87.22 already reads as "the cheapest thing
  // available is the right default". This is the single-model box's path.
  execute(database, "UPDATE model_routers SET enabled = 0 WHERE id = 'r1'");
  expect(titlingConfigId(database) == "c-own");

  // A menu row pointing at a router row that is gone falls through the same
  // way rather than stopping the walk.
  execute(database, "DELETE FROM model_routers WHERE id = 'r1'");
  expect(titlingConfigId(database) == "c-own");

  // Nothing offered at all, so nothing is named and the thread keeps today's
  // behaviour.
  execute(database, "DELETE FROM model_choices");
  expect(titlingConfigId(database) == "");
});

test("a naming call that cannot be made leaves the thread untitled and says so", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });

  // There is no credential in this suite, so the completion refuses before it
  // opens a socket. This is the load-bearing property of the whole feature:
  // every failure path leaves the column at "" and hands back a sentence for
  // the run log, and nothing anywhere branches on it.
  let note = titleThread(database, { threadId: id, userText: "how many A-114 are in Lyon?", master: testKey() });
  expect(note != "");
  expect(note.indexOf("could not be named") >= 0);
  // Named by provider, which is what an operator can act on.
  expect(note.indexOf("mistral") >= 0);
  expect(threadTitle(database, id) == "");

  // A thread that already has a name never pays for a completion, and says
  // nothing about it: the cheap read is the first line of the function.
  expect(nameThread(database, id, "Lyon stock levels") == "");
  expect(titleThread(database, { threadId: id, userText: "how many A-114 are in Lyon?", master: testKey() }) == "");
  expect(threadTitle(database, id) == "Lyon stock levels");

  // And a box with no menu is not a box with a bug.
  execute(database, "DELETE FROM model_choices");
  let bare = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(titleThread(database, { threadId: bare, userText: "how many A-114 are in Lyon?", master: testKey() }) == "");
  expect(threadTitle(database, bare) == "");
});

test("a first round that failed leaves the thread unnamed, and the turn is unaffected", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });

  // No credential, so the round dies at the provider. Nothing was stored, so
  // nothing is named — which is deliberate rather than incidental: the
  // generated title and the first-message fallback are kept over the same set
  // of threads, so the sidebar shows what it showed today and the console's
  // Retry is what names the conversation.
  let first = asks(id);
  expect(!first.run.ok);
  expect(threadTitle(database, id) == "");
  // The turn is exactly what it was before titling existed: the round's own
  // note, and nothing the naming attempt added.
  expect(first.notes.length > 0);
  expect(first.notes[0].indexOf("the round was not stored") >= 0);
});

// --- what a round showed, and what the next may fetch ------------------------------

test("chunks are recorded per round and read back from a boundary", () => {
  freshThreads();

  let first: string[] = ["plume_0", "plume_1"];
  let second: string[] = ["rest_0"];
  recordChunks(database, "t1", 0, first);
  recordChunks(database, "t1", 4, second);

  // From the start, everything is excluded.
  expect(chunksShownSince(database, "t1", 0).length == 3);
  // From round two's boundary, round one's chunks were trimmed away with
  // their turns and may come back.
  let since = chunksShownSince(database, "t1", 4);
  expect(since.length == 1);
  expect(since[0] == "rest_0");
  // Another thread's chunks are not this one's.
  expect(chunksShownSince(database, "t2", 0).length == 0);
  database.close();
});


test("a long title is cut on a character boundary, not in the middle of one", () => {
  // TITLE_MAX is a byte count, and Arabic is two bytes a letter — so a title
  // that is well under 60 CHARACTERS is over the cap, and the naive slice
  // lands mid-character and stores a broken one. The defect is invisible in
  // English, which is exactly why it needs a test written in something else.
  let arabic = "";
  let i: int = 0;
  // The literal character, not a \u escape: the escape is not expanded here,
  // so it would build 360 bytes of ASCII and test nothing about UTF-8.
  while (i < 60) { arabic = arabic + "م"; i = i + 1; }   // 60 x 2 bytes
  let cut = cleanTitle(arabic);
  expect(cut.length <= TITLE_MAX);
  expect(cut.endsWith("..."));
  // The body before the dots must end on a COMPLETE character. Arabic meem is
  // 0xD9 0x85, so a whole one ends on its continuation byte (0x85 = 133); a
  // cut that split a character would leave the lead byte 0xD9 (217) dangling,
  // which is the broken value this test exists to catch.
  let body = cut.slice(0, cut.length - 3);
  let last = body.charCodeAt(body.length - 1);
  expect(last == 133);
});


// --- offered as a starting point ----------------------------------------------------

test("a conversation is private until it is offered, and offering it is one field", () => {
  freshThreads();
  let id = openThread(database, { agentId: "a1", owner: "alice", now: "1000000000000" });
  // The default is the security property: every thread that exists, and every
  // one opened after the migration, is private until somebody says otherwise.
  expect(!isReplayable(database, id));
  expect(listReplayable(database, 20).length == 0);

  expect(markReplayable(database, id, true) == "");
  expect(isReplayable(database, id));
  expect(listReplayable(database, 20).length == 1);

  // And it goes back. An offer that could not be withdrawn would make marking
  // one irreversible, which is not a thing to learn by trying it.
  expect(markReplayable(database, id, false) == "");
  expect(!isReplayable(database, id));
  expect(listReplayable(database, 20).length == 0);
});

test("a remix copies the files, under the new owner, and leaves the source alone", () => {
  freshThreads();
  let source = openThread(database, { agentId: "a1", owner: "alice", now: "1000000000000" });
  putArtifact(database, { threadId: source, path: "/plan.md", title: "Plan",
    content: "# the plan", note: "", origin: "generated", mustCreate: false,
    turnSeq: TURN_SEQ_NONE, now: "1000000000000" });
  markReplayable(database, source, true);

  let made = remixThread(database, { sourceId: source, owner: "bob", now: "1000000000001" });
  expect(made.problem == "");
  expect(made.threadId != "" && made.threadId != source);
  expect(made.files == 1);

  // Bob's copy is Bob's: the row carries his tag, not Alice's, which is what
  // makes it his to edit and hers to keep.
  let mine = findById(database, threadsMapping(), made.threadId);
  let row: ThreadRow = JSON.parse<ThreadRow>(mine);
  expect(row.owner == "bob");
  // The copy is not itself on offer. Marking is a decision its new owner makes.
  expect(!row.replayable);

  // The file came across at version 1 — its own history starts here.
  let copied = listArtifacts(database, made.threadId);
  expect(copied.length == 1);
  expect(copied[0].path == "/plan.md");
  expect(copied[0].currentVersion == 1);

  // And Alice still has exactly what she had.
  expect(listArtifacts(database, source).length == 1);
});

test("what falls out of the replay is summarised, not silently dropped", () => {
  freshThreads();
  // A budget small enough that the first rounds cannot fit, and a thread of
  // four rounds to push against it.
  let turns: Turn[] = [];
  let filler = "";
  let f: int = 0;
  while (f < 400) { filler = filler + "long ago we agreed the port is 8100. "; f = f + 1; }
  turns.push(userTurn("Round one: " + filler));
  turns.push(assistantTurn("Noted.", []));
  turns.push(userTurn("Round two: " + filler));
  turns.push(assistantTurn("Also noted.", []));
  turns.push(userTurn("Round three, the recent one."));

  // Where the cut lands is a round boundary, never mid-round: a tool result
  // whose call is gone is a request every provider refuses.
  let cut = cutPoint(turns, 20000);
  expect(cut > 0);
  expect(turns[cut].role == "user");
});

test("a model's own context decides how much it is shown", () => {
  let small: ModelRow = { id: "m-small", label: "Small", apiName: "s", provider: "mistral",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 8192 };
  let big: ModelRow = { id: "m-big", label: "Big", apiName: "b", provider: "mistral",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 200000 };
  let unknown: ModelRow = { id: "m-?", label: "Unsaid", apiName: "u", provider: "mistral",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  let cfg: ModelConfigRow = { id: "c", modelId: "m", temperature: 0, maxTokens: 4096, topP: 1,
    extra: "", thinking: "", label: "", selectable: true, rank: 0 };

  // The answer's own allowance and the prompt's overhead come off the top —
  // a 32k model handed 28k of history plus a system prompt is the 400 this
  // arithmetic exists to prevent.
  expect(budgetFor(small, cfg) < budgetFor(big, cfg));
  // 8192 - 4096 of answer - 9000 of overhead is already negative: the floor
  // holds it at 2000 tokens and the round either fits or fails honestly. A
  // budget that goes to nothing would trim every thread to its last message
  // and call it memory.
  expect(budgetFor(small, cfg) == 6000);
  let roomy: ModelConfigRow = { id: "c", modelId: "m", temperature: 0, maxTokens: 1024, topP: 1,
    extra: "", thinking: "", label: "", selectable: true, rank: 0 };
  // 8192 - 1024 of answer - 9000 of overhead is negative, so the floor holds
  // it: a model this small cannot carry a conversation AND this deployment's
  // tool schemas, and pretending otherwise is the refused round again.
  expect(budgetFor(small, roomy) == 6000);
  // A model that never said falls back to the flat budget rather than
  // guessing high: guessing low costs a shorter memory, guessing high costs
  // a refused request.
  expect(budgetFor(unknown, cfg) == 100000);
});

test("a summary is bounded, whatever the summariser answers", () => {
  // A small model handed a repetitive transcript echoes it back — one wrote
  // 40,000 characters of "the quick brown fox" — and storing that would put
  // the very bulk compaction exists to remove into every future round.
  expect(SUMMARY_MAX_CHARS < 2000);
});

test("a conversation nobody offered cannot be remixed, however the id was found", () => {
  freshThreads();
  let private_ = openThread(database, { agentId: "a1", owner: "alice", now: "1000000000000" });
  putArtifact(database, { threadId: private_, path: "/secret.md", title: "Secret",
    content: "not for you", note: "", origin: "generated", mustCreate: false,
    turnSeq: TURN_SEQ_NONE, now: "1000000000000" });

  // The whole security property in one assertion: knowing the id is not
  // permission. The flag is checked inside remixThread, beside the read it
  // authorises, so no caller can forget to check it first.
  let tried = remixThread(database, { sourceId: private_, owner: "bob", now: "1000000000001" });
  expect(tried.threadId == "");
  expect(tried.problem.indexOf("not offered") >= 0);

  // A thread that does not exist says so rather than opening an empty one.
  let missing = remixThread(database, { sourceId: "no-such-thread", owner: "bob", now: "1000000000001" });
  expect(missing.threadId == "");
  expect(missing.problem.indexOf("no conversation") >= 0);
});

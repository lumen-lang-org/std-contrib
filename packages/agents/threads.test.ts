// Threads: what is replayed, what is trimmed, and what a person sees.
//
//   cd packages/agents && lumen test threads.test.ts

import { Turn, ToolCall, toolCall, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { ModelPick, ThreadReply, withinBudget, nextRound, threadBudget, threadPlan, threadsMapping, openThread, sweepEmptyThreads, sweepIdleMs, recordChunks, chunksShownSince, appendTurns, roundIsStored, chooseModel, inheritedPick, threadChoice, threadRouteKey, rememberChoice, runInThreadWith } from "./threads.ts";
import { workspacePlan, putFile, listFiles } from "./workspace.ts";
import { artifactPlan } from "./artifacts.ts";
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

  let own: ModelRow = { id: "m-own", label: "The agent's own", apiName: "own-1", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  let picked: ModelRow = { id: "m-picked", label: "Thinking", apiName: "picked-1", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
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

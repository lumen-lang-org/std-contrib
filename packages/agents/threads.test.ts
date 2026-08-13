import { Turn, ToolCall, toolCall, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { ModelPick, ThreadReply, ThreadListing, Naming, TITLE_MAX, TITLE_MAX_TOKENS, withinBudget, cutPoint, budgetFor, SUMMARY_MAX_CHARS, nextRound, threadBudget, threadPlan, threadsMapping, openThread, listThreads, sweepEmptyThreads, sweepIdleMs, recordChunks, chunksShownSince, appendTurns, roundIsStored, chooseModel, inheritedPick, threadChoice, threadRouteKey, rememberChoice, runInThreadWith, markReplayable, isReplayable, listReplayable, remixThread, cleanTitle, withinTitleBudget, titleFrom, threadTitle, threadMessageRows, nameThread, titlingConfigId, titleThread } from "./threads.ts";
import { workspacePlan, putFile, listFiles } from "./workspace.ts";
import { projectsPlan } from "./projects.ts";
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
    while (j < r.length) {
      out.push(r[j]);
      j = j + 1;
    }
    i = i + 1;
  }
  return out;
}

test("a thread that fits is replayed whole", () => {
  let turns = conversation(3);
  expect(withinBudget(turns, 100000).length == turns.length);
});

test("trimming drops whole rounds, never half of one", () => {
  let turns = conversation(4);
  let kept = withinBudget(turns, 60);
  expect(kept.length < turns.length);
  expect(kept[0].role == "user");
  let i: int = 0;
  while (i < kept.length) {
    if (kept[i].role == "tool") {
      expect(i > 0 && kept[i - 1].role != "user");
    }
    i = i + 1;
  }
});

test("the most recent round is the one kept", () => {
  let turns = conversation(4);
  let kept = withinBudget(turns, 60);
  expect(kept[0].text == "question 3" || kept[0].text == "question 2");
});

test("a round boundary is the next user turn", () => {
  let turns = conversation(2);
  expect(nextRound(turns, 0) == 4);
  expect(nextRound(turns, 4) == turns.length);
});

test("a budget too small for even one round keeps that round rather than nothing", () => {
  let turns = conversation(2);
  let kept = withinBudget(turns, 1);
  expect(kept.length > 0);
  expect(kept[0].role == "user");
});

test("the budget is a number this package states", () => {
  expect(threadBudget() > 0);
});

function freshThreads(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_threads_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP INDEX IF EXISTS chunks_by_thread");
  execute(database, "DROP INDEX IF EXISTS turns_by_thread");
  execute(database, "DROP TABLE IF EXISTS thread_chunks");
  execute(database, "DROP TABLE IF EXISTS thread_turns");
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, "DROP TABLE IF EXISTS projects");
  let plan = threadPlan(database);
  let grouped = projectsPlan(database);
  let g: int = 0;
  while (g < grouped.length) {
    plan.push(grouped[g]);
    g = g + 1;
  }
  migrate(database, plan);
}

function turnCount(threadId: string): int {
  if (!database.query("SELECT COUNT(*) FROM thread_turns WHERE thread_id = " + placeholderAt(database, 1), [threadId])) {
    return -1;
  }
  return parseInt(database.value(0, 0)) ?? -1;
}

test("a round that cannot be stored whole is not stored at all", () => {
  freshThreads();
  executeWith(database,
    "INSERT INTO thread_turns (id, thread_id, seq, role, text, calls, call_id, tool_name) VALUES ("
    + placeholderAt(database, 1) + ", " + placeholderAt(database, 2) + ", " + placeholderAt(database, 3) + ", "
    + placeholderAt(database, 4) + ", " + placeholderAt(database, 5) + ", " + placeholderAt(database, 6) + ", "
    + placeholderAt(database, 7) + ", " + placeholderAt(database, 8) + ")",
    ["t9-1", "t9", "1", "user", "taken", "[]", "", ""]);
  expect(turnCount("t9") == 1);

  let calls: ToolCall[] = [toolCall("c1", "warehouse_stock", "{}")];
  let half: Turn[] = [assistantTurn("", calls), toolTurn("c1", "warehouse_stock", "12 pallets")];
  let fault = appendTurns(database, "t9", half, 0);
  expect(fault != "");
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
  expect(roundIsStored(true, ""));
  expect(!roundIsStored(false, ""));
  expect(!roundIsStored(true, "invalid byte sequence for encoding \"UTF8\": 0x00"));
  expect(!roundIsStored(false, "invalid byte sequence for encoding \"UTF8\": 0x00"));
});

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
  execute(database, "DROP TABLE IF EXISTS thread_thoughts");
  execute(database, "DROP TABLE IF EXISTS projects");
  let plan = threadPlan(database);
  let files = workspacePlan(database);
  let w: int = 0;
  while (w < files.length) {
    plan.push(files[w]);
    w = w + 1;
  }
  let held = artifactPlan(database);
  let a: int = 0;
  while (a < held.length) {
    plan.push(held[a]);
    a = a + 1;
  }
  let live = stepPlan(database);
  let s: int = 0;
  while (s < live.length) {
    plan.push(live[s]);
    s = s + 1;
  }
  let ran = runLogPlan(database);
  let r: int = 0;
  while (r < ran.length) {
    plan.push(ran[r]);
    r = r + 1;
  }
  let grouped = projectsPlan(database);
  let g: int = 0;
  while (g < grouped.length) {
    plan.push(grouped[g]);
    g = g + 1;
  }
  migrate(database, plan);
}

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
  putFile(database, {
    threadId: uploaded,
    fileName: "notes.md",
    mime: "text/markdown",
    origin: "uploaded",
    body: "dropped in, not yet asked about",
    documentId: "",
    now: old,
  });
  let said: Turn[] = [userTurn("how many A-114 are in Lyon?")];
  expect(appendTurns(database, spoken, said, 0) == "");

  sweepEmptyThreads(database, "2000000000000");

  expect(findById(database, threadsMapping(), uploaded) != "");
  expect(listFiles(database, uploaded).length == 1);
  expect(findById(database, threadsMapping(), spoken) != "");
  expect(findById(database, threadsMapping(), young) != "");
  expect(findById(database, threadsMapping(), abandoned) == "");
});

test("a thread whose first round failed is not swept", () => {
  freshSweep();
  let old = "1000000000000";
  let failed = openThread(database, { agentId: "a1", owner: "", now: old });
  let abandoned = openThread(database, { agentId: "a1", owner: "", now: old });
  failedRun(failed, old);

  sweepEmptyThreads(database, "2000000000000");

  expect(findById(database, threadsMapping(), failed) != "");
  expect(findById(database, threadsMapping(), abandoned) == "");
});

test("no age configured is no sweep at all", () => {
  expect(sweepIdleMs("") == 0);
  expect(sweepIdleMs("   ") == 0);
  expect(sweepIdleMs("1h") == 0);
  expect(sweepIdleMs("-1") == 0);
  expect(sweepIdleMs("0") == 0);
  expect(sweepIdleMs("3600000") == 3600000);
  expect(sweepIdleMs("  3600000  ") == 3600000);
});

function seededMenu(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_threads_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
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
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP TABLE IF EXISTS thread_summaries");
  execute(database, "DROP TABLE IF EXISTS plugins");
  execute(database, "DROP TABLE IF EXISTS plugin_items");
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS discover_stories");
  execute(database, "DROP TABLE IF EXISTS discover_feeds");
  execute(database, "DROP TABLE IF EXISTS card_plugins");
  execute(database, "DROP TABLE IF EXISTS card_cases");
  execute(database, "DROP TABLE IF EXISTS tool_cards");
  execute(database, "DROP TABLE IF EXISTS agent_web_rag");
  execute(database, "DROP INDEX IF EXISTS chunks_by_thread");
  execute(database, "DROP INDEX IF EXISTS turns_by_thread");
  execute(database, "DROP TABLE IF EXISTS thread_chunks");
  execute(database, "DROP TABLE IF EXISTS thread_turns");
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, "DROP TABLE IF EXISTS thread_steps");
  execute(database, "DROP TABLE IF EXISTS thread_thoughts");
  execute(database, "DROP TABLE IF EXISTS projects");

  let plan = schemaPlan(database);
  let conversations = threadPlan(database);
  let c: int = 0;
  while (c < conversations.length) {
    plan.push(conversations[c]);
    c = c + 1;
  }
  let live = stepPlan(database);
  let s: int = 0;
  while (s < live.length) {
    plan.push(live[s]);
    s = s + 1;
  }
  let grouped = projectsPlan(database);
  let g: int = 0;
  while (g < grouped.length) {
    plan.push(grouped[g]);
    g = g + 1;
  }
  migrate(database, plan);

  let own: ModelRow = {
    id: "m-own",
    label: "The agent's own",
    apiName: "own-1",
    provider: "mistral",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  let picked: ModelRow = {
    id: "m-picked",
    label: "Thinking",
    apiName: "picked-1",
    provider: "anthropic",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(own));
  persist(database, modelsMapping(), JSON.stringify(picked));

  let cOwn: ModelConfigRow = {
    id: "c-own",
    modelId: "m-own",
    temperature: 0.0,
    maxTokens: 32,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "Standard",
    selectable: true,
    rank: 1,
  };
  let cPicked: ModelConfigRow = {
    id: "c-picked",
    modelId: "m-picked",
    temperature: 0.0,
    maxTokens: 32,
    topP: 1.0,
    extra: "{}",
    thinking: "8192",
    label: "Thinking",
    selectable: true,
    rank: 2,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(cOwn));
  persist(database, modelConfigsMapping(database), JSON.stringify(cPicked));

  let p: PromptRow = {
    id: "p1",
    promptName: "terse",
    version: 1,
    body: "Be brief.",
    createdAt: "t",
  };
  persist(database, promptsMapping(), JSON.stringify(p));
  let a: AgentRow = {
    id: "a1",
    agentName: "docflow",
    description: "d",
    modelConfigId: "c-own",
    promptId: "p1",
    scriptImageId: "",
    isDefault: true,
    enabled: true,
    updatedAt: "t",
  };
  persist(database, agentsMapping(), JSON.stringify(a));

  let standard: ModelChoiceRow = {
    id: "ch-own",
    label: "Standard",
    description: "the everyday one",
    kind: "config",
    configId: "c-own",
    routerId: "",
    tier: "",
    enabled: true,
    rank: 1,
  };
  let thinking: ModelChoiceRow = {
    id: "ch-picked",
    label: "Thinking",
    description: "slower, more careful",
    kind: "config",
    configId: "c-picked",
    routerId: "",
    tier: "premium",
    enabled: true,
    rank: 2,
  };
  let auto: ModelChoiceRow = {
    id: "ch-auto",
    label: "Auto",
    description: "picks for you",
    kind: "router",
    configId: "",
    routerId: "r1",
    tier: "",
    enabled: true,
    rank: 0,
  };
  persist(database, modelChoicesMapping(), JSON.stringify(standard));
  persist(database, modelChoicesMapping(), JSON.stringify(thinking));
  persist(database, modelChoicesMapping(), JSON.stringify(auto));
}

function seedRouter(candidatesJson: string, routeEvery: string, escalateOnly: bool): void {
  let r: ModelRouterRow = {
    id: "r1", label: "Auto", routerConfigId: "c-own",
    candidatesJson: candidatesJson, fallbackConfigId: "c-picked",
    routeEvery: routeEvery, escalateOnly: escalateOnly, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(r));
}

function twoCandidates(): string {
  return "[{\"key\":\"fast\",\"configId\":\"c-own\",\"when\":\"greetings\"},"
    + "{\"key\":\"deep\",\"configId\":\"c-picked\",\"when\":\"a plan\"}]";
}

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function ask(threadId: string, choiceId: string): ThreadReply {
  let said: ModelPick = { choiceId: choiceId, sent: true };
  return runInThreadWith(database, threadId, {
    userText: "how many A-114 are in Lyon?",
    master: testKey(),
    tracer: noTracer(),
    pick: said,
    think: false,
    scope: "",
  });
}

function asks(threadId: string): ThreadReply {
  return runInThreadWith(database, threadId, {
    userText: "how many A-114 are in Lyon?",
    master: testKey(),
    tracer: noTracer(),
    pick: inheritedPick(),
    think: false,
    scope: "",
  });
}

test("a message's choice answers that turn and the thread remembers it", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  let chose = ask(id, "ch-picked");
  expect(chose.run.error.indexOf("anthropic") >= 0);
  expect(chose.modelChoiceId == "ch-picked");
  expect(chose.routeNote == "");
  expect(threadChoice(database, id) == "ch-picked");

  let again = asks(id);
  expect(again.run.error.indexOf("anthropic") >= 0);
  expect(again.modelChoiceId == "ch-picked");
});

test("the message outranks the thread, and the thread outranks the agent", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(asks(id).run.error.indexOf("mistral") >= 0);

  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);
  let back = ask(id, "ch-own");
  expect(back.run.error.indexOf("mistral") >= 0);
  expect(back.modelChoiceId == "ch-own");
  expect(threadChoice(database, id) == "ch-own");
});

test("an unknown choice runs anyway, on the agent's own", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);

  let typo = ask(id, "ch-thinkng");
  expect(typo.run.error.indexOf("mistral") >= 0);
  expect(typo.modelChoiceId == "");
  expect(typo.routeNote.indexOf("ch-thinkng") >= 0);
  expect(typo.routeNote.indexOf("not in the menu") >= 0);
  expect(threadChoice(database, id) == "ch-picked");
  expect(asks(id).run.error.indexOf("anthropic") >= 0);
});

test("a choice retired after it was picked falls back, and comes back if it is re-enabled", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);

  execute(database, "UPDATE model_choices SET enabled = 0 WHERE id = 'ch-picked'");
  let after = asks(id);
  expect(after.run.error.indexOf("mistral") >= 0);
  expect(after.modelChoiceId == "");
  expect(after.routeNote.indexOf("ch-picked") >= 0);
  expect(threadChoice(database, id) == "ch-picked");
  execute(database, "UPDATE model_choices SET enabled = 1 WHERE id = 'ch-picked'");
  expect(asks(id).run.error.indexOf("anthropic") >= 0);
});

test("a router choice actually routes, and lands its run on the fallback when the call cannot be made", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  let auto = ask(id, "ch-auto");
  expect(auto.run.error.indexOf("anthropic") >= 0);
  expect(auto.modelChoiceId == "ch-auto");
  expect(auto.routeNote.indexOf("fell back") >= 0);
  expect(threadChoice(database, id) == "ch-auto");
  expect(threadRouteKey(database, id) == "");
});

test("a router with one candidate answers without a call, and the thread remembers where it got to", () => {
  seededMenu();
  seedRouter("[{\"key\":\"deep\",\"configId\":\"c-picked\",\"when\":\"anything\"}]", "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  let auto = ask(id, "ch-auto");
  expect(auto.run.error.indexOf("anthropic") >= 0);
  expect(auto.routeNote.indexOf("routed to deep") >= 0);
  expect(threadRouteKey(database, id) == "deep");
});

test("routeEvery \"thread\" pays once and reuses what the conversation already routed to", () => {
  seededMenu();
  seedRouter(twoCandidates(), "thread", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  executeWith(database, "UPDATE threads SET route_key = 'deep' WHERE id = " + placeholderAt(database, 1), [id]);
  let again = ask(id, "ch-auto");
  expect(again.run.error.indexOf("anthropic") >= 0);
  expect(again.routeNote.indexOf("already routed") >= 0);
  expect(again.routeNote.indexOf("fell back") < 0);

  executeWith(database, "UPDATE threads SET route_key = 'gone' WHERE id = " + placeholderAt(database, 1), [id]);
  expect(ask(id, "ch-auto").routeNote.indexOf("fell back") >= 0);
});

test("a router row deleted under a live menu entry is a sentence, not a dead conversation", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  execute(database, "DELETE FROM model_routers WHERE id = 'r1'");
  let auto = ask(id, "ch-auto");
  expect(auto.run.error.indexOf("mistral") >= 0);
  expect(auto.modelChoiceId == "ch-auto");
  expect(auto.routeNote.indexOf("r1") >= 0);
});

test("the menu's last row is reachable: a sent \"\" clears the thread's memory", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);
  expect(threadChoice(database, id) == "ch-picked");

  let back = ask(id, "");
  expect(back.run.error.indexOf("mistral") >= 0);
  expect(back.modelChoiceId == "");
  expect(threadChoice(database, id) == "");
  expect(asks(id).run.error.indexOf("mistral") >= 0);

  expect(ask(id, "ch-picked").run.error.indexOf("anthropic") >= 0);
  expect(asks(id).run.error.indexOf("anthropic") >= 0);
  expect(threadChoice(database, id) == "ch-picked");
});

test("a chosen config that is gone is refused by name, not answered by something else", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  execute(database, "DELETE FROM model_configs WHERE id = 'c-picked'");
  let broken = ask(id, "ch-picked");
  expect(!broken.run.ok);
  expect(broken.run.error.indexOf("no model config c-picked") >= 0);
});

test("resolution is a function, and it answers before anything is run", () => {
  seededMenu();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  let none = chooseModel(database, id, inheritedPick());
  expect(none.choiceId == "" && none.configId == "" && none.note == "");

  let message = chooseModel(database, id, { choiceId: "ch-picked", sent: true });
  expect(message.choiceId == "ch-picked" && message.configId == "c-picked");

  expect(threadChoice(database, id) == "");
  expect(rememberChoice(database, id, "ch-picked") == "");
  expect(threadChoice(database, id) == "ch-picked");
  expect(chooseModel(database, id, inheritedPick()).configId == "c-picked");

  expect(chooseModel(database, "no-such-thread", inheritedPick()).choiceId == "");
});

test("a title is cut to sixty characters, whatever the model sent", () => {
  let essay = "Certainly! Here is a name for this conversation about warehouse stock levels in Lyon and Rotterdam";
  let cut = cleanTitle(essay);
  expect(cut.length <= TITLE_MAX);
  expect(cut.endsWith("..."));

  let sixty = "123456789012345678901234567890123456789012345678901234567890";
  expect(sixty.length == TITLE_MAX);
  expect(cleanTitle(sixty) == sixty);
  expect(cleanTitle(sixty + "1").length == TITLE_MAX);
});

test("a title is one line, unquoted, unprefixed and unpunctuated", () => {
  expect(cleanTitle("  Lyon stock levels  ") == "Lyon stock levels");
  expect(cleanTitle("\"Lyon stock levels\"") == "Lyon stock levels");
  expect(cleanTitle("'Lyon stock levels'") == "Lyon stock levels");
  expect(cleanTitle("Title: Lyon stock levels") == "Lyon stock levels");
  expect(cleanTitle("Title: \"Lyon stock levels\"") == "Lyon stock levels");
  expect(cleanTitle("Lyon stock levels.") == "Lyon stock levels");
  expect(cleanTitle("Lyon stock\nlevels") == "Lyon stock levels");
  expect(cleanTitle("Lyon\n\n  stock   levels") == "Lyon stock levels");
  expect(cleanTitle("[artifact:abc:1@v2] plan").indexOf("[artifact:") < 0);
  expect(cleanTitle("") == "");
  expect(cleanTitle("   \n  ") == "");
  expect(cleanTitle("\"\"") == "");
  expect(cleanTitle(".") == "");
});

test("the naming call is capped whatever config it lands on", () => {
  let roomy: ModelConfigRow = {
    id: "c-big",
    modelId: "m1",
    temperature: 0.0,
    maxTokens: 8192,
    topP: 1.0,
    extra: "{}",
    thinking: "8192",
    label: "Thinking",
    selectable: true,
    rank: 1,
  };
  let capped = withinTitleBudget(roomy);
  expect(capped.maxTokens == TITLE_MAX_TOKENS);
  expect(capped.thinking == "");
  expect(capped.id == "c-big" && capped.modelId == "m1" && capped.label == "Thinking");
});

test("a reply is read for its assistant text and never handed back as an envelope", () => {
  let openai = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Lyon stock levels\"},\"finish_reason\":\"stop\"}]}";
  expect(titleFrom("openai", openai).title == "Lyon stock levels");
  expect(titleFrom("openai", openai).note == "");

  let anthropic = "{\"content\":[{\"type\":\"text\",\"text\":\"Lyon stock levels\"}],\"stop_reason\":\"end_turn\"}";
  expect(titleFrom("anthropic", anthropic).title == "Lyon stock levels");

  let cut = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":null},\"finish_reason\":\"length\"}]}";
  let truncated: Naming = titleFrom("openai", cut);
  expect(truncated.title == "");
  expect(truncated.note.indexOf("ran out of room") >= 0);
  expect(truncated.note.indexOf("choices") < 0);

  let strange = titleFrom("openai", "{\"error\":{\"message\":\"model not found\"}}");
  expect(strange.title == "");
  expect(strange.note != "");
});

test("migration 88 adds the column, and every thread already there is untitled", () => {
  freshThreads();
  let plan = threadPlan(database);
  let found = false;
  let i: int = 0;
  while (i < plan.length) {
    if (plan[i].version == "88") {
      found = true;
    }
    i = i + 1;
  }
  expect(found);

  executeWith(database,
    "INSERT INTO threads (id, agent_id, created_at) VALUES ("
    + placeholderAt(database, 1) + ", " + placeholderAt(database, 2) + ", " + placeholderAt(database, 3) + ")",
    ["t-old", "a1", "1000000000000"]);
  expect(threadTitle(database, "t-old") == "");
  expect(threadTitle(database, "no-such-thread") == "");
});

test("a thread is named once and is never renamed", () => {
  freshThreads();
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(threadTitle(database, id) == "");

  expect(nameThread(database, id, "Lyon stock levels") == "");
  expect(threadTitle(database, id) == "Lyon stock levels");

  expect(nameThread(database, id, "Something else entirely") == "");
  expect(threadTitle(database, id) == "Lyon stock levels");

  let blank = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(nameThread(database, blank, "   \n  ") == "");
  expect(threadTitle(database, blank) == "");

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
  putArtifact(database, {
    threadId: uploaded,
    path: "/plan.md",
    title: "Plan",
    content: "a plan",
    note: "",
    origin: "uploaded",
    mustCreate: true,
    turnSeq: TURN_SEQ_NONE,
    now: "1000000000001",
  });

  let rows: ThreadListing[] = listThreads(database, {
    tags: [],
    limit: 50,
    offset: 0,
    project: "",
  });
  expect(rows.length == 3);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].id == named) {
      expect(rows[i].title == "Lyon stock levels");
    }
    if (rows[i].id == spoken) {
      expect(rows[i].title == "how many A-114 are in Lyon?");
    }
    if (rows[i].id == uploaded) {
      expect(rows[i].title == "/plan.md");
    }
    i = i + 1;
  }
});

test("the cheap config is the router's, then the menu's first, then nothing", () => {
  seededMenu();

  let cheap: ModelRouterRow = {
    id: "r1", label: "Auto", routerConfigId: "c-picked",
    candidatesJson: twoCandidates(), fallbackConfigId: "c-own",
    routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  persist(database, modelRoutersMapping(), JSON.stringify(cheap));
  expect(titlingConfigId(database) == "c-picked");

  execute(database, "UPDATE model_routers SET enabled = 0 WHERE id = 'r1'");
  expect(titlingConfigId(database) == "c-own");

  execute(database, "DELETE FROM model_routers WHERE id = 'r1'");
  expect(titlingConfigId(database) == "c-own");

  execute(database, "DELETE FROM model_choices");
  expect(titlingConfigId(database) == "");
});

test("a naming call that cannot be made leaves the thread untitled and says so", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });

  let note = titleThread(database, {
    threadId: id,
    userText: "how many A-114 are in Lyon?",
    master: testKey(),
  });
  expect(note != "");
  expect(note.indexOf("could not be named") >= 0);
  expect(note.indexOf("mistral") >= 0);
  expect(threadTitle(database, id) == "");

  expect(nameThread(database, id, "Lyon stock levels") == "");
  expect(titleThread(database, {
    threadId: id,
    userText: "how many A-114 are in Lyon?",
    master: testKey(),
  }) == "");
  expect(threadTitle(database, id) == "Lyon stock levels");

  execute(database, "DELETE FROM model_choices");
  let bare = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });
  expect(titleThread(database, {
    threadId: bare,
    userText: "how many A-114 are in Lyon?",
    master: testKey(),
  }) == "");
  expect(threadTitle(database, bare) == "");
});

test("a first round that failed leaves the thread unnamed, and the turn is unaffected", () => {
  seededMenu();
  seedRouter(twoCandidates(), "turn", false);
  let id = openThread(database, { agentId: "a1", owner: "", now: "1000000000000" });

  let first = asks(id);
  expect(!first.run.ok);
  expect(threadTitle(database, id) == "");
  expect(first.notes.length > 0);
  expect(first.notes[0].indexOf("the round was not stored") >= 0);
});

test("chunks are recorded per round and read back from a boundary", () => {
  freshThreads();

  let first: string[] = ["plume_0", "plume_1"];
  let second: string[] = ["rest_0"];
  recordChunks(database, "t1", 0, first);
  recordChunks(database, "t1", 4, second);

  expect(chunksShownSince(database, "t1", 0).length == 3);
  let since = chunksShownSince(database, "t1", 4);
  expect(since.length == 1);
  expect(since[0] == "rest_0");
  expect(chunksShownSince(database, "t2", 0).length == 0);
  database.close();
});


test("a long title is cut on a character boundary, not in the middle of one", () => {
  let arabic = "";
  let i: int = 0;
  while (i < 60) {
    arabic = arabic + "م";
    i = i + 1;
  }
  let cut = cleanTitle(arabic);
  expect(cut.length <= TITLE_MAX);
  expect(cut.endsWith("..."));
  let body = cut.slice(0, cut.length - 3);
  let last = body.charCodeAt(body.length - 1);
  expect(last == 133);
});


test("a conversation is private until it is offered, and offering it is one field", () => {
  freshThreads();
  let id = openThread(database, { agentId: "a1", owner: "alice", now: "1000000000000" });
  expect(!isReplayable(database, id));
  expect(listReplayable(database, 20).length == 0);

  expect(markReplayable(database, id, true) == "");
  expect(isReplayable(database, id));
  expect(listReplayable(database, 20).length == 1);

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
  expect(made.fault == "");
  expect(made.threadId != "" && made.threadId != source);
  expect(made.files == 1);

  let mine = findById(database, threadsMapping(), made.threadId);
  let row: ThreadRow = JSON.parse<ThreadRow>(mine);
  expect(row.owner == "bob");
  expect(!row.replayable);

  let copied = listArtifacts(database, made.threadId);
  expect(copied.length == 1);
  expect(copied[0].path == "/plan.md");
  expect(copied[0].currentVersion == 1);

  expect(listArtifacts(database, source).length == 1);
});

test("a remix carries the transcript and the name, because that is what was offered", () => {
  freshThreads();
  let source = openThread(database, { agentId: "a1", owner: "alice", now: "1000000000000" });
  let prepared: Turn[] = [
    userTurn("Set up a React app with Vite and TypeScript, and serve it."),
    assistantTurn("It is running, and the panel beside this conversation is showing it.", []),
  ];
  appendTurns(database, source, prepared, 0);
  nameThread(database, source, "React");
  markReplayable(database, source, true);

  let made = remixThread(database, { sourceId: source, owner: "bob", now: "1000000000001" });
  expect(made.fault == "");
  expect(made.turns == 2);

  let copied = threadMessageRows(database, made.threadId);
  expect(copied.length == 2);
  expect(copied[0].role == "user");
  expect(copied[0].text.startsWith("Set up a React app"));
  expect(copied[1].role == "assistant");
  // Numbered from zero under the new thread, or the next round written into it
  // collides with a seq the source happened to use.
  expect(copied[0].seq == 0 && copied[1].seq == 1);

  let mine = findById(database, threadsMapping(), made.threadId);
  let row: ThreadRow = JSON.parse<ThreadRow>(mine);
  expect(row.title == "React");
  expect(!row.replayable);
});

test("what falls out of the replay is summarised, not silently dropped", () => {
  freshThreads();
  let turns: Turn[] = [];
  let filler = "";
  let f: int = 0;
  while (f < 400) {
    filler = filler + "long ago we agreed the port is 8100. ";
    f = f + 1;
  }
  turns.push(userTurn("Round one: " + filler));
  turns.push(assistantTurn("Noted.", []));
  turns.push(userTurn("Round two: " + filler));
  turns.push(assistantTurn("Also noted.", []));
  turns.push(userTurn("Round three, the recent one."));

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

  expect(budgetFor(small, cfg) < budgetFor(big, cfg));
  expect(budgetFor(small, cfg) == 6000);
  let roomy: ModelConfigRow = { id: "c", modelId: "m", temperature: 0, maxTokens: 1024, topP: 1,
    extra: "", thinking: "", label: "", selectable: true, rank: 0 };
  expect(budgetFor(small, roomy) == 6000);
  expect(budgetFor(unknown, cfg) == 100000);
});

test("a summary is bounded, whatever the summariser answers", () => {
  expect(SUMMARY_MAX_CHARS < 2000);
});

test("a conversation nobody offered cannot be remixed, however the id was found", () => {
  freshThreads();
  let private_ = openThread(database, { agentId: "a1", owner: "alice", now: "1000000000000" });
  putArtifact(database, { threadId: private_, path: "/secret.md", title: "Secret",
    content: "not for you", note: "", origin: "generated", mustCreate: false,
    turnSeq: TURN_SEQ_NONE, now: "1000000000000" });

  let tried = remixThread(database, { sourceId: private_, owner: "bob", now: "1000000000001" });
  expect(tried.threadId == "");
  expect(tried.fault.indexOf("not offered") >= 0);

  let missing = remixThread(database, {
    sourceId: "no-such-thread",
    owner: "bob",
    now: "1000000000001",
  });
  expect(missing.threadId == "");
  expect(missing.fault.indexOf("no conversation") >= 0);
});

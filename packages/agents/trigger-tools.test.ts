// The bot verbs, without a bot: naming, gating, the window's arithmetic, and
// the sentence a person gets back. The live half is a phone.
//
//   cd packages/agents && lumen test trigger-tools.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, dropTable, persist } from "../plume/plume.ts";
import { Migration, forgetMigrations, migrate } from "../plume/migrate.ts";
import { triggersPlan, triggerBotsMapping, triggerInboxMapping, triggerOutboxMapping, triggerPendingMapping, TriggerBotRow } from "./triggers.ts";
import { workflowsPlan, workflowsMapping, WorkflowRow } from "./workflow-store.ts";
import { TriggerToolCall, callTriggerTool, triggerTools } from "./trigger-tools.ts";

let database: Db = sqlite();
let ready = false;
const NOW: number = 1786124262180.0;

function db(): Db {
  if (!ready) {
    let cfg: DbConfig = { filename: "/tmp/agents_trigger_tools_test.db" };
    connectDatabase(database, cfg);
    forgetMigrations(database);
    dropTable(database, workflowsMapping());
    dropTable(database, triggerBotsMapping());
    // Every table the plan creates: a file-backed db remembers, and a CREATE
    // that hits a survivor aborts the plan half-done.
    dropTable(database, triggerInboxMapping());
    dropTable(database, triggerOutboxMapping());
    dropTable(database, triggerPendingMapping());
    // One plan, the api.ts way: plume refuses a second plan whose numbers
    // sort below history the first one wrote.
    let plan: Migration[] = [];
    let a = workflowsPlan(database);
    let i: int = 0;
    while (i < a.length) { plan.push(a[i]); i = i + 1; }
    let b = triggersPlan(database);
    i = 0;
    while (i < b.length) { plan.push(b[i]); i = i + 1; }
    migrate(database, plan);
    seed();
    ready = true;
  }
  return database;
}

function seed(): void {
  let flow: WorkflowRow = {
    id: "wf1", owner: "o1", agentId: "a1", modelChoiceId: "",
    name: "Linear over Telegram", description: "", graph: "{}",
    kind: "manual", cronExpr: "", tz: "", nextAt: "", runningSince: "",
    enabled: true, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, publishedGraph: "{}", publishedAt: "1", createdAt: "1", updatedAt: "1",
  };
  persist(database, workflowsMapping(), JSON.stringify(flow));
  let bot: TriggerBotRow = {
    id: "b1", owner: "o1", kind: "telegram", name: "Echo bot",
    workflowId: "wf1", credentialRef: "telegram:b1", offset: "0",
    leaseBy: "", leaseUntil: "", enabled: true,
    runsToday: 3, dayStartedAt: `${NOW - 1000.0}`, lastAt: "", lastError: "",
    draftUntil: "", createdAt: "1", updatedAt: "1",
  };
  persist(database, triggerBotsMapping(), JSON.stringify(bot));
}

type Said = { handled: bool, ok: bool, text: string };

function call(owner: string, name: string, args: string): Said {
  let asked: TriggerToolCall = { owner: owner, name: name, args: args, nowMs: NOW };
  let got = callTriggerTool(db(), asked);
  let out: Said = { handled: got.handled, ok: got.ok, text: got.text };
  return out;
}

test("three names answer, and nothing else does", () => {
  expect(triggerTools().length == 3);
  expect(!call("o1", "schedule_task", "{}").handled);
  expect(call("o1", "list_bots", "{}").handled);
});

test("the list names the workflow, not its id", () => {
  let out = call("o1", "list_bots", "{}");
  expect(out.ok);
  expect(out.text.includes("Echo bot"));
  expect(out.text.includes("Linear over Telegram"));
  expect(out.text.includes("3 run(s) today"));
});

test("pause and resume are one field, said back as one word", () => {
  let paused = call("o1", "change_bot", "{\"bot\":\"Echo bot\",\"enabled\":false}");
  expect(paused.ok);
  expect(paused.text.startsWith("Paused."));
  let resumed = call("o1", "change_bot", "{\"bot\":\"b1\",\"enabled\":true}");
  expect(resumed.ok);
  expect(resumed.text.startsWith("On."));
});

test("the test window opens with its warning and closes on zero", () => {
  let opened = call("o1", "test_bot_draft", "{\"bot\":\"Echo bot\",\"minutes\":5}");
  expect(opened.ok);
  expect(opened.text.includes("EVERY message"));
  expect(opened.text.includes("reverts by itself"));
  let listed = call("o1", "list_bots", "{}");
  expect(listed.text.includes("TESTING THE DRAFT"));
  let shut = call("o1", "test_bot_draft", "{\"bot\":\"Echo bot\",\"minutes\":0}");
  expect(shut.ok);
  expect(shut.text.includes("published version again"));
});

test("somebody else's bots are invisible, and nobody's are refused", () => {
  let strangers = call("o2", "list_bots", "{}");
  expect(strangers.ok);
  expect(strangers.text.includes("No bots yet"));
  // The shared gate's own rule: guests are refused; a bare "" is only
  // refused where the proxy is trusted, which a test box is not.
  let guest = call("guest:abc", "list_bots", "{}");
  expect(!guest.ok);
});

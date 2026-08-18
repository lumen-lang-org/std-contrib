import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, createTableSql, execute, persist } from "../plume/plume.ts";
import { WorkflowRunRow, dayBegan, runsToday, workflowRunsMapping } from "./workflow-store.ts";

// The counter, without a scheduler or a provider: a table of runs and a clock
// the test hands in.
let database: Db = sqlite();
let opened = false;

function fresh(): Db {
  if (!opened) {
    let file = "/tmp/agents_workflow_cap_test.db";
    if (fs.existsSync(file)) {
      fs.rmSync(file, false);
    }
    let cfg: DbConfig = { filename: file };
    connectDatabase(database, cfg);
    opened = true;
  }
  execute(database, "DROP TABLE IF EXISTS workflow_runs");
  execute(database, createTableSql(database, workflowRunsMapping()));
  return database;
}

function ran(db: Db, owner: string, at: number, id: string): void {
  let row: WorkflowRunRow = {
    id: id, workflowId: "w1", owner: owner, status: "ok", input: "",
    answer: "", error: "", threadId: "", steps: "[]",
    startedAt: `${at}`, endedAt: `${at}`,
  };
  persist(db, workflowRunsMapping(), JSON.stringify(row));
}

test("a day begins at midnight UTC, whatever hour it is", () => {
  let noon: number = 1787040000000.0;
  expect(dayBegan(noon) <= noon);
  expect(noon - dayBegan(noon) < 86400000.0);
  expect(dayBegan(dayBegan(noon)) == dayBegan(noon));
});

test("runs are counted per owner, and only today's", () => {
  let db = fresh();
  let now: number = 1787040000000.0;
  let began = dayBegan(now);
  ran(db, "ann", began + 1000.0, "r1");
  ran(db, "ann", began + 2000.0, "r2");
  ran(db, "bob", began + 3000.0, "r3");
  // Yesterday's, which no longer counts against her.
  ran(db, "ann", began - 5000.0, "r4");

  expect(runsToday(db, "ann", now) == 2);
  expect(runsToday(db, "bob", now) == 1);
  expect(runsToday(db, "nobody", now) == 0);
});

test("a failed run counts too — it was started, and it was paid for", () => {
  let db = fresh();
  let now: number = 1787040000000.0;
  let began = dayBegan(now);
  ran(db, "ann", began + 10.0, "r1");
  let row: WorkflowRunRow = {
    id: "r2", workflowId: "w1", owner: "ann", status: "failed", input: "",
    answer: "", error: "the provider said no", threadId: "", steps: "[]",
    startedAt: `${began + 20.0}`, endedAt: `${began + 30.0}`,
  };
  persist(db, workflowRunsMapping(), JSON.stringify(row));
  expect(runsToday(db, "ann", now) == 2);
});

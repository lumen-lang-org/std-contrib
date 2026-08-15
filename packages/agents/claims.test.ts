import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist } from "../plume/plume.ts";
import { Migration, forgetMigrations, migrate } from "../plume/migrate.ts";
import { TaskRow, claimDue, tasksMapping, tasksPlan } from "./tasks.ts";
import { WorkflowRow, claimDueWorkflow, workflowsMapping, workflowsPlan } from "./workflow-store.ts";
import { TriggerInboxRow, claimMessage, triggerInboxMapping, triggersPlan } from "./triggers.ts";
import { indexingPlan } from "./indexing.ts";
import { JobRepository } from "./routes/knowledge/jobs/job.repository.ts";

// The four claims are the only way work leaves a queue: a due task, a due
// workflow, a message a bot has taken, a document waiting to be indexed. Each
// is an UPDATE ... WHERE id = (SELECT ... LIMIT 1 <lock>) RETURNING ..., and
// each answers an empty row when its statement does not run — which is exactly
// what an empty queue looks like, so a claim that cannot parse is a scheduler
// that finds nothing to do and says nothing about it.
//
// What that cost, precisely, since the commit that fixed it (9bda48d) said
// more than it should have: every caller of these four — scheduler.ts and
// indexer.ts — opens postgres() itself and gives up if it cannot, so no
// deployment was running them on sqlite and no production queue stalled. What
// the literal " FOR UPDATE SKIP LOCKED" did cost is this file: the claims
// could not be exercised on the driver the suite runs on, which is why they
// had no test at all and why the shape survived unnoticed.
//
// A plan per database file, because migrate orders versions as text and "106"
// sorts below "99".

const NOW: number = 1786093200000.0;

let database: Db = sqlite();

function seeded(file: string, plan: Migration[]): void {
  let cfg: DbConfig = { filename: file };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  migrate(database, plan);
}

test("a task that is due is claimed, not read as an empty queue", () => {
  seeded("/tmp/agents_claims_tasks.db", tasksPlan(database));
  let row: TaskRow = {
    id: "t1", owner: "o1", agentId: "a1", modelChoiceId: "",
    title: "Morning check", instruction: "say something",
    kind: "every", cronExpr: "0 0 8 * * *", tz: "UTC",
    nextAt: `${NOW - 60000.0}`, runningSince: "",
    enabled: true, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, createdAt: "1", updatedAt: "1",
  };
  persist(database, tasksMapping(), JSON.stringify(row));

  let got = claimDue(database, NOW);
  expect(got.id == "t1");
  expect(got.instruction == "say something");

  // And the claim holds: the second pass of the same minute takes nothing.
  expect(claimDue(database, NOW).id == "");
});

test("a workflow that is due is claimed", () => {
  seeded("/tmp/agents_claims_workflows.db", workflowsPlan(database));
  let row: WorkflowRow = {
    id: "w1", owner: "o1", agentId: "a1", modelChoiceId: "",
    name: "Morning brief", description: "",
    graph: "{\"nodes\":[],\"edges\":[],\"view\":{\"x\":0.0,\"y\":0.0,\"zoom\":1.0}}",
    kind: "every", cronExpr: "0 0 8 * * *", tz: "UTC",
    nextAt: `${NOW - 60000.0}`, runningSince: "",
    enabled: true, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, publishedGraph: "", publishedAt: "", createdAt: "1", updatedAt: "1",
  };
  persist(database, workflowsMapping(), JSON.stringify(row));

  let got = claimDueWorkflow(database, NOW);
  expect(got.id == "w1");
  expect(claimDueWorkflow(database, NOW).id == "");
});

test("a message a bot has taken is claimed for its run", () => {
  seeded("/tmp/agents_claims_triggers.db", triggersPlan(database));
  let msg: TriggerInboxRow = {
    id: "m1", owner: "o1", botId: "b1", workflowId: "w1", updateId: "77",
    chatId: "c1", input: "hello", status: "queued", threadId: "",
    fileName: "", fileBody: "", speaker: "",
    runId: "", answer: "", error: "",
    createdAt: `${NOW}`, updatedAt: `${NOW}`,
  };
  persist(database, triggerInboxMapping(), JSON.stringify(msg));

  let took = claimMessage(database, NOW);
  expect(took.id == "m1");
  expect(took.input == "hello");
  expect(claimMessage(database, NOW).id == "");
});

test("a document waiting to be indexed is claimed", () => {
  seeded("/tmp/agents_claims_jobs.db", indexingPlan(database));
  let jobs = new JobRepository(database);
  let id = jobs.enqueue("/specs/plume.md", "/specs", "e1", "some text", `${NOW}`);
  expect(id != "");

  let claimed = jobs.claimNext(`${NOW}`);
  expect(claimed.id == id);
  expect(claimed.source == "/specs/plume.md");
  expect(jobs.claimNext(`${NOW}`).id == "");
});

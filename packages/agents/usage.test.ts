// What a tenant has used, and whose numbers it is.
//
// The route this backs is the one a control plane bills from, so the two
// things asked here are the two that would cost real money to get wrong: a
// sum must not include somebody else's rows, and it must not wrap.
//
//   cd packages/agents && lumen test usage.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, executeWith, placeholderAt } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { TURN_SEQ_NONE, artifactPlan, putArtifact } from "./artifacts.ts";
import { threadPlan, openThread } from "./threads.ts";
import { projectsPlan } from "./projects.ts";
import { runLogPlan, recordRun } from "./runlog.ts";
import { AgentRun, AgentStep } from "./run.ts";
import { Turn } from "./provider.ts";
import { Retrieved } from "./knowledge.ts";
import { RecordedSpan } from "../tracing/tracing.ts";
import { ownerUsage, usageJson, runsSince, utcDayStartText, secondsToUtcMidnight, nextUtcMidnightIso } from "./usage.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_usage_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS artifact_versions");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  execute(database, "DROP TABLE IF EXISTS thread_thoughts");
  execute(database, "DROP TABLE IF EXISTS thread_steps");
  execute(database, "DROP TABLE IF EXISTS thread_chunks");
  execute(database, "DROP TABLE IF EXISTS thread_turns");
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, "DROP TABLE IF EXISTS run_steps");
  execute(database, "DROP TABLE IF EXISTS runs");
  // 103 ALTERs projects: left standing, the second run of this fixture meets
  // a duplicate files_thread_id and the plan stops there.
  execute(database, "DROP TABLE IF EXISTS projects");
  // Three plans, not sorted between them — `migrate` orders a plan itself, the
  // same way api.ts hands it eleven of these end to end.
  let plan = threadPlan(database);
  let results = artifactPlan(database);
  let r: int = 0;
  while (r < results.length) { plan.push(results[r]); r = r + 1; }
  let runs = runLogPlan(database);
  let n: int = 0;
  while (n < runs.length) { plan.push(runs[n]); n = n + 1; }
  // The threads mapping carries project_id, whose ALTER rides projectsPlan —
  // without it every openThread below is a column short.
  let grouped = projectsPlan(database);
  let g: int = 0;
  while (g < grouped.length) { plan.push(grouped[g]); g = g + 1; }
  migrate(database, plan);
}

function spentRun(input: int, output: int): AgentRun {
  let steps: AgentStep[] = [];
  let context: Turn[] = [];
  let notes: string[] = [];
  let names: string[] = [];
  let passages: Retrieved[] = [];
  let spans: RecordedSpan[] = [];
  let r: AgentRun = {
    ok: true, text: "done", body: "{}", status: 200,
    agentName: "lead", promptVersion: 1, modelApiName: "claude-opus-5",
    inputTokens: input, outputTokens: output,
    error: "", context: context, steps: steps, stopReason: "final", rounds: 1,
    notes: notes, calledTools: names, calledAgents: names, retrieved: passages,
    spans: spans,
  };
  return r;
}

// A conversation with one artifact of `bytes` bytes and one run that spent
// `input`/`output` tokens. Returns the thread id.
function spent(owner: string, word: string, bytes: int, input: int, output: int): string {
  let id = openThread(database, { agentId: "a1", owner: owner, now: "1700000000000" });
  let body = "";
  while (body.length < bytes) { body = body + "x"; }
  putArtifact(database, {
    threadId: id, path: "/" + word + ".md", title: word, content: body,
    note: "", origin: "uploaded", mustCreate: true, turnSeq: TURN_SEQ_NONE, now: "1700000000000",
  });
  recordRun(database, { agentId: "a1", threadId: id, owner: owner, question: "about " + word, run: spentRun(input, output), modelChoiceId: "", routeNote: "" });
  return id;
}

test("one owner's bytes and tokens are that owner's, and nobody else's", () => {
  fresh();
  spent("u-alice", "lyon", 100, 30, 7);
  spent("u-bob", "rotterdam", 4000, 900, 100);

  let hers = ownerUsage(database, "u-alice");
  expect(hers.bytes == "100");
  expect(hers.inputTokens == "30");
  expect(hers.outputTokens == "7");

  let his = ownerUsage(database, "u-bob");
  expect(his.bytes == "4000");
  expect(his.inputTokens == "900");
});

test("every version counts, because every version is still on disk", () => {
  fresh();
  let id = spent("u-alice", "lyon", 100, 10, 1);
  // A second write of the same path appends a version; the first body does not
  // go anywhere, so the tenant is still holding it.
  putArtifact(database, {
    threadId: id, path: "/lyon.md", title: "lyon", content: "second draft",
    note: "", origin: "uploaded", mustCreate: false, turnSeq: TURN_SEQ_NONE, now: "1700000000001",
  });
  expect(ownerUsage(database, "u-alice").bytes == "112");
});

test("a tenant with nothing is zeros rather than nothing", () => {
  fresh();
  spent("u-alice", "lyon", 100, 10, 1);
  let stranger = ownerUsage(database, "u-carol");
  expect(stranger.bytes == "0");
  expect(stranger.inputTokens == "0");
  expect(stranger.outputTokens == "0");
  // "" is a real tag — every row written before the gateway existed carries
  // it — and it is asked about the same way.
  expect(ownerUsage(database, "").bytes == "0");
});

test("the pre-gateway rows are their own tenant, not everybody's", () => {
  fresh();
  spent("", "unclaimed", 500, 50, 5);
  spent("u-alice", "lyon", 100, 10, 1);
  expect(ownerUsage(database, "").bytes == "500");
  expect(ownerUsage(database, "u-alice").bytes == "100");
});

test("a sum wider than an i32 comes back whole", () => {
  fresh();
  // Two billion tokens is a month for one busy tenant. Parsed into an int the
  // total would wrap and the bill would be wrong in the direction nobody
  // notices, so the digits are carried as text from the database to the JSON.
  spent("u-alice", "lyon", 10, 2000000000, 2000000000);
  spent("u-alice", "paris", 10, 2000000000, 2000000000);
  let hers = ownerUsage(database, "u-alice");
  expect(hers.inputTokens == "4000000000");
  expect(hers.outputTokens == "4000000000");
});

test("the reply carries numbers a client can add up without unquoting them", () => {
  fresh();
  spent("u-alice", "lyon", 100, 30, 7);
  let out = usageJson(ownerUsage(database, "u-alice"));
  expect(out.indexOf("\"owner\":\"u-alice\"") >= 0);
  expect(out.indexOf("\"bytes\":100") >= 0);
  expect(out.indexOf("\"inputTokens\":30") >= 0);
  expect(out.indexOf("\"outputTokens\":7") >= 0);
});

// A run's created_at is written as `Date.now()` millis text; the window tests
// need rows at chosen moments, so they are moved there after the fact.
function backdate(question: string, createdAt: string): void {
  executeWith(database, "UPDATE runs SET created_at = " + placeholderAt(database, 1)
    + " WHERE question = " + placeholderAt(database, 2), [createdAt, question]);
}

test("runsSince counts one owner's runs after the cutoff, failed ones included", () => {
  fresh();
  spent("guest:aa", "one", 10, 1, 1);
  spent("guest:aa", "two", 10, 1, 1);
  spent("guest:aa", "old", 10, 1, 1);
  spent("guest:bb", "other", 10, 1, 1);
  // The moments: the cutoff is 2024-02-01T00:00:00Z as millis text, "old" is
  // the millisecond before it, the rest fall inside the day.
  backdate("about old", "1706745599999");
  backdate("about one", "1706745600000");
  backdate("about two", "1706795999999");
  backdate("about other", "1706795999999");
  // A failed run spent a provider call too, so it counts the same.
  executeWith(database, "UPDATE runs SET ok = 0 WHERE question = " + placeholderAt(database, 1), ["about two"]);

  expect(runsSince(database, "guest:aa", "1706745600000") == 2);
  expect(runsSince(database, "guest:bb", "1706745600000") == 1);
  expect(runsSince(database, "guest:cc", "1706745600000") == 0);
  // The cutoff a caller inside that day would compute lands on the same edge.
  expect(utcDayStartText(1706795999999) == "1706745600000");
  expect(runsSince(database, "guest:aa", utcDayStartText(1706795999999)) == 2);
});

test("the guest day starts at UTC midnight and says when the next one is", () => {
  // 2024-02-01T13:59:59.999Z: the day started at 00:00 and resets at the
  // 2nd's midnight — a leap-year February, so the calendar math is exercised.
  expect(utcDayStartText(1706795999999) == "1706745600000");
  expect(nextUtcMidnightIso(1706795999999) == "2024-02-02T00:00:00Z");
  // 36000001ms to midnight: Retry-After rounds up, never down.
  expect(secondsToUtcMidnight(1706795999999) == 36001);
  // A year boundary, and the zero-padding both fields need in January.
  expect(nextUtcMidnightIso(1735689500000) == "2025-01-01T00:00:00Z");
});

test("a database that answers nonsense reports zero rather than broken JSON", () => {
  fresh();
  let id = spent("u-alice", "lyon", 100, 30, 7);
  // There is no way to make SUM answer this through the API, which is the
  // point: the guard is against the column type changing under the query, and
  // what it must never do is interpolate whatever it found into a reply.
  executeWith(database, "UPDATE runs SET input_tokens = " + placeholderAt(database, 1) + " WHERE thread_id = " + placeholderAt(database, 2),
    ["not a number", id]);
  expect(ownerUsage(database, "u-alice").inputTokens == "0");
  database.close();
});

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { LiveStep, StepStart, StepClose, ARGS_PREVIEW, EDIT_KEEP, RESULT_PREVIEW, rotations, stepPlan, stepId, argsPreview, resultPreview, stepArgs, beginStep, endStep, endStepAt, stepsOfRound, stepsOfThread, roundRunning, stepMillis, forgetRound, forgetSteps } from "./steps.ts";
import { jsonRaw, jsonText } from "./scan.ts";

let database: Db = sqlite();

function fresh(): void {
  connectDatabase(database, stepConfig());
  migrate(database, stepPlan(database));
  forgetSteps(database, "t1");
  forgetSteps(database, "t2");
}

function stepConfig(): DbConfig {
  let named: DbConfig = { filename: "/tmp/agents_steps_test.db" };
  return named;
}

function call(threadId: string, seq: int, idx: int, name: string, args: string, now: string): StepStart {
  let s: StepStart = {
    threadId: threadId, seq: seq, depth: 0, rotation: 0, idx: idx, kind: "tool", name: name,
    target: "s1", args: args, now: now,
  };
  return s;
}

test("a dispatched call is visible before it answers", () => {
  fresh();
  beginStep(database, call("t1", 4, 0, "read_file", "{\"path\":\"/a.txt\"}", "1000"));

  let live = stepsOfRound(database, "t1", 4);
  expect(live.length == 1);
  expect(live[0].name == "read_file");
  expect(live[0].endedAt == "");
  expect(roundRunning(live));
  expect(stepMillis(live[0]) == -1);
});

test("closing a call keeps it as one row rather than adding a second", () => {
  fresh();
  let dispatched = call("t1", 4, 0, "read_file", "{\"path\":\"/a.txt\"}", "1000");
  beginStep(database, dispatched);
  endStep(database, dispatched, true, "1350", 350);

  let live = stepsOfRound(database, "t1", 4);
  expect(live.length == 1);
  expect(live[0].endedAt == "1350");
  expect(live[0].ok);
  expect(stepMillis(live[0]) == 350);
  expect(!roundRunning(live));
});

test("a failed close keeps what the call answered, capped and uncut through a character", () => {
  fresh();
  let dispatched = call("t1", 4, 0, "run_script", "{\"language\":\"python\"}", "1000");
  beginStep(database, dispatched);
  let long = "no .json inputs found ";
  while (long.length <= RESULT_PREVIEW) {
    long = long + "eé";
  }
  let close: StepClose = {
    ok: false,
    endedAt: "1350",
    millis: 350,
    line: 0,
    changed: "",
    result: long,
  };
  endStepAt(database, dispatched, close);

  let live = stepsOfRound(database, "t1", 4);
  expect(live.length == 1);
  expect(!live[0].ok);
  expect(live[0].result.length <= RESULT_PREVIEW);
  expect(live[0].result.slice(0, 22) == "no .json inputs found ");
  let echoed: string = JSON.parse<string>(JSON.stringify(live[0].result));
  expect(echoed == live[0].result);

  let fine = call("t1", 4, 1, "read_artifact", "{}", "1400");
  beginStep(database, fine);
  endStep(database, fine, true, "1500", 100);
  let both = stepsOfRound(database, "t1", 4);
  expect(both[1].result == "");
});

test("a round that is still working says so while one of its calls is open", () => {
  fresh();
  let first = call("t1", 4, 0, "read_file", "{}", "1000");
  beginStep(database, first);
  endStep(database, first, true, "1100", 100);
  beginStep(database, call("t1", 4, 1, "write_file", "{}", "1100"));

  let live = stepsOfRound(database, "t1", 4);
  expect(live.length == 2);
  expect(roundRunning(live));
  expect(live[0].endedAt == "1100");
  expect(live[1].endedAt == "");
});

test("steps come back in the order they were dispatched", () => {
  fresh();
  beginStep(database, call("t1", 7, 0, "first", "{}", "1000"));
  beginStep(database, call("t1", 7, 1, "second", "{}", "1001"));
  beginStep(database, call("t1", 7, 2, "third", "{}", "1002"));

  let live = stepsOfRound(database, "t1", 7);
  expect(live.length == 3);
  expect(live[0].name == "first");
  expect(live[1].name == "second");
  expect(live[2].name == "third");
});

test("a round only shows its own steps", () => {
  fresh();
  beginStep(database, call("t1", 4, 0, "in round four", "{}", "1000"));
  beginStep(database, call("t1", 5, 0, "in round five", "{}", "2000"));
  beginStep(database, call("t2", 4, 0, "in another thread", "{}", "3000"));

  expect(stepsOfRound(database, "t1", 4).length == 1);
  expect(stepsOfRound(database, "t1", 4)[0].name == "in round four");
  expect(stepsOfRound(database, "t1", 5)[0].name == "in round five");
  expect(stepsOfRound(database, "t2", 4)[0].name == "in another thread");
});

test("a delegation is a step of its own kind", () => {
  fresh();
  let child: StepStart = {
    threadId: "t1", seq: 4, depth: 0, rotation: 0, idx: 0, kind: "agent", name: "ask_scout",
    target: "a2", args: "{\"question\":\"what changed\"}", now: "1000",
  };
  beginStep(database, child);

  let live = stepsOfRound(database, "t1", 4);
  expect(live[0].kind == "agent");
  expect(live[0].target == "a2");
});

test("an argument list is previewed, not stored whole", () => {
  fresh();
  let big = "";
  let i: int = 0;
  while (i < 500) {
    big = big + "x";
    i = i + 1;
  }
  beginStep(database, call("t1", 4, 0, "write_artifact", big, "1000"));

  let live = stepsOfRound(database, "t1", 4);
  expect(live[0].args.length < big.length);
  expect(live[0].args.length <= ARGS_PREVIEW);
  expect(argsPreview("short").length == 5);
});

test("a preview is never cut through the middle of a character", () => {
  let wide = "";
  let i: int = 0;
  while (i < 200) {
    wide = wide + "é";
    i = i + 1;
  }
  let preview = argsPreview(wide);
  expect(preview.length <= ARGS_PREVIEW);
  expect(preview.endsWith("..."));
  let body = preview.slice(0, preview.length - 3);
  expect(body.length % 2 == 0);
});

test("a step's id is derived, so the same call cannot be announced twice", () => {
  fresh();
  let dispatched = call("t1", 4, 0, "read_file", "{}", "1000");
  beginStep(database, dispatched);
  beginStep(database, dispatched);

  expect(stepsOfRound(database, "t1", 4).length == 1);
  expect(stepId("t1", 4, 0, 0) == "t1:4:d0:0");
});

test("a round nobody has started has nothing to show", () => {
  fresh();
  let live = stepsOfRound(database, "t1", 99);
  expect(live.length == 0);
  expect(!roundRunning(live));
});

test("forgetting a thread's steps leaves other threads alone", () => {
  fresh();
  beginStep(database, call("t1", 4, 0, "mine", "{}", "1000"));
  beginStep(database, call("t2", 4, 0, "theirs", "{}", "1000"));

  forgetSteps(database, "t1");
  expect(stepsOfRound(database, "t1", 4).length == 0);
  expect(stepsOfRound(database, "t2", 4).length == 1);
});

test("a round that runs again under the same seq does not inherit the last attempt's calls", () => {
  fresh();
  let a0 = call("t1", 4, 0, "read_file", "{}", "1000");
  beginStep(database, a0);
  endStep(database, a0, true, "1100", 100);
  beginStep(database, call("t1", 4, 1, "abandoned", "{}", "1100"));
  expect(stepsOfRound(database, "t1", 4).length == 2);

  forgetRound(database, "t1", 4);
  beginStep(database, call("t1", 4, 0, "the second attempt", "{}", "2000"));

  let live = stepsOfRound(database, "t1", 4);
  expect(live.length == 1);
  expect(live[0].name == "the second attempt");
});

test("clearing one round leaves the rounds around it alone", () => {
  fresh();
  beginStep(database, call("t1", 3, 0, "earlier", "{}", "900"));
  beginStep(database, call("t1", 4, 0, "this one", "{}", "1000"));
  beginStep(database, call("t1", 5, 0, "later", "{}", "1100"));

  forgetRound(database, "t1", 4);
  expect(stepsOfRound(database, "t1", 3).length == 1);
  expect(stepsOfRound(database, "t1", 4).length == 0);
  expect(stepsOfRound(database, "t1", 5).length == 1);
});

test("a transcript's steps come back grouped by round, oldest round first", () => {
  fresh();
  beginStep(database, call("t1", 3, 0, "first round", "{}", "900"));
  beginStep(database, call("t1", 5, 0, "third round, first call", "{}", "1100"));
  beginStep(database, call("t1", 5, 1, "third round, second call", "{}", "1200"));
  beginStep(database, call("t1", 4, 0, "second round", "{}", "1000"));
  beginStep(database, call("t2", 4, 0, "another thread entirely", "{}", "1000"));

  let all = stepsOfThread(database, "t1");
  expect(all.length == 4);
  expect(all[0].seq == 3);
  expect(all[1].seq == 4);
  expect(all[2].seq == 5);
  expect(all[2].idx == 0);
  expect(all[3].seq == 5);
  expect(all[3].idx == 1);
});

test("a sub-agent's first call does not overwrite the delegation that caused it", () => {
  fresh();
  let delegation: StepStart = {
    threadId: "t1", seq: 4, depth: 0, rotation: 0, idx: 0,
    kind: "agent", name: "ask_scout", target: "a2", args: "{}", now: "1000",
  };
  beginStep(database, delegation);
  let childCall: StepStart = {
    threadId: "t1", seq: 4, depth: 1, rotation: 0, idx: 0,
    kind: "tool", name: "read_file", target: "s1", args: "{}", now: "1010",
  };
  beginStep(database, childCall);

  let live = stepsOfRound(database, "t1", 4);
  expect(live.length == 2);
  expect(live[0].name == "ask_scout");
  expect(live[0].depth == 0);
  expect(live[1].name == "read_file");
  expect(live[1].depth == 1);
});

test("an edit step keeps what the card shows: path, counts from the whole text, a bounded old and new", () => {
  let big = "";
  let i: int = 0;
  while (i < 200) {
    big = big + "line " + `${i}` + "\n";
    i = i + 1;
  }
  let args = "{\"path\":\"/index.html\",\"old\":" + JSON.stringify(big)
    + ",\"new\":\"<h1>x</h1>\",\"note\":\"\"}";
  let made = stepArgs("edit_artifact", args);
  expect(jsonText(made, "path") == "/index.html");
  expect(jsonRaw(made, "removed") == "201");
  expect(jsonRaw(made, "added") == "1");
  expect(jsonRaw(made, "cut") == "true");
  expect(jsonText(made, "old").length <= EDIT_KEEP);
  expect(jsonText(made, "new") == "<h1>x</h1>");

  let other = stepArgs("write_artifact", args);
  expect(other.startsWith("{\"path\":\"/index.html\""));
  expect(other.endsWith("..."));

  expect(stepArgs("edit_artifact", "{\"path\":\"/a\"}").startsWith("{\"path\""));
});

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { EnvRow } from "./environments.ts";
import { JouleFrame, jouleFramesFrom } from "./joule-bridge.ts";
import { JOULE_STEP_DEPTH, JOULE_STEP_IDX, JOULE_UNATTENDED, JouleWatch, jouleApply, jouleChosen, jouleMoved, jouleNextFrom, jouleNextIdx, jouleStepName, jouleTook, jouleWatchNew, jouleWatchOf, jouleWatchRested } from "./joule-progress.ts";
import { StepStart, beginStep, partialOf, forgetSteps, stepPlan, stepsOfRound } from "./steps.ts";

// Frames into the thread, without a container.
//
// Everything here is jouleApply and the arithmetic around it, because that is
// where a delegated turn can go wrong silently: a background task's turn.end
// read as the turn's end harvests a workspace still being written, a result
// frame matched to the wrong call closes the wrong step, and a step left open
// makes the round say it is still running for ever.
//
// Two paths are deliberately not here, and both for the same reason: they
// write to stderr, and `lumen test` fails any test that does. They are the
// ones that report something no test can assert about anyway — a frame with no
// round to draw it in, and a result for a call nothing saw start. What can be
// asserted about them is that they change nothing, and that is covered.

let database: Db = sqlite();

function fresh(): void {
  connectDatabase(database, progressConfig());
  migrate(database, stepPlan(database));
  forgetSteps(database, "t-prog");
  forgetSteps(database, "t-other");
  // A round to attach to. latestRound reads the steps table, so the round only
  // exists once something is in it — which is true in life too: the delegated
  // turn is inside the tool call that asked for it, and run.ts opened that step
  // before the daemon saw a frame.
  let asked: StepStart = {
    threadId: "t-prog", seq: 7, depth: 0, rotation: 0, idx: 0, kind: "tool",
    name: "delegate_to_env", target: "", args: "{}", now: "1000",
  };
  beginStep(database, asked);
}

function progressConfig(): DbConfig {
  let named: DbConfig = { filename: "/tmp/agents_joule_progress_test.db" };
  return named;
}

function framesOf(lines: string[]): JouleFrame[] {
  let out = "";
  let i: int = 0;
  while (i < lines.length) {
    out = out + `${1000 + i * 10}` + "|F|" + lines[i] + "\n";
    i = i + 1;
  }
  return jouleFramesFrom(out);
}

function watching(): JouleWatch {
  return jouleWatchNew("t-prog:joule", "t-prog");
}

function drawn(): int {
  let held = stepsOfRound(database, "t-prog", 7);
  let n: int = 0;
  let i: int = 0;
  while (i < held.length) {
    if (held[i].depth == JOULE_STEP_DEPTH) {
      n = n + 1;
    }
    i = i + 1;
  }
  return n;
}

function stepAt(idx: int): string {
  let held = stepsOfRound(database, "t-prog", 7);
  let i: int = 0;
  while (i < held.length) {
    if (held[i].idx == idx) {
      return held[i].name + "|" + (held[i].endedAt == "" ? "open" : "shut")
        + "|" + (held[i].ok ? "ok" : "no") + "|" + held[i].result;
    }
    i = i + 1;
  }
  return "";
}

test("a delegated tool call is a step in the round that asked for it", () => {
  fresh();
  let after = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"edit\",\"args\":\"{\\\"path\\\":\\\"/a.md\\\"}\"}",
  ]), "2000");

  expect(after.turnId == "t1");
  expect(after.seq == 7);
  expect(after.ended == "");
  expect(drawn() == 1);
  // Open, which is what makes the thread say the round is still running.
  expect(stepAt(JOULE_STEP_IDX) == "joule/edit|open|no|");
  let held = stepsOfRound(database, "t-prog", 7);
  let i: int = 0;
  let seen = false;
  while (i < held.length) {
    if (held[i].idx == JOULE_STEP_IDX) {
      // The args frame carries JSON inside a JSON string, and it comes out as
      // the object the delegate was called with rather than as its escaping.
      expect(held[i].args == "{\"path\":\"/a.md\"}");
      expect(held[i].target == "joule");
      expect(held[i].kind == "tool");
      seen = true;
    }
    i = i + 1;
  }
  expect(seen);
});

test("a result closes the call it names, and carries its duration", () => {
  fresh();
  let one = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"read\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c2\",\"tool\":\"edit\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":4,\"type\":\"tool.result\",\"turnId\":\"t1\",\"callId\":\"c2\",\"ok\":true,\"output\":\"written\",\"truncated\":false}",
  ]), "2000");

  expect(one.open.length == 1);
  expect(one.open[0].callId == "c1");
  expect(stepAt(JOULE_STEP_IDX) == "joule/read|open|no|");
  expect(stepAt(JOULE_STEP_IDX + 1) == "joule/edit|shut|ok|written");
  let held = stepsOfRound(database, "t-prog", 7);
  let i: int = 0;
  while (i < held.length) {
    if (held[i].idx == JOULE_STEP_IDX + 1) {
      // The lines were stamped ten milliseconds apart, on the container's
      // clock, and both frames arrived in one tail.
      expect(held[i].millis == 10);
    }
    i = i + 1;
  }
  let two = jouleApply(database, one, framesOf([
    "{\"v\":1,\"seq\":5,\"type\":\"tool.result\",\"turnId\":\"t1\",\"callId\":\"c1\",\"ok\":false,\"output\":\"no such file\",\"truncated\":false}",
  ]), "3000");
  expect(two.open.length == 0);
  expect(stepAt(JOULE_STEP_IDX) == "joule/read|shut|no|no such file");
});

test("a missing ok is a failed call and not a good one", () => {
  fresh();
  jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"run\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"tool.result\",\"turnId\":\"t1\",\"callId\":\"c1\",\"output\":\"\"}",
  ]), "2000");

  expect(stepAt(JOULE_STEP_IDX) == "joule/run|shut|no|");
});

test("a background task's frames are not the turn's", () => {
  fresh();
  let after = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"bg:9\",\"prompt\":\"something else\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"bg:9\",\"callId\":\"b1\",\"tool\":\"run\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":4,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"edit\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":5,\"type\":\"turn.end\",\"turnId\":\"agent:3\",\"reason\":\"done\"}",
  ]), "2000");

  // The subagent's turn.end is not this turn's end, and reading it as one
  // harvests a workspace the delegate is still writing to.
  expect(after.turnId == "t1");
  expect(after.ended == "");
  expect(after.open.length == 1);
  expect(drawn() == 1);
  expect(stepAt(JOULE_STEP_IDX) == "joule/edit|open|no|");
});

test("turn.end closes what never reported, and asks for the harvest once", () => {
  fresh();
  let after = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"run\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"turn.end\",\"turnId\":\"t1\",\"reason\":\"error\"}",
  ]), "2000");

  expect(after.ended == "error");
  expect(after.endedTurn == "t1");
  expect(after.turnId == "");
  expect(after.open.length == 0);
  // A step left open is a round that says it is still running for ever, so a
  // turn that ends mid-call closes the call too.
  expect(stepAt(JOULE_STEP_IDX)
    == "joule/run|shut|no|the turn ended before this call reported a result");
  // And the signal is taken off once it has been acted on, so the next tick
  // does not harvest again.
  expect(jouleWatchRested(after).ended == "");
});

test("a turn with no reason ended anyway", () => {
  fresh();
  let after = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"turn.end\",\"turnId\":\"t1\"}",
  ]), "2000");

  expect(after.ended == "done");
});

test("the delegate's text is the round's streaming answer", () => {
  fresh();
  let one = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"text.delta\",\"turnId\":\"t1\",\"text\":\"I will \"}",
    "{\"v\":1,\"seq\":3,\"type\":\"text.delta\",\"turnId\":\"t1\",\"text\":\"edit it.\"}",
  ]), "2000");

  expect(one.said == "I will edit it.");
  expect(partialOf(database, "t-prog", 7) == "I will edit it.");
  // Not visible from another round, which is what keeps a turn that outlives
  // its tool call from writing over the answer of the round after it.
  expect(partialOf(database, "t-prog", 8) == "");

  let two = jouleApply(database, one, framesOf([
    "{\"v\":1,\"seq\":4,\"type\":\"text.delta\",\"turnId\":\"t1\",\"text\":\" Done.\"}",
    "{\"v\":1,\"seq\":5,\"type\":\"turn.end\",\"turnId\":\"t1\",\"reason\":\"done\"}",
  ]), "3000");
  expect(partialOf(database, "t-prog", 7) == "I will edit it. Done.");
  // Cleared with the turn, so the next one does not continue somebody else's
  // sentence.
  expect(two.said == "");
});

test("an error frame belongs to the turn the window was reading", () => {
  fresh();
  let after = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"error\",\"code\":\"E_STREAM\",\"message\":\"the provider hung up\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"turn.end\",\"turnId\":\"t1\",\"reason\":\"error\"}",
  ]), "2000");

  expect(after.ended == "error");
  expect(stepAt(JOULE_STEP_IDX) == "joule/error|shut|no|the provider hung up");
});

test("an error with no message is read by its code", () => {
  fresh();
  jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"error\",\"code\":\"E_EMPTY_ANSWER\"}",
  ]), "2000");

  expect(stepAt(JOULE_STEP_IDX) == "joule/error|shut|no|E_EMPTY_ANSWER");
});

test("an approval in full-auto is counted and drawn as a refusal", () => {
  fresh();
  let after = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"approval.request\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"run\",\"summary\":\"npm test\",\"detail\":\"\",\"args\":\"{}\"}",
  ]), "2000");

  // Nothing asks in full-auto, so one of these is not a report about the call:
  // it says the mode did not land.
  expect(after.approvals == 1);
  expect(stepAt(JOULE_STEP_IDX) == "joule/run|shut|no|" + JOULE_UNATTENDED);
});

test("a notice says its level rather than being read as a failure", () => {
  fresh();
  jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"do it\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"notice\",\"code\":\"relay.slow\",\"level\":\"info\",\"message\":\"catching up\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"notice\",\"code\":\"relay.buffer_overflow\",\"level\":\"warn\",\"message\":\"frames were dropped\"}",
  ]), "2000");

  expect(stepAt(JOULE_STEP_IDX) == "joule/notice|shut|ok|catching up");
  expect(stepAt(JOULE_STEP_IDX + 1) == "joule/notice|shut|no|frames were dropped");
});

test("a second turn in one round does not write over the first one's steps", () => {
  fresh();
  let one = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"first\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"read\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"turn.end\",\"turnId\":\"t1\",\"reason\":\"done\"}",
  ]), "2000");
  let two = jouleApply(database, jouleWatchRested(one), framesOf([
    "{\"v\":1,\"seq\":4,\"type\":\"turn.start\",\"turnId\":\"t2\",\"prompt\":\"second\"}",
    "{\"v\":1,\"seq\":5,\"type\":\"tool.call\",\"turnId\":\"t2\",\"callId\":\"c2\",\"tool\":\"edit\",\"args\":\"{}\"}",
  ]), "3000");

  expect(two.turnId == "t2");
  expect(drawn() == 2);
  expect(stepAt(JOULE_STEP_IDX).startsWith("joule/read|shut"));
  expect(stepAt(JOULE_STEP_IDX + 1) == "joule/edit|open|no|");
});

test("a restart carries on from what the round already holds", () => {
  fresh();
  jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"first\"}",
    "{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"read\",\"args\":\"{}\"}",
    "{\"v\":1,\"seq\":3,\"type\":\"turn.end\",\"turnId\":\"t1\",\"reason\":\"done\"}",
  ]), "2000");

  // The counter is in the process and the rows are in the database, and after
  // a restart only one of the two remembers. Asking the round is what stops a
  // fresh counter writing over the steps an earlier process left there.
  expect(jouleNextIdx(database, "t-prog", 7) == JOULE_STEP_IDX + 1);
  // The engine's own steps are at depth 0 and are not this counter's business.
  expect(jouleNextIdx(database, "t-other", 3) == JOULE_STEP_IDX);
  expect(jouleNextIdx(database, "t-prog", -1) == JOULE_STEP_IDX);

  let again = jouleApply(database, watching(), framesOf([
    "{\"v\":1,\"seq\":4,\"type\":\"turn.start\",\"turnId\":\"t2\",\"prompt\":\"second\"}",
    "{\"v\":1,\"seq\":5,\"type\":\"tool.call\",\"turnId\":\"t2\",\"callId\":\"c9\",\"tool\":\"grep\",\"args\":\"{}\"}",
  ]), "4000");
  expect(again.idx == JOULE_STEP_IDX + 2);
  expect(drawn() == 2);
  expect(stepAt(JOULE_STEP_IDX).startsWith("joule/read"));
  expect(stepAt(JOULE_STEP_IDX + 1) == "joule/grep|open|no|");
});

test("a delegated tool is named for where it ran", () => {
  expect(jouleStepName("edit") == "joule/edit");
  // joule has a `read`, a `run` and a `grep`, and an unqualified one of those
  // in a step list reads as something the engine did itself.
  expect(jouleStepName("run") == "joule/run");
  expect(jouleStepName("") == "joule/?");
});

test("a watch is per environment and starts knowing nothing", () => {
  let held: JouleWatch[] = [];
  held.push(jouleWatchNew("t1:joule", "t1"));
  held.push(jouleWatchNew("t2:joule", "t2"));
  expect(jouleWatchOf(held, "t2:joule", "t2").threadId == "t2");
  let made = jouleWatchOf(held, "t3:joule", "t3");
  expect(made.threadId == "t3");
  expect(made.turnId == "");
  expect(made.seq == -1);
  expect(made.idx == JOULE_STEP_IDX);
});

test("a tick reads a bounded share, and reaches everything", () => {
  // Under the cap, everything every tick.
  expect(jouleChosen(3, 0, 8, 0) && jouleChosen(3, 0, 8, 1) && jouleChosen(3, 0, 8, 2));
  expect(jouleNextFrom(3, 0, 8) == 0);

  // Over it, a rotation: two ticks of two cover four.
  expect(jouleChosen(4, 0, 2, 0) && jouleChosen(4, 0, 2, 1));
  expect(!jouleChosen(4, 0, 2, 2) && !jouleChosen(4, 0, 2, 3));
  let next = jouleNextFrom(4, 0, 2);
  expect(next == 2);
  expect(!jouleChosen(4, next, 2, 0) && !jouleChosen(4, next, 2, 1));
  expect(jouleChosen(4, next, 2, 2) && jouleChosen(4, next, 2, 3));
  expect(jouleNextFrom(4, next, 2) == 0);

  // And it wraps rather than running off the end.
  expect(jouleChosen(3, 2, 2, 2) && jouleChosen(3, 2, 2, 0));
  expect(!jouleChosen(3, 2, 2, 1));

  expect(!jouleChosen(0, 0, 8, 0));
  expect(!jouleChosen(3, 0, 0, 0));
  expect(!jouleChosen(3, 0, 8, 3));
  expect(jouleNextFrom(0, 5, 8) == 0);
});

test("a moved cursor rides on the row both writers carry", () => {
  // envMarkAgent and envMarkSynced each save the whole row, so a cursor and a
  // sync stamp written through two calls that were handed the same old row
  // undo one another. One row with both is the only arrangement that does not.
  let row: EnvRow = {
    id: "t-prog:joule", threadId: "t-prog", name: "joule", image: "agents-joule:1",
    network: 1, status: "running", slug: "abc", hostPort: 0, servePort: 0, serveCmd: "",
    syncAt: "1700000000", agentConn: "engine-abc", agentRead: 40,
    createdAt: "1", lastUsedAt: "2",
  };
  let moved = jouleMoved(row, 512);
  expect(moved.agentRead == 512);
  expect(moved.agentConn == "engine-abc");
  expect(moved.syncAt == "1700000000");
  expect(moved.id == row.id && moved.slug == row.slug && moved.image == row.image);
  expect(moved.status == "running" && moved.network == 1);
  expect(moved.createdAt == "1" && moved.lastUsedAt == "2");
  // The one it was built from is untouched.
  expect(row.agentRead == 40);
});

test("a duration is the container's clock at both ends, or nothing", () => {
  let from: number = 1770000000000.0;
  let to: number = 1770000000450.0;
  expect(jouleTook(from, to) == 450);
  // A stamp this could not read is 0, and 0 subtracted from an epoch is not a
  // duration — it is forty years.
  let none: number = 0.0;
  expect(jouleTook(none, to) == -1);
  expect(jouleTook(from, none) == -1);
  // A clock that went backwards between two frames says nothing rather than a
  // negative duration.
  expect(jouleTook(to, from) == -1);
  expect(jouleTook(from, from) == 0);
});

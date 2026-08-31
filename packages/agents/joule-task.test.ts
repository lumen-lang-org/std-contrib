import { JouleFrame, jouleFramesFrom, jouleTurnFor } from "./joule-bridge.ts";
import { JOULE_WAIT_SECONDS, JouleDelegated, JouleRead, jouleAnswer, jouleConnFor, joulePrompt, jouleReadTurn } from "./joule-task.ts";

// What the tool decides, without a container: what gets submitted, what is
// read back out of the frames, and what the model is told about it. The parts
// that need docker — the two ensures, the daemon start, the follow — are
// exercised against a real container in the acceptance run rather than
// simulated here, the way joule-bridge.test.ts covers its own pure half.
//
// A DEVIATION applies to that acceptance run and is recorded rather than
// hidden: a joule container is launched with `seccomp=unconfined`, because no
// async Lumen binary starts under ops/seccomp.json — the runtime brings up an
// io_uring event loop and io_uring_setup is on no allowlist. That is now a
// deliberate, narrow decision in envRunArgs rather than a test-only flag, and
// it is temporary: the fix is upstream (lumen-lang-org/lumen#53 selects epoll
// at run time) and lands here when the image is rebuilt from a joule release
// carrying it. The evidence, including why allowing io_uring_setup alone is
// worse than the clean refusal, is at
// https://github.com/joule-sh/code/issues/348#issuecomment-5463608927

function framesOf(lines: string[]): JouleFrame[] {
  return jouleFramesFrom(lines.join("\n") + "\n");
}

function frame(json: string): string {
  return "1788000000000|F|" + json;
}

function readOf(tools: string[], said: string, cut: bool, approvals: int, errors: string[]): JouleRead {
  let one: JouleRead = { tools: tools, said: said, cut: cut, approvals: approvals, errors: errors };
  return one;
}

function delegatedOf(turnId: string, reason: string, read: JouleRead, fault: string): JouleDelegated {
  let one: JouleDelegated = {
    ok: fault == "" && reason != "error", turnId: turnId, reason: reason, read: read,
    created: false, started: false, fault: fault,
  };
  return one;
}

test("what is submitted is the brief plus the two things the delegate cannot know", () => {
  let sent = joulePrompt("  Make the tests pass.  ");

  // The brief itself, trimmed, first and whole.
  expect(sent.indexOf("Make the tests pass.") == 0);
  expect(sent.indexOf("current working directory") > 0);
  expect(sent.indexOf("/workspace") < 0);
  expect(sent.indexOf("Edit files in place") > 0);
  // And that nobody is there, because full-auto removes the approval gate and
  // not the habit of ending a turn on a question.
  expect(sent.indexOf("Nobody is attached") > 0);
});

test("the prompt is the same string twice, or the turn cannot be found", () => {
  // turn.start echoes the submitted text verbatim, and that echo is the only
  // place the daemon reports the id it assigned. Building the prompt once and
  // matching against a different string is a turn nothing can follow.
  let task = "Rename the widget";
  let sent = joulePrompt(task);
  let echo = jouleJsonOf(sent);
  let frames = framesOf([
    frame("{\"v\":1,\"seq\":1,\"type\":\"session.hello\",\"mode\":\"full-auto\"}"),
    frame("{\"v\":1,\"seq\":2,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":" + echo + "}"),
  ]);

  expect(jouleTurnFor(frames, sent) == "t1");
  expect(jouleTurnFor(frames, task) == "");
});

// The escape a daemon would have written the prompt back as. Kept here rather
// than reached for so this test does not depend on the sender's own escaping
// being right.
function jouleJsonOf(text: string): string {
  let out = "\"";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    i = i + 1;
    if (ch == "\"") {
      out = out + "\\\"";
    } else if (ch == "\n") {
      out = out + "\\n";
    } else {
      out = out + ch;
    }
  }
  return out + "\"";
}

test("a turn is read back as what it ran and what it said", () => {
  let frames = framesOf([
    frame("{\"v\":1,\"seq\":2,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"go\"}"),
    frame("{\"v\":1,\"seq\":3,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"read\",\"args\":\"{}\"}"),
    frame("{\"v\":1,\"seq\":4,\"type\":\"tool.result\",\"turnId\":\"t1\",\"callId\":\"c1\",\"ok\":true,\"output\":\"x\"}"),
    frame("{\"v\":1,\"seq\":5,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c2\",\"tool\":\"edit\",\"args\":\"{}\"}"),
    frame("{\"v\":1,\"seq\":6,\"type\":\"text.delta\",\"turnId\":\"t1\",\"text\":\"Renamed \"}"),
    frame("{\"v\":1,\"seq\":7,\"type\":\"text.delta\",\"turnId\":\"t1\",\"text\":\"the widget.\"}"),
    frame("{\"v\":1,\"seq\":8,\"type\":\"turn.end\",\"turnId\":\"t1\",\"reason\":\"done\"}"),
  ]);
  let read = jouleReadTurn(frames, "t1");

  expect(read.tools.length == 2);
  expect(read.tools[0] == "read");
  expect(read.tools[1] == "edit");
  // The deltas are chunks of one reply and are only a reply once joined.
  expect(read.said == "Renamed the widget.");
  expect(!read.cut);
  expect(read.approvals == 0);
  expect(read.errors.length == 0);
});

test("another turn's work is not this turn's work", () => {
  // Background runs and subagents emit on the same log with bg:- and agent:-
  // prefixed ids, interleaved with the foreground turn.
  let frames = framesOf([
    frame("{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"edit\",\"args\":\"{}\"}"),
    frame("{\"v\":1,\"seq\":3,\"type\":\"tool.call\",\"turnId\":\"bg:1\",\"callId\":\"c2\",\"tool\":\"run\",\"args\":\"{}\"}"),
    frame("{\"v\":1,\"seq\":4,\"type\":\"text.delta\",\"turnId\":\"agent:2\",\"text\":\"not mine\"}"),
    frame("{\"v\":1,\"seq\":5,\"type\":\"text.delta\",\"turnId\":\"t1\",\"text\":\"mine\"}"),
  ]);
  let read = jouleReadTurn(frames, "t1");

  expect(read.tools.length == 1);
  expect(read.tools[0] == "edit");
  expect(read.said == "mine");
});

test("an error frame belongs to no turn, so it is not filtered away by one", () => {
  // `error` carries a code and a message and no turnId at all. Scoped to the
  // window that was read, which is the only honest scope available.
  let frames = framesOf([
    frame("{\"v\":1,\"seq\":2,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"go\"}"),
    frame("{\"v\":1,\"seq\":3,\"type\":\"error\",\"code\":\"provider\",\"message\":\"the model refused\"}"),
    frame("{\"v\":1,\"seq\":4,\"type\":\"turn.end\",\"turnId\":\"t1\",\"reason\":\"error\"}"),
  ]);
  let read = jouleReadTurn(frames, "t1");

  expect(read.errors.length == 1);
  expect(read.errors[0] == "the model refused");
});

test("an approval in full-auto is a fault to report, not a thing to wait on", () => {
  let frames = framesOf([
    frame("{\"v\":1,\"seq\":2,\"type\":\"approval.request\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"run\",\"summary\":\"rm\"}"),
  ]);
  let read = jouleReadTurn(frames, "t1");
  expect(read.approvals == 1);

  let said = jouleAnswer(delegatedOf("t1", "done", read, ""));
  expect(said.indexOf("approval") > 0);
  expect(said.indexOf("nothing here can answer") > 0);
});

test("nothing is read for a turn that was never identified", () => {
  let frames = framesOf([
    frame("{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\",\"callId\":\"c1\",\"tool\":\"edit\",\"args\":\"{}\"}"),
  ]);
  let read = jouleReadTurn(frames, "");

  // Not "everything", which is what a filter written the other way round
  // would do: an unidentified turn means somebody else's frames.
  expect(read.tools.length == 0);
  expect(read.said == "");
});

test("a finished turn says so, and says where the result will appear", () => {
  let tools: string[] = ["edit"];
  let none: string[] = [];
  let said = jouleAnswer(delegatedOf("t3", "done", readOf(tools, "Done.", false, 0, none), ""));

  expect(said.indexOf("Turn t3 finished.") >= 0);
  expect(said.indexOf("It ran: edit.") > 0);
  expect(said.indexOf("Done.") > 0);
  // The note the harvest writes, so the model can recognise the versions when
  // they arrive — and no claim that they have arrived, because the sweep is
  // what brings them and it has not run.
  expect(said.indexOf("edited by joule code") > 0);
  expect(said.indexOf("comes back as new versions") > 0);
});

test("a turn still running is not a failure, and says the work did not stop", () => {
  let none: string[] = [];
  let out = delegatedOf("t4", "", readOf(none, "", false, 0, none), "");
  let said = jouleAnswer(out);

  expect(out.ok);
  expect(said.indexOf("still running after " + `${JOULE_WAIT_SECONDS}` + " seconds") > 0);
  expect(said.indexOf("the work did not stop") > 0);
});

test("a turn that errored is a failure, and one that was cancelled is said plainly", () => {
  let none: string[] = [];
  let bad = delegatedOf("t5", "error", readOf(none, "", false, 0, none), "");
  expect(!bad.ok);
  expect(jouleAnswer(bad).indexOf("ended in an error") > 0);

  let stopped = delegatedOf("t6", "cancelled", readOf(none, "", false, 0, none), "");
  expect(jouleAnswer(stopped).indexOf("was cancelled") > 0);
});

test("a task the daemon has not started yet is not handed over twice", () => {
  let none: string[] = [];
  let said = jouleAnswer(delegatedOf("", "", readOf(none, "", false, 0, none), ""));

  // Input arriving during a turn is queued and submitted in order, so this is
  // a task that will run, and a second call would be a second turn.
  expect(said.indexOf("not reported a turn") > 0);
  expect(said.indexOf("a second turn, not a retry") > 0);
});

test("a refusal is a refusal, with nothing about where files will appear", () => {
  let none: string[] = [];
  let said = jouleAnswer(delegatedOf("", "", readOf(none, "", false, 0, none),
    "this deployment has no joule environment"));

  expect(said.indexOf("The task was not delegated:") == 0);
  expect(said.indexOf("comes back as new versions") < 0);
});

test("the connection id is a path component, so it is one the daemon accepts", () => {
  // A slug is 16 hex characters, and the id is written into a file name the
  // daemon opens by that name.
  expect(jouleConnFor("a1b2c3d4e5f60718") == "engine-a1b2c3d4e5f60718");
  expect(jouleConnFor("") == "");
  // Stable for one environment on purpose: a fresh id per call leaves a
  // mailbox per call behind, each one drained by nobody.
  expect(jouleConnFor("abc") == jouleConnFor("abc"));
});

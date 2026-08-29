import { JOULE_MIN_VERSION, JOULE_MODE, JouleFrame, jouleAppendCmd, jouleFrameBool, jouleMailboxAt, jouleBroadcastPath, jouleFrameLine, jouleFrameOf, jouleFramesFor, jouleFramesFrom, jouleInboxPath, jouleInputFrame, jouleIsTaskTurn, jouleJsonString, jouleMailboxPayload, jouleReadyCmd, jouleResumeFrame, jouleRuntimeDir, jouleSafeConnId, jouleShellQuote, jouleStartCmd, jouleTailCmd, jouleTailRead, jouleTurnEndReason, jouleTurnFor } from "./joule-bridge.ts";

// The transport without docker: what goes into the inbox, what comes out of
// the broadcast log, and where the cursor lands afterwards. Those are the
// three places this can go wrong silently — a malformed line is dropped with
// nothing said back, a cursor that overshoots skips a turn, and a turn.end
// belonging to something else ends the wrong turn.
//
// A LIVE CONTAINER IS NOT COVERED HERE, and there is a deviation to record
// about the one used to accept this work. No async Lumen binary starts under
// ops/seccomp.json: the runtime brings up an io_uring event loop, the profile
// omits io_uring_setup, and the unwrap of the EPERM aborts the process. The
// acceptance run therefore used `--security-opt seccomp=unconfined`, which is
// a deviation from how envRunArgs launches every other environment and is not
// proposed as the production posture. The evidence, and why allowing
// io_uring_setup alone is worse than the clean refusal, is at
// https://github.com/joule-sh/code/issues/348#issuecomment-5463608927
// Whether a delegated environment needs io_uring at all belongs to a later
// slice; nothing in this file or in environments.ts changes a security option.

function jouleTestFrames(lines: string[]): JouleFrame[] {
  return jouleFramesFrom(lines.join("\n") + "\n");
}

test("a frame goes out as one mailbox line the daemon can read back", () => {
  let line = jouleFrameLine("{\"type\":\"input\"}");

  // `<recvAt>|F|<payload>\n`, which is mailboxLine's format on the other side.
  expect(line.endsWith("\n"));
  let first = line.indexOf("|");
  expect(first > 0);
  let stamp = line.slice(0, first);
  let d: int = 0;
  while (d < stamp.length) {
    expect(stamp.charCodeAt(d) >= 48 && stamp.charCodeAt(d) <= 57);
    d = d + 1;
  }
  expect(line.slice(first, first + 3) == "|F|");
  // Exactly one line: a payload split over two is two half-frames and a reader
  // that has lost its place for the rest of the session.
  expect(line.slice(0, line.length - 1).indexOf("\n") < 0);
  expect(jouleMailboxPayload(line.slice(0, line.length - 1), "F") == "{\"type\":\"input\"}");
});

test("the payload is taken from the first two bars and not from every bar", () => {
  // Model output has bars in it — tables, alternations, shell pipelines.
  let payload = "{\"type\":\"text.delta\",\"text\":\"a | b || c\"}";
  let line = jouleFrameLine(payload);
  expect(jouleMailboxPayload(line.slice(0, line.length - 1), "F") == payload);

  // A tag that is not this reader's is not this reader's line.
  expect(jouleMailboxPayload("123|R|{}", "F") == "");
  expect(jouleMailboxPayload("no bars here", "F") == "");
  expect(jouleMailboxPayload("123|F", "F") == "");
});

test("text is escaped into one line", () => {
  expect(jouleJsonString("plain") == "\"plain\"");
  expect(jouleJsonString("say \"hi\"") == "\"say \\\"hi\\\"\"");
  expect(jouleJsonString("back\\slash") == "\"back\\\\slash\"");
  // The one that matters: a raw newline in a frame is two half-frames.
  expect(jouleJsonString("one\ntwo") == "\"one\\ntwo\"");
  expect(jouleJsonString("a\rb\tc") == "\"a\\rb\\tc\"");

  let frame = jouleInputFrame("fix the tests\nand say \"done\"");
  expect(frame.indexOf("\n") < 0);
  expect(frame.startsWith("{\"v\":1,\"seq\":0,\"type\":\"input\","));
  expect(frame.indexOf("\\\"done\\\"") > 0);
});

test("resume asks for everything, because nothing arrives until it does", () => {
  // daemonOnMessage starts the pusher only on resume. A client that writes an
  // input frame and waits waits for ever on a healthy connection.
  let frame = jouleResumeFrame(-1);
  expect(frame.indexOf("\"type\":\"resume\"") > 0);
  // Read by a real JSON.parse on the other side, unlike every other field, so
  // -1 has to be a number and not a string.
  expect(frame.indexOf("\"since\":-1") > 0);
  expect(jouleResumeFrame(41).indexOf("\"since\":41") > 0);
});

test("a frame is read field by field, whatever else it carries", () => {
  let hello = jouleFrameOf(
    "{\"v\":1,\"seq\":1,\"type\":\"session.hello\",\"workspace\":\"/workspace\",\"mode\":\"full-auto\"}");
  expect(hello.seq == 1);
  expect(hello.type == "session.hello");
  // Not every frame belongs to a turn, and an absent field is not a fault.
  expect(hello.turnId == "");

  let call = jouleFrameOf(
    "{\"v\":1,\"seq\":9,\"type\":\"tool.call\",\"turnId\":\"t1\",\"tool\":\"edit\",\"args\":\"{}\"}");
  expect(call.type == "tool.call");
  expect(call.turnId == "t1");
  // The rest of the frame is kept, because routing on two fields is not the
  // same as being able to read the others later.
  expect(call.json.indexOf("\"tool\":\"edit\"") > 0);
});

test("only whole lines are frames, and the cursor agrees", () => {
  let whole = "1|F|{\"seq\":1,\"type\":\"session.hello\"}\n"
    + "2|F|{\"seq\":2,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"go\"}\n";
  let frames = jouleFramesFrom(whole);
  expect(frames.length == 2);
  expect(frames[0].type == "session.hello");
  expect(frames[1].turnId == "t1");
  expect(jouleTailRead(0, whole) == whole.length);

  // The ordinary case: the daemon appends while this reads.
  let partial = whole + "3|F|{\"seq\":3,\"type\":\"text.d";
  let cut = jouleFramesFrom(partial);
  expect(cut.length == 2);
  // The cursor stops at the last newline, so the half line is read again next
  // time rather than skipped.
  expect(jouleTailRead(0, partial) == whole.length);
  expect(jouleTailRead(200, partial) == 200 + whole.length);

  // Nothing whole at all leaves the cursor exactly where it was.
  expect(jouleFramesFrom("4|F|{\"seq").length == 0);
  expect(jouleTailRead(512, "4|F|{\"seq") == 512);
  expect(jouleTailRead(0, "") == 0);
  // A cursor cannot be negative, and one that was would ask tail for `+0`.
  expect(jouleTailRead(-3, whole) == whole.length);
});

test("the cursor is counted in bytes, so a non-ASCII frame does not desync it", () => {
  // Two bytes in UTF-8, one character in a language that counted characters.
  // Undercounting here starts every later read in the middle of a frame.
  let line = "1|F|{\"seq\":1,\"type\":\"text.delta\",\"turnId\":\"t1\",\"text\":\"café\"}\n";
  expect(jouleTailRead(0, line) == line.length);
  expect(jouleFramesFrom(line).length == 1);
});

test("a background task's turn is not the turn that was asked for", () => {
  // Background runs and subagents emit on the same log, interleaved. Reading
  // their turn.end as the turn's harvests a workspace still being written to.
  expect(jouleIsTaskTurn("bg:7"));
  expect(jouleIsTaskTurn("agent:3"));
  expect(!jouleIsTaskTurn("t1"));
  expect(!jouleIsTaskTurn("t12"));
  expect(!jouleIsTaskTurn(""));

  let frames = jouleTestFrames([
    "1|F|{\"seq\":1,\"type\":\"turn.start\",\"turnId\":\"t1\",\"prompt\":\"tidy the tests\"}",
    "2|F|{\"seq\":2,\"type\":\"turn.start\",\"turnId\":\"bg:9\",\"prompt\":\"tidy the tests\"}",
    "3|F|{\"seq\":3,\"type\":\"turn.end\",\"turnId\":\"bg:9\",\"reason\":\"done\"}",
    "4|F|{\"seq\":4,\"type\":\"tool.call\",\"turnId\":\"t1\",\"tool\":\"edit\",\"args\":\"{}\"}",
  ]);

  // The foreground turn owns the prompt; the background one that echoes it
  // does not.
  expect(jouleTurnFor(frames, "tidy the tests") == "t1");
  // Its turn.end has been and gone and t1 is still running.
  expect(jouleTurnEndReason(frames, "t1") == "");
  expect(jouleTurnEndReason(frames, "bg:9") == "");
});

test("the turn id is learnt from the echo, because the input frame has none", () => {
  // An input frame carries no id. The daemon assigns t<n> when the turn
  // begins and reports it on turn.start, echoing the prompt verbatim — it
  // suppresses nothing, for any client — so the echo is the only handle.
  let frames = jouleTestFrames([
    "1|F|{\"seq\":1,\"type\":\"session.hello\",\"mode\":\"full-auto\"}",
    "2|F|{\"seq\":2,\"type\":\"turn.start\",\"turnId\":\"t4\",\"prompt\":\"add a health route\"}",
    "3|F|{\"seq\":3,\"type\":\"text.delta\",\"turnId\":\"t4\",\"text\":\"ok\"}",
    "4|F|{\"seq\":4,\"type\":\"turn.end\",\"turnId\":\"t4\",\"reason\":\"done\"}",
  ]);

  expect(jouleTurnFor(frames, "add a health route") == "t4");
  expect(jouleTurnFor(frames, "something else entirely") == "");
  expect(jouleTurnEndReason(frames, "t4") == "done");
  // A turn nobody started has not ended either.
  expect(jouleTurnEndReason(frames, "t9") == "");
  expect(jouleTurnEndReason(frames, "") == "");

  let mine = jouleFramesFor(frames, "t4");
  expect(mine.length == 3);
  expect(mine[0].type == "turn.start");
  expect(mine[2].type == "turn.end");
  expect(jouleFramesFor(frames, "").length == 0);
});

test("how a turn ended is carried, not just that it did", () => {
  let stopped = jouleTestFrames([
    "1|F|{\"seq\":1,\"type\":\"turn.end\",\"turnId\":\"t2\",\"reason\":\"cancelled\"}",
  ]);
  expect(jouleTurnEndReason(stopped, "t2") == "cancelled");

  let broke = jouleTestFrames([
    "1|F|{\"seq\":1,\"type\":\"error\",\"code\":\"E_STREAM\",\"message\":\"the provider failed\"}",
    "2|F|{\"seq\":2,\"type\":\"turn.end\",\"turnId\":\"t2\",\"reason\":\"error\"}",
  ]);
  expect(jouleTurnEndReason(broke, "t2") == "error");
});

test("a frame is one shell word however many quotes are in it", () => {
  expect(jouleShellQuote("plain") == "'plain'");
  expect(jouleShellQuote("has \"double\" quotes") == "'has \"double\" quotes'");
  // The character single quotes cannot carry, and the one model output has in
  // every other sentence.
  expect(jouleShellQuote("don't") == "'don'\\''t'");
  expect(jouleShellQuote("") == "''");

  let cmd = jouleAppendCmd("engine-1", jouleFrameLine(jouleInputFrame("don't ask, just do it")));
  // printf and not echo, and %s and not the line as the format string: a
  // frame carrying a percent sign would otherwise be read as a conversion.
  expect(cmd.startsWith("printf '%s' '"));
  expect(cmd.indexOf(">> " + jouleInboxPath("engine-1")) > 0);
  // Nothing outside the quoting can end the word early.
  expect(cmd.indexOf("'\\''") > 0);
});

test("the log is read from a byte offset, counting from one", () => {
  // `tail -c +N` is 1-based, so nothing read yet is +1 and not +0.
  expect(jouleTailCmd(0).startsWith("tail -c +1 " + jouleBroadcastPath()));
  expect(jouleTailCmd(202).startsWith("tail -c +203 " + jouleBroadcastPath()));
  expect(jouleTailCmd(-1).startsWith("tail -c +1 "));
  // A log that is not there yet is a daemon still starting, not a fault: this
  // runs on a poll and would otherwise report one every tick until it came up.
  expect(jouleTailCmd(0).indexOf("|| true") > 0);
});

test("the daemon is told where its runtime directory is, and comes up unattended", () => {
  // Named outright rather than derived. The derived one is a slug and a sha1
  // of the workspace path, and computing that here would be one hash in two
  // languages in two repositories.
  let dir = jouleRuntimeDir();
  expect(dir.startsWith("/"));
  // Under HOME, which is the volume: the rootfs is read-only and the first
  // thing the daemon does is create this directory and clear a file in it.
  expect(dir.startsWith("/home/sandbox/"));
  expect(jouleInboxPath("c-1") == dir + "/inbox/c-1.in");
  expect(jouleBroadcastPath() == dir + "/broadcast.log");

  let cmd = jouleStartCmd();
  // The workspace root is the working directory, and a daemon rooted
  // elsewhere reads another directory's instructions and writes its files
  // there.
  expect(cmd.startsWith("cd /workspace &&"));
  expect(cmd.indexOf("JOULE_DAEMON_RUNTIME_DIR='" + dir + "'") > 0);
  // A flag and not a mode.set frame after attaching: the frame races the
  // first turn, and losing that race is a turn that stalls on the approval
  // timeout with nothing reporting why.
  expect(cmd.indexOf("--mode " + JOULE_MODE) > 0);
  expect(JOULE_MODE == "full-auto");
  expect(cmd.indexOf("joule-daemon") > 0);

  // Both of those arrived in v0.23.20. Against an earlier release the runtime
  // directory is a hash this side cannot name and the mode flag is not read,
  // so the floor is part of the transport rather than a note about the image.
  expect(JOULE_MIN_VERSION == "0.23.20");
});

test("the wait for a daemon happens inside the container", () => {
  // docker exec -d returns the moment the process is spawned and says nothing
  // about whether the inbox exists. A frame written before then lands in a
  // directory sweepInbox then clears, and the loss is silent.
  let cmd = jouleReadyCmd();
  expect(cmd.indexOf("[ -d " + jouleRuntimeDir() + "/inbox ]") > 0);
  expect(cmd.indexOf("[ -f " + jouleBroadcastPath() + " ]") > 0);
  expect(cmd.indexOf("sleep") > 0);
  // Bounded: a daemon that never starts must fail rather than hold the exec.
  expect(cmd.indexOf("exit 1") > 0);
});

test("a connection id is a path component, so it is checked before it is one", () => {
  expect(jouleSafeConnId("engine-1"));
  expect(jouleSafeConnId("A0-z"));
  expect(!jouleSafeConnId(""));
  // The daemon's own alphabet is [0-9A-Za-z-]. Everything else would put a
  // path this side chose somewhere the daemon does not read from — or
  // somewhere else entirely.
  expect(!jouleSafeConnId("../../etc/passwd"));
  expect(!jouleSafeConnId("has space"));
  expect(!jouleSafeConnId("under_score"));
  expect(!jouleSafeConnId("dot.dot"));
});

test("a frame carries the clock of the line it came off", () => {
  // The only clock that can time anything inside the container. A tail hands
  // back whatever accumulated since the last one, so a call and its result
  // routinely arrive together, and timing them from this side would report
  // every delegated call as instant.
  let frames = jouleTestFrames([
    "1770000000000|F|{\"v\":1,\"seq\":2,\"type\":\"tool.call\",\"turnId\":\"t1\"}",
    "1770000000450|F|{\"v\":1,\"seq\":3,\"type\":\"tool.result\",\"turnId\":\"t1\"}",
  ]);
  expect(frames.length == 2);
  let apart: number = 450.0;
  expect(frames[1].at - frames[0].at == apart);

  let stamp: number = 1770000000000.0;
  let none: number = 0.0;
  expect(jouleMailboxAt("1770000000000|F|{}") == stamp);
  // Anything that is not a plain run of digits answers 0 rather than a guess:
  // the value is subtracted from another one, and a partly-read stamp is a
  // duration that is wrong rather than one that is absent.
  expect(jouleMailboxAt("17x0|F|{}") == none);
  expect(jouleMailboxAt("|F|{}") == none);
  expect(jouleMailboxAt("no bars here") == none);
  expect(jouleMailboxAt("") == none);
});

test("a frame's flag is true only when it says true", () => {
  // `ok` on a tool.result, and a missing one read as true would draw a failed
  // call in the thread as a good one.
  let good = "{\"type\":\"tool.result\",\"callId\":\"c1\",\"ok\":true,\"truncated\":false}";
  expect(jouleFrameBool(good, "ok"));
  expect(!jouleFrameBool(good, "truncated"));
  expect(!jouleFrameBool(good, "nothing"));
  expect(!jouleFrameBool("{\"ok\":null}", "ok"));
  expect(!jouleFrameBool("{\"ok\":\"true\"}", "ok"));
  expect(!jouleFrameBool("{\"ok\":1}", "ok"));
  expect(!jouleFrameBool("", "ok"));
});

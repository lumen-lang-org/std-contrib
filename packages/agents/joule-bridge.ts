import { Db } from "../plume/driver.ts";
import { jsonStringMemberAt, jsonIntMemberAt } from "../ai/core/jsonscan.ts";
import { EnvRow, ENV_HOME, envContainerName, envDockerBin, envMarkAgent } from "./environments.ts";

// Driving a joule daemon that lives inside a hardened container, over
// `docker exec` and nothing else.
//
// The daemon listens on 127.0.0.1 inside its own network namespace, and an
// environment made by envRunArgs publishes one port at most and often sits on
// `--network none`. So the websocket in docs/08-daemon-frame-protocol.md is
// not reachable from here, and making it reachable would be the first hole in
// a container model whose hardening was deliberate work.
//
// No hole is needed. The daemon's frame plumbing is file-backed and the
// websocket is a shim over it: `SessionWorker.drainOnce` reads frames out of
// `<runtimeDir>/inbox/<connId>.in`, and every outbound frame is appended to
// `<runtimeDir>/broadcast.log` before any client sees it. Both are ordinary
// files under HOME, which is a volume and writable even with the rootfs
// read-only. Writing one line and reading a byte range of another is the whole
// transport, and it is the same `docker exec` primitive env-sync and
// run-script already use.
//
// Two things about this route are worth knowing before using it.
//
// The inbox is MORE privileged than the socket. `isAcceptedInboundType` gates
// what a websocket client may submit to eight frame types; `drainOnce` hands
// whatever it finds in the file straight to `dispatchDaemonFrame`. Nothing
// here widens that — every frame this file writes is one of the eight — but a
// caller should know that the file is not checked and not treat it as if it
// were.
//
// The cursor dies with the container. `sweepInbox` deletes every `*.in` and
// `startBroadcastLog` truncates the log at daemon startup, so a byte offset
// kept across a restart points past the end of a shorter file. envMarkAgent
// already zeroes agentRead whenever the connection id is cleared, which is why
// clearing it is the only supported way to say the daemon is gone.

/** The runtime directory the daemon is told to use, rather than one derived
 *  here.
 *
 *  The derived name is a slug and a sha1 of the workspace path
 *  (`sessionKeyFor`, joule-sh/code). Recomputing that hash in Lumen on this
 *  side would be one hash in two languages in two repositories, drifting the
 *  first time either moved. joule v0.23.20 honours JOULE_DAEMON_RUNTIME_DIR
 *  instead, so the engine names the directory and there is nothing to derive.
 *  It must be absolute — a relative one is refused, because two processes with
 *  different working directories would resolve it to two places and the
 *  failure would be silence rather than an error.
 *
 *  Under HOME because HOME is the volume: the rootfs is read-only and the
 *  daemon's first act is to create this directory and clear a file in it. */
export function jouleRuntimeDir(): string {
  return ENV_HOME + "/.config/joule-code/daemon/agents-env";
}

export function jouleInboxPath(connId: string): string {
  return jouleRuntimeDir() + "/inbox/" + connId + ".in";
}

export function jouleBroadcastPath(): string {
  return jouleRuntimeDir() + "/broadcast.log";
}

/** The version of joule this transport was written against, and the floor for
 *  the image. v0.23.20 is where JOULE_DAEMON_RUNTIME_DIR and `--mode` arrived;
 *  against an earlier release the runtime directory is a hash this side cannot
 *  name and the daemon comes up in safe-auto, blocking on approval.request
 *  frames nobody will answer. */
export const JOULE_MIN_VERSION: string = "0.23.20";

/** The mode a delegated environment's daemon runs in.
 *
 *  Nobody is attached to answer an approval.request, and the gate burns
 *  APPROVAL_TIMEOUT_MS per gated call before denying it. Passed as a startup
 *  flag rather than sent as a mode.set frame afterwards: a frame races the
 *  first turn, and losing that race is a turn that stalls two minutes at a
 *  time for reasons nothing reports. */
export const JOULE_MODE: string = "full-auto";

const JOULE_TAG: string = "F";
const JOULE_WORKSPACE: string = "/workspace";

// ---------------------------------------------------------------------------
// Frames, as text
// ---------------------------------------------------------------------------

/** A JSON string literal, escaped so the result is one line.
 *
 *  Written out rather than reached for, because this is the function that can
 *  corrupt the mailbox. A payload is one line and the reader splits on "\n":
 *  a raw newline inside a frame does not produce a bad frame, it produces two
 *  half-frames and a reader that has lost its place for the rest of the
 *  session. Every control byte goes out as an escape for that reason, not only
 *  the ones that would be invalid JSON. */
export function jouleJsonString(text: string): string {
  let out = "\"";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    let ch = text.charAt(i);
    i = i + 1;
    if (ch == "\"") {
      out = out + "\\\"";
    } else if (ch == "\\") {
      out = out + "\\\\";
    } else if (c == 10) {
      out = out + "\\n";
    } else if (c == 13) {
      out = out + "\\r";
    } else if (c == 9) {
      out = out + "\\t";
    } else if (c == 8) {
      out = out + "\\b";
    } else if (c == 12) {
      out = out + "\\f";
    } else if (c < 32) {
      out = out + "\\u00" + jouleHexByte(c);
    } else {
      out = out + ch;
    }
  }
  return out + "\"";
}

function jouleHexByte(c: int): string {
  let digits = "0123456789abcdef";
  return digits.charAt((c / 16) % 16) + digits.charAt(c % 16);
}

/** The frame that starts the flow of frames.
 *
 *  Not optional and not a formality: `daemonOnMessage` starts the per-peer
 *  pusher only on resume, and `SessionWorker` only begins draining once there
 *  is something to drain for. A client that writes an input frame and then
 *  waits sits for ever on a connection with nothing wrong with it. `since` of
 *  -1 asks for everything the daemon has emitted, which for a daemon the
 *  engine just started is everything there is. */
export function jouleResumeFrame(since: int): string {
  return "{\"v\":1,\"seq\":0,\"type\":\"resume\",\"since\":" + `${since}` + "}";
}

/** A task, submitted as if someone had typed it.
 *
 *  Reaches RelayInputBridge.offer and then Session.submit. Input arriving
 *  while a turn is running is queued and submitted in order as the previous
 *  turn returns — not dropped, and not interleaved — so this is safe to send
 *  at any time and may simply not run at once. */
export function jouleInputFrame(text: string): string {
  return "{\"v\":1,\"seq\":0,\"type\":\"input\",\"text\":" + jouleJsonString(text) + "}";
}

/** One mailbox line: when it was written, what kind of line it is, and the
 *  frame. `src/tasks/mailbox.ts:mailboxLine` in joule-sh/code is the other
 *  side of this, and tag "F" is the frame tag both the inbox and the broadcast
 *  log use. */
export function jouleFrameLine(json: string): string {
  return `${Date.now()}` + "|" + JOULE_TAG + "|" + json + "\n";
}

// ---------------------------------------------------------------------------
// Frames, as read back
// ---------------------------------------------------------------------------

export type JouleFrame = {
  /** The daemon's own counter over everything it has emitted, starting at 1
   *  for session.hello. Per-daemon, not per-turn and not per-client. */
  seq: int,
  type: string,
  /** Empty on the frames that do not belong to a turn — session.hello,
   *  mode.changed, daemon.stopping. */
  turnId: string,
  json: string,
};

/** Read the fields worth routing on, and leave the rest in the text.
 *
 *  Field by field rather than by decoding the whole frame: the frame set has
 *  28 types with different shapes, JSON.parse<T> here is exact and returns
 *  null for any frame carrying a field the record does not declare, and a
 *  frame set that gains a field is a frame set this would stop reading
 *  altogether. The daemon reads its own inbound frames the same way. */
export function jouleFrameOf(json: string): JouleFrame {
  let one: JouleFrame = {
    seq: jsonIntMemberAt(json, 0, "seq"),
    type: jsonStringMemberAt(json, 0, "type"),
    turnId: jsonStringMemberAt(json, 0, "turnId"),
    json: json,
  };
  return one;
}

/** The frames in a chunk of broadcast log, and nothing else.
 *
 *  Only whole lines. A read that lands mid-line is the ordinary case — the
 *  daemon appends while this reads — and half a frame parsed is a frame with
 *  the wrong type or no turn id at all, which is worse than one read a tick
 *  later. jouleTailRead is the matching arithmetic: the cursor advances by the
 *  bytes of the whole lines only, so the partial line is read again next
 *  time. */
export function jouleFramesFrom(chunk: string): JouleFrame[] {
  let out: JouleFrame[] = [];
  let end = chunk.lastIndexOf("\n");
  if (end < 0) {
    return out;
  }
  let lines = chunk.slice(0, end).split("\n");
  let i: int = 0;
  while (i < lines.length) {
    let line = lines[i];
    i = i + 1;
    let payload = jouleMailboxPayload(line, JOULE_TAG);
    if (payload == "") {
      continue;
    }
    out.push(jouleFrameOf(payload));
  }
  return out;
}

/** The payload of one mailbox line whose tag is `tag`, or "".
 *
 *  Split on the first two bars and not on every bar: a frame carries model
 *  output, and model output contains bars. */
export function jouleMailboxPayload(line: string, tag: string): string {
  let first = line.indexOf("|");
  if (first < 0) {
    return "";
  }
  let rest = line.slice(first + 1, line.length);
  let second = rest.indexOf("|");
  if (second < 0) {
    return "";
  }
  if (rest.slice(0, second) != tag) {
    return "";
  }
  return rest.slice(second + 1, rest.length);
}

/** How far the cursor moves for a chunk that starts at `sinceBytes`.
 *
 *  Bytes of complete lines, so a partial line at the end is re-read rather
 *  than skipped. Strings here are byte-length, which is what makes this agree
 *  with an offset the shell counted: a frame carrying a non-ASCII character
 *  would advance the cursor by fewer than its bytes if this counted anything
 *  else, and every read after it would start mid-frame. */
export function jouleTailRead(sinceBytes: int, chunk: string): int {
  let from = sinceBytes > 0 ? sinceBytes : 0;
  let end = chunk.lastIndexOf("\n");
  if (end < 0) {
    return from;
  }
  return from + end + 1;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/** Whether a turn id belongs to something the engine did not ask for.
 *
 *  Background runs and subagents emit on the same broadcast log with `bg:` and
 *  `agent:` prefixed ids, interleaved freely with the foreground turn. Their
 *  turn.end is not the turn's end, and reading it as one harvests a workspace
 *  the delegated turn is still writing to. */
export function jouleIsTaskTurn(turnId: string): bool {
  return turnId.startsWith("bg:") || turnId.startsWith("agent:");
}

/** The id the daemon gave the turn this text started, or "".
 *
 *  Matched on the prompt because there is nothing else to match on: an input
 *  frame carries no id, the daemon assigns `t<n>` when the turn actually
 *  begins, and the assignment comes back on turn.start and nowhere else.
 *  Session.submit echoes the submitted text verbatim as turn.start.prompt —
 *  it suppresses nothing, for any client — so the echo is the answer.
 *
 *  Task turns are skipped, and so is any turn.start whose prompt is something
 *  else. Two identical prompts in one session are indistinguishable here and
 *  the first one wins; a caller that cares should read from a cursor taken
 *  before it sent, so the only turn.start it can see is its own. */
export function jouleTurnFor(frames: JouleFrame[], prompt: string): string {
  let i: int = 0;
  while (i < frames.length) {
    let f = frames[i];
    i = i + 1;
    if (f.type != "turn.start" || jouleIsTaskTurn(f.turnId)) {
      continue;
    }
    if (jsonStringMemberAt(f.json, 0, "prompt") == prompt) {
      return f.turnId;
    }
  }
  return "";
}

/** Why a turn ended, or "" while it has not.
 *
 *  `done`, `cancelled` or `error`. turn.end is the only reliable end, and the
 *  daemon persists the session on it, so the workspace is consistent at the
 *  moment this answers. */
export function jouleTurnEndReason(frames: JouleFrame[], turnId: string): string {
  if (turnId == "" || jouleIsTaskTurn(turnId)) {
    return "";
  }
  let i: int = 0;
  while (i < frames.length) {
    let f = frames[i];
    i = i + 1;
    if (f.type == "turn.end" && f.turnId == turnId) {
      let why = jsonStringMemberAt(f.json, 0, "reason");
      return why == "" ? "done" : why;
    }
  }
  return "";
}

/** The frames of one turn, in the order the daemon emitted them. */
export function jouleFramesFor(frames: JouleFrame[], turnId: string): JouleFrame[] {
  let out: JouleFrame[] = [];
  if (turnId == "") {
    return out;
  }
  let i: int = 0;
  while (i < frames.length) {
    if (frames[i].turnId == turnId) {
      out.push(frames[i]);
    }
    i = i + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The shell, built apart from the running of it
// ---------------------------------------------------------------------------

/** One shell word, single-quoted, whatever is in it.
 *
 *  A frame is JSON and JSON is full of double quotes, so single quotes are the
 *  only quoting that does not require reading the payload. The one character
 *  single quotes cannot carry is a single quote, which model output has in
 *  every other sentence; `'\''` closes, escapes and reopens. */
export function jouleShellQuote(text: string): string {
  let out = "'";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    i = i + 1;
    out = out + (ch == "'" ? "'\\''" : ch);
  }
  return out + "'";
}

/** Append one mailbox line to a connection's inbox.
 *
 *  printf and not echo: echo interprets backslashes in some shells and not
 *  others, and a frame is full of them. `%s` and not the line as the format
 *  string, because a frame carrying a percent sign would otherwise be read as
 *  a conversion. */
export function jouleAppendCmd(connId: string, line: string): string {
  return "printf '%s' " + jouleShellQuote(line) + " >> " + jouleInboxPath(connId);
}

/** Read the broadcast log from a byte offset. `tail -c +N` counts from 1, so a
 *  cursor of 0 bytes read is `+1`. A log that does not exist yet is not an
 *  error — the daemon is still starting — and answers as empty. */
export function jouleTailCmd(sinceBytes: int): string {
  let from = (sinceBytes > 0 ? sinceBytes : 0) + 1;
  return "tail -c +" + `${from}` + " " + jouleBroadcastPath() + " 2>/dev/null || true";
}

const JOULE_READY_TRIES: int = 100;
const JOULE_READY_WAIT: string = "0.2";

/** Wait, inside the container, for the daemon to have made its runtime
 *  directory.
 *
 *  Inside rather than out here because `docker exec -d` returns the moment the
 *  process is spawned and says nothing about whether it got as far as creating
 *  the inbox. A frame written before then goes into a directory the daemon
 *  then sweeps, and the loss is silent. One exec that blocks is cheaper than a
 *  poll loop on this side and does not need a clock. */
export function jouleReadyCmd(): string {
  return "i=0; while [ $i -lt " + `${JOULE_READY_TRIES}` + " ]; do"
    + " if [ -d " + jouleRuntimeDir() + "/inbox ] && [ -f " + jouleBroadcastPath() + " ]; then exit 0; fi;"
    + " sleep " + JOULE_READY_WAIT + "; i=$((i+1)); done; exit 1";
}

/** What starts the daemon, as one shell command.
 *
 *  cd first: the daemon takes its workspace root from the working directory,
 *  and a daemon rooted somewhere else reads another directory's instructions
 *  and writes its files there. The runtime directory is named outright rather
 *  than derived, and the mode is a flag rather than a frame — see
 *  jouleRuntimeDir and JOULE_MODE for why each. */
export function jouleStartCmd(): string {
  return "cd " + JOULE_WORKSPACE
    + " && JOULE_DAEMON_RUNTIME_DIR=" + jouleShellQuote(jouleRuntimeDir())
    + " joule-daemon --mode " + JOULE_MODE;
}

// ---------------------------------------------------------------------------
// docker
// ---------------------------------------------------------------------------

type JouleReply = {
  status: int,
  stdout: string,
  stderr: string,
};

function jouleDocker(args: string[]): JouleReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let out: JouleReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return out;
}

function jouleExec(row: EnvRow, command: string): JouleReply {
  return jouleDocker(["exec", envContainerName(row.threadId, row.name), "sh", "-c", command]);
}

/** Write one frame into a daemon's inbox. Returns why it could not be
 *  written, if it could not. */
export function jouleSend(row: EnvRow, connId: string, frameJson: string): string {
  if (connId == "") {
    return "this environment has no daemon to write to";
  }
  let wrote = jouleExec(row, jouleAppendCmd(connId, jouleFrameLine(frameJson)));
  if (wrote.status != 0) {
    return "the daemon's inbox could not be written: " + jouleFirstLine(wrote.stderr);
  }
  return "";
}

export type JouleTailed = {
  ok: bool,
  frames: JouleFrame[],
  /** Where the next read starts. Unchanged from `sinceBytes` when nothing
   *  whole arrived, so a partial frame is read again rather than lost. */
  read: int,
  fault: string,
};

/** The frames the daemon has emitted since a byte offset, and the offset to
 *  ask from next time.
 *
 *  A byte count is the whole cursor: the log is append-only within a daemon's
 *  life and nothing rewrites what is behind it. Across a restart it is not,
 *  which is why envMarkAgent zeroes it with the connection id. */
export function jouleTail(row: EnvRow, sinceBytes: int): JouleTailed {
  let none: JouleFrame[] = [];
  let read = jouleExec(row, jouleTailCmd(sinceBytes));
  if (read.status != 0) {
    let bad: JouleTailed = {
      ok: false, frames: none, read: sinceBytes,
      fault: "the daemon's log could not be read: " + jouleFirstLine(read.stderr),
    };
    return bad;
  }
  let got: JouleTailed = {
    ok: true,
    frames: jouleFramesFrom(read.stdout),
    read: jouleTailRead(sinceBytes, read.stdout),
    fault: "",
  };
  return got;
}

export type JouleStarted = {
  ok: bool,
  connId: string,
  fault: string,
};

/** Bring a daemon up inside an environment and get it talking.
 *
 *  Three steps and all three are load-bearing. It is started detached, the
 *  same way envStart runs a serve command, because it runs for the life of the
 *  environment. It is waited for, because docker exec -d says nothing about
 *  whether the inbox exists yet. And it is sent a resume frame, because the
 *  daemon pushes nothing at all until it receives one — a client that skips
 *  this and writes an input frame waits for ever, with no error, on a daemon
 *  that is perfectly healthy.
 *
 *  The connection id goes on the row last, once there is something to address.
 *  Writing it earlier would take the environment out of the idle sweep's reach
 *  on the strength of a daemon that might not have started. */
export function jouleStart(db: Db, row: EnvRow, connId: string): JouleStarted {
  if (row.id == "") {
    let gone: JouleStarted = { ok: false, connId: "", fault: "no such environment" };
    return gone;
  }
  if (!jouleSafeConnId(connId)) {
    let bad: JouleStarted = { ok: false, connId: "",
      fault: "a connection id is 1 to 128 of [0-9A-Za-z-] and this is not one" };
    return bad;
  }
  let container = envContainerName(row.threadId, row.name);
  let spawned = jouleDocker(["exec", "-d", container, "sh", "-c", jouleStartCmd()]);
  if (spawned.status != 0) {
    let no: JouleStarted = { ok: false, connId: "",
      fault: "the daemon could not be started: " + jouleFirstLine(spawned.stderr) };
    return no;
  }
  let ready = jouleExec(row, jouleReadyCmd());
  if (ready.status != 0) {
    // The daemon exits rather than limping when it cannot start, and it says
    // why on stdout — no credentials, a runtime directory it could not make, a
    // broadcast log it could not clear. That message is in `docker logs` only
    // if it were the container's main process, which it is not, so what is
    // said here is the shape of the failure and not its reason.
    let never: JouleStarted = { ok: false, connId: "",
      fault: "the daemon did not create its runtime directory, so it is not running" };
    return never;
  }
  let sent = jouleSend(row, connId, jouleResumeFrame(-1));
  if (sent != "") {
    let mute: JouleStarted = { ok: false, connId: "", fault: sent };
    return mute;
  }
  let marked = envMarkAgent(db, row, connId, 0);
  if (marked != "") {
    let lost: JouleStarted = { ok: false, connId: connId,
      fault: "the daemon is running but the environment does not know it: " + marked };
    return lost;
  }
  let up: JouleStarted = { ok: true, connId: connId, fault: "" };
  return up;
}

/** Hand a task to the daemon in an environment.
 *
 *  One input frame. The turn id it produces is not knowable here — the daemon
 *  assigns it when the turn begins and reports it on turn.start — so what
 *  comes back is the cursor to read from and the prompt to match, which is
 *  what jouleTurnFor takes. Reading from a cursor taken before the frame was
 *  written is what makes that match unambiguous. */
export type JouleTasked = {
  ok: bool,
  /** Where the turn's frames begin. Taken before the input frame is written,
   *  so no turn.start can be missed between the two. */
  from: int,
  /** What the log already held, which the cursor has now moved past.
   *
   *  Handed back rather than dropped. Taking that cursor means reading, and
   *  frames a background task emitted between the last poll and this call
   *  would otherwise be read here and never seen by whatever is polling. */
  seen: JouleFrame[],
  prompt: string,
  fault: string,
};

export function jouleTask(db: Db, row: EnvRow, text: string): JouleTasked {
  let nothing: JouleFrame[] = [];
  if (row.agentConn == "") {
    let none: JouleTasked = { ok: false, from: row.agentRead, seen: nothing, prompt: text,
      fault: "no daemon is running in this environment" };
    return none;
  }
  if (text.trim() == "") {
    let empty: JouleTasked = { ok: false, from: row.agentRead, seen: nothing, prompt: text,
      fault: "a task with nothing in it" };
    return empty;
  }
  let before = jouleTail(row, row.agentRead);
  if (!before.ok) {
    let blind: JouleTasked = { ok: false, from: row.agentRead, seen: nothing, prompt: text,
      fault: before.fault };
    return blind;
  }
  let sent = jouleSend(row, row.agentConn, jouleInputFrame(text));
  if (sent != "") {
    let no: JouleTasked = { ok: false, from: before.read, seen: before.frames, prompt: text,
      fault: sent };
    return no;
  }
  // Whatever the log already held is behind the task now, and reading it again
  // would find an older turn.start for a prompt this one repeats.
  let marked = envMarkAgent(db, row, row.agentConn, before.read);
  if (marked != "") {
    console.error("joule-bridge: " + row.id + " was handed a task but its cursor was not "
      + "written, so the frames before it will be read again: " + marked);
  }
  let gone: JouleTasked = { ok: true, from: before.read, seen: before.frames, prompt: text,
    fault: "" };
  return gone;
}

/** The alphabet a connection id may use, which is the daemon's own rule
 *  (`isSafeConnId`). It is a path component and it is chosen on this side, so
 *  it is checked on this side. */
export function jouleSafeConnId(connId: string): bool {
  if (connId == "" || connId.length > 128) {
    return false;
  }
  let i: int = 0;
  while (i < connId.length) {
    let c = connId.charCodeAt(i);
    let fine = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45;
    if (!fine) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

const JOULE_FAULT_MAX: int = 200;

function jouleFirstLine(text: string): string {
  let end: int = 0;
  while (end < text.length && text.charCodeAt(end) != 10 && text.charCodeAt(end) != 13) {
    end = end + 1;
  }
  let line = text.slice(0, end).trim();
  return line.length <= JOULE_FAULT_MAX ? line : line.slice(0, JOULE_FAULT_MAX) + "...";
}

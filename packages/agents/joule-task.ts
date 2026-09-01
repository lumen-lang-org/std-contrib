import { Db } from "../plume/driver.ts";
import { jsonStringMemberAt } from "../ai/core/jsonscan.ts";
import { EnvRow, envEnsure, envNamed } from "./environments.ts";
import { ENV_AGENT_NOTE, ENV_WORKSPACE, envHarvestNow, envMaterialise } from "./env-sync.ts";
import { envThreadOwner } from "./env-grants.ts";
import { credentialFor, masterKey } from "./credentials.ts";
import { findById } from "../plume/plume.ts";
import { AgentRow, agentsMapping, configAndModel } from "./schema.ts";
import { envKeyFileBody, touchEnvKeys } from "./env-keys.ts";
import { JOULE_ENV_NAME, JouleFrame, JouleLaunch, jouleSafeConnId, jouleStart, jouleTail, jouleTask, jouleTurnEndReason, jouleTurnFor } from "./joule-bridge.ts";
import { scriptImageForEnv, scriptImageIdForEnv } from "./run-script.ts";

// Handing a piece of work to an agent that lives in a container, and following
// it until it is done.
//
// joule-bridge.ts is the transport — one frame in, a byte range of log out.
// This is what a tool call turns into: an environment made and filled from the
// conversation, a daemon started in it, a task handed over, and the turn read
// back. The two are apart because the transport has no opinions and this is
// nothing but opinions — which image, which name, how long to wait, what to
// say about it afterwards.
//
// What this deliberately does NOT do is harvest. Files the delegate writes come
// back through envSyncOut on the workspace sweep, which already selects an
// environment with a daemon in it, already takes the container's clock before
// the find, and already writes the stamp after. Reaching in here to run a
// second sync would be a second reader on one row's cursor, and the sweep's
// correctness rests on there being one.

// The environment's name is JOULE_ENV_NAME, from joule-bridge.ts, and it is
// fixed rather than chosen by the caller because the name is what resolves the
// image: scriptImageForEnv folds an environment's name against the script-image
// labels, and "joule" is the label the deployment seeds. A caller-chosen name
// would resolve some other image, and an image with no joule-daemon in it fails
// as a daemon that will not start rather than as a name that was wrong.

/** How long a tool call follows a delegated turn before handing back.
 *
 *  A budget rather than a wait: the daemon is not asked to hurry and nothing
 *  is cancelled when this runs out — the turn goes on inside the container and
 *  its files still come back on the sweep. What runs out is this call's
 *  patience, and it is bounded because a tool call holds a request open.
 *
 *  Counted in polls, so the exec each poll costs is not counted against it and
 *  the real ceiling is a little above this. Naming that rather than measuring
 *  a clock: the honest thing to bound is how many times this asks, and a
 *  deadline read off two machines' clocks is the kind of arithmetic that goes
 *  wrong quietly. */
export const JOULE_WAIT_SECONDS: int = 180;
const JOULE_POLL_MS: int = 2000;

let jouleWaitChosen: int = 0;

/** For a test that would otherwise sit here for three minutes. */
export function jouleWaitOverride(seconds: int): void {
  jouleWaitChosen = seconds;
}

export function jouleWaitSeconds(): int {
  if (jouleWaitChosen > 0) {
    return jouleWaitChosen;
  }
  let said = (process.env("AGENTS_JOULE_WAIT_SECONDS") ?? "").trim();
  if (said == "") {
    return JOULE_WAIT_SECONDS;
  }
  let asked = parseInt(said) ?? 0;
  if (asked < 30 || asked > 900) {
    return JOULE_WAIT_SECONDS;
  }
  return asked;
}

/** How much of what the delegate said is carried back. A turn's text is a
 *  whole reply, and the model reading this asked for work to be done rather
 *  than for a transcript. */
const JOULE_SAID_MAX: int = 4000;

const JOULE_STAGE: string = "/tmp/agents-joule-";

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** What is actually submitted: the task, and the two things the delegate has
 *  no way to know.
 *
 *  It cannot know that /workspace is somebody's conversation rather than a
 *  checkout, so it is told to edit in place — a delegate that prints a patch
 *  has done nothing, because only the files come back. And it cannot know that
 *  nobody is reading: full-auto removes the approval gate but not the model's
 *  habit of ending a turn on a question, and a question asked here is a turn
 *  that ended having changed nothing.
 *
 *  Built here and used for both the send and the match: turn.start echoes the
 *  submitted text verbatim, and jouleTurnFor finds the turn by comparing
 *  against it, so the two must be the same string. */
export function joulePrompt(task: string): string {
  return task.trim()
    + "\n\nThe files of the conversation that asked for this are in your"
    + " current working directory, which is where you already are. Refer to a"
    + " file by the path it has in the conversation with the leading slash"
    + " dropped: the conversation's /logo.png is logo.png here. Do not prefix"
    + " an absolute path and do not write outside this directory, since the"
    + " rest of the filesystem is read-only. Edit files in place; what you"
    + " write here is what comes back, and a patch printed instead of applied"
    + " is lost."
    + " A file people open — a deck, a document, a spreadsheet, a picture — has a command"
    + " here that makes one, and these are commands on PATH rather than skills to load:"
    + " make-deck, make-doc, make-sheet, fill-docx, read-docx, extract-image, fetch-image."
    + " Run one with no arguments to read its spec, and prefer it to writing the library"
    + " by hand, which is where turns go. fetch-image is how a picture comes from the web:"
    + " the shell's own fetching is refused with nobody here to approve it."
    + " python3 already has python-pptx, python-docx, openpyxl, Pillow, matplotlib, numpy,"
    + " cairosvg, requests, lxml, pypdf and playwright, and LibreOffice is on PATH."
    + " Installing is not part of this: pip refuses a system install and a virtual"
    + " environment costs a turn to build, so work with what is listed or say what is"
    + " missing."
    + " Nobody is attached to answer a question, so finish the work"
    + " rather than asking about it."
    + " Your steps are limited and a turn that runs out is a turn that failed, so spend them"
    + " on the work: take the first approach that will do, run it, and stop when the task is"
    + " met. Do not tune what already works, weigh alternatives you were not asked for, or"
    + " polish past the brief.";
}

// ---------------------------------------------------------------------------
// Reading a turn back
// ---------------------------------------------------------------------------

export type JouleRead = {
  /** The tools the delegate ran, in the order it ran them. */
  tools: string[],
  /** Its reply, the text deltas joined, cut to JOULE_SAID_MAX. */
  said: string,
  /** Whether the text above was cut. */
  cut: bool,
  /** Approvals it asked for. Should be none — the daemon runs in full-auto —
   *  and any at all mean the mode flag did not land, which is a turn that will
   *  stall for two minutes per gated call rather than fail. */
  approvals: int,
  /** What the daemon reported as an error. Not filtered by turn: an `error`
   *  frame carries a code and a message and no turnId at all, so the only
   *  honest scope for it is the window this call read. */
  errors: string[],
};

/** What one turn did, read out of the frames of the window it ran in.
 *
 *  Field by field off each frame rather than by decoding it: the frame set has
 *  28 shapes and grows, and a reader that parses whole frames is a reader that
 *  stops working when one of them gains a field. */
export function jouleParted(said: string): string {
  if (said == "" || said.endsWith("\n\n")) {
    return said;
  }
  return said.trimEnd() + "\n\n";
}

export function jouleReadTurn(frames: JouleFrame[], turnId: string): JouleRead {
  let tools: string[] = [];
  let errors: string[] = [];
  let said = "";
  let approvals: int = 0;
  let i: int = 0;
  while (i < frames.length) {
    let f = frames[i];
    i = i + 1;
    if (f.type == "error") {
      let why = jsonStringMemberAt(f.json, 0, "message");
      errors.push(why == "" ? jsonStringMemberAt(f.json, 0, "code") : why);
      continue;
    }
    if (turnId == "" || f.turnId != turnId) {
      continue;
    }
    if (f.type == "tool.call") {
      tools.push(jsonStringMemberAt(f.json, 0, "tool"));
      said = jouleParted(said);
    } else if (f.type == "text.delta") {
      said = said + jsonStringMemberAt(f.json, 0, "text");
    } else if (f.type == "approval.request") {
      approvals = approvals + 1;
      said = jouleParted(said);
    }
  }
  let whole = said.trim();
  let cut = whole.length > JOULE_SAID_MAX;
  let one: JouleRead = {
    tools: tools,
    said: cut ? whole.slice(0, JOULE_SAID_MAX) : whole,
    cut: cut,
    approvals: approvals,
    errors: errors,
  };
  return one;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

type JouleSecret = {
  /** The directory to remove once the daemon has been started, or "". */
  dir: string,
  file: string,
  fault: string,
};

function mainChatKeys(db: Db, agentId: string): string {
  let doc = findById(db, agentsMapping(), agentId);
  if (doc == "") {
    return "";
  }
  let agent = JSON.parse<AgentRow>(doc);
  let held = configAndModel(db, agent.modelConfigId);
  if (held.fault != "") {
    return "";
  }
  let key = credentialFor(db, held.model.provider, masterKey());
  if (key == "") {
    return "";
  }
  let out = "JOULE_CODE_API_KEY=" + key + "\n";
  let base = held.model.baseUrl;
  if (base.endsWith("/")) {
    base = base.slice(0, base.length - 1);
  }
  if (base.endsWith("/v1")) {
    base = base.slice(0, base.length - 3);
  }
  if (base != "") {
    out = out + "JOULE_CODE_BASE_URL=" + base + "\n";
  }
  if (held.model.apiName != "") {
    out = out + "JOULE_CODE_MODEL=" + held.model.apiName + "\n";
  }
  return out;
}

/** The daemon's credentials, staged as a file for one `docker exec`.
 *
 *  A daemon with no key exits before it makes its runtime directory, so this
 *  is the difference between delegation working and a container that looks
 *  like it is still starting. The keys are the ones an operator already put on
 *  the joule image through the environment-keys route — JOULE_CODE_API_KEY,
 *  and JOULE_CODE_BASE_URL and JOULE_CODE_MODEL where the deployment does not
 *  use the defaults. Nothing new is invented for this: it is the same store
 *  run-script.ts reads for a script's own variables, and the same staged file
 *  handed the same way, mode 0600 and removed afterwards.
 *
 *  No keys is not an error here. A deployment can put a config.json in the
 *  home volume instead, and refusing on an empty key set would refuse that
 *  perfectly good arrangement; jouleStart names the possibility if the daemon
 *  then fails to come up. */
function jouleSecret(db: Db, threadId: string, agentId: string, slug: string, now: string): JouleSecret {
  let none: JouleSecret = { dir: "", file: "", fault: "" };
  let owner = envThreadOwner(db, threadId);
  let imageId = scriptImageIdForEnv(db, agentId, JOULE_ENV_NAME);
  if (imageId == "") {
    return none;
  }
  let body = envKeyFileBody(db, owner, imageId, masterKey());
  if (!body.includes("JOULE_CODE_API_KEY=")) {
    body = body + mainChatKeys(db, agentId);
  }
  if (body == "") {
    return none;
  }
  let dir = JOULE_STAGE + slug;
  let at = dir + "/env";
  try {
    fs.mkdirSync(dir, true);
    fs.writeFileSync(at, body);
    // Before the exec, not after: between writing and chmod the file is
    // readable by everything on the host, and it holds a key.
    fs.chmodSync(at, 384);
  } catch (e) {
    let bad: JouleSecret = { dir: dir, file: "",
      fault: "the daemon's credentials could not be staged" };
    return bad;
  }
  touchEnvKeys(db, owner, imageId, now);
  let staged: JouleSecret = { dir: dir, file: at, fault: "" };
  return staged;
}

function jouleDropSecret(dir: string): void {
  if (dir == "") {
    return;
  }
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, true);
    }
  } catch (e) {
    // The exec has already run and the key is already in the daemon. What is
    // left is a file in /tmp, which is worth saying nothing about and not
    // worth failing a delegated turn over.
    return;
  }
}

/** The id frames are addressed under. One per environment and stable across
 *  calls, because it is a file name the daemon reads from: a fresh id per call
 *  would leave a mailbox per call behind, each one drained by nobody. */
export function jouleConnFor(slug: string): string {
  if (slug == "") {
    return "";
  }
  let id = "engine-" + slug;
  return jouleSafeConnId(id) ? id : "";
}

// ---------------------------------------------------------------------------
// The delegation
// ---------------------------------------------------------------------------

export type JouleAsk = {
  threadId: string,
  agentId: string,
  task: string,
  now: string,
};

export type JouleDelegated = {
  ok: bool,
  /** The id the daemon gave the turn, or "" when it never reported one. */
  turnId: string,
  /** Why the turn ended — done, cancelled or error — or "" while it has not
   *  ended, which is what running out of the budget looks like. */
  reason: string,
  read: JouleRead,
  /** Whether this call is what made the environment. */
  created: bool,
  /** Whether this call is what started the daemon. */
  started: bool,
  harvested: int,
  fault: string,
};

function jouleNothing(): JouleRead {
  let none: string[] = [];
  let alsoNone: string[] = [];
  let empty: JouleRead = { tools: none, said: "", cut: false, approvals: 0, errors: alsoNone };
  return empty;
}

function jouleFailed(fault: string, created: bool, started: bool): JouleDelegated {
  let bad: JouleDelegated = {
    harvested: -1,
    ok: false, turnId: "", reason: "", read: jouleNothing(),
    created: created, started: started, fault: fault,
  };
  return bad;
}

/** Make the environment, fill it, start it, start the daemon, hand over the
 *  task, and follow the turn.
 *
 *  The two envEnsure calls are not a redundancy. The first makes a container
 *  without running anything in it, so the workspace can be written before
 *  anything reads it; the second starts it. Reversed, the daemon comes up
 *  against an empty /workspace, and its death races the start that would have
 *  worked — which is what EnvEnsure.start is documented as being for, and what
 *  serve_env does for the same reason. envMaterialise between them is also
 *  what hands the volumes to the uid the container runs as, and a joule daemon
 *  that finds /workspace owned by root aborts with an AccessDenied panic and
 *  no frame, so that call is not optional either. */
export function jouleDelegate(db: Db, ask: JouleAsk): JouleDelegated {
  if (ask.threadId == "") {
    return jouleFailed("a delegated task belongs to a conversation, and this names none", false, false);
  }
  if (ask.task.trim() == "") {
    return jouleFailed("a delegated task with nothing in it", false, false);
  }
  let image = scriptImageForEnv(db, ask.agentId, JOULE_ENV_NAME);
  if (image == "") {
    return jouleFailed("this deployment has no joule environment — the image row labelled"
      + " \"" + JOULE_ENV_NAME + "\" is missing or switched off, and no other image carries a"
      + " daemon to delegate to", false, false);
  }
  let made = envEnsure(db, {
    threadId: ask.threadId, name: JOULE_ENV_NAME, image: image,
    // A network, because the daemon talks to a model API and does nothing at
    // all without one. No published port: the engine reaches it through
    // docker exec and a file, so there is nothing for the gateway to route.
    network: true, serve: false, command: "", start: false,
    agent: true, now: ask.now,
  });
  if (!made.ok) {
    return jouleFailed(made.fault, false, false);
  }
  if (made.created) {
    let filled = envMaterialise(db, made.slug, "/tmp/agents-env-" + made.slug);
    if (!filled.ok) {
      return jouleFailed("the conversation's files could not be written into the"
        + " environment, so there would be nothing there to work on: " + filled.fault,
        true, false);
    }
  }
  let up = envEnsure(db, {
    threadId: ask.threadId, name: JOULE_ENV_NAME, image: image,
    network: true, serve: false, command: "", start: true,
    agent: true, now: ask.now,
  });
  if (!up.ok) {
    return jouleFailed(up.fault, made.created, false);
  }
  let row = envNamed(db, ask.threadId, JOULE_ENV_NAME);
  if (row.id == "") {
    return jouleFailed("the environment started but the conversation has no row for it", made.created, false);
  }
  let started = false;
  if (row.agentConn == "") {
    let connId = jouleConnFor(up.slug);
    if (connId == "") {
      return jouleFailed("this environment's name cannot address a daemon", made.created, false);
    }
    let secret = jouleSecret(db, ask.threadId, ask.agentId, up.slug, ask.now);
    if (secret.fault != "") {
      jouleDropSecret(secret.dir);
      return jouleFailed(secret.fault, made.created, false);
    }
    let launch: JouleLaunch = { connId: connId, envFile: secret.file };
    let begun = jouleStart(db, row, launch);
    // Whatever happened, the key does not stay on the host: docker has read
    // the file by now, and it is of no further use to anything.
    jouleDropSecret(secret.dir);
    if (!begun.ok) {
      return jouleFailed(begun.fault, made.created, false);
    }
    started = true;
    // Read again rather than patched here: jouleStart wrote the connection id
    // and the cursor through envMarkAgent, and jouleTask reads both off the
    // row it is given.
    row = envNamed(db, ask.threadId, JOULE_ENV_NAME);
  }
  let prompt = joulePrompt(ask.task);
  let handed = jouleTask(db, row, prompt);
  if (!handed.ok) {
    return jouleFailed(handed.fault, made.created, started);
  }
  return jouleFollow(db, row, prompt, handed.from, made.created, started);
}

/** Read forward from the cursor the task was sent behind, until the turn ends
 *  or the budget runs out.
 *
 *  From that cursor and not from the row's: it was taken before the input
 *  frame was written, so the only turn.start it can find carrying this prompt
 *  is this task's. An older identical prompt is behind it and cannot be
 *  mistaken for this one.
 *
 *  The row's own cursor is left where jouleTask put it, deliberately. This
 *  reads the turn to answer the call that asked for it; whatever follows the
 *  frames to put progress in the thread has not run yet, and advancing the
 *  stored cursor here would take those frames away from it. */
function jouleFollow(db: Db, row: EnvRow, prompt: string, from: int, created: bool, started: bool): JouleDelegated {
  let frames: JouleFrame[] = [];
  let cursor = from;
  let turnId = "";
  let reason = "";
  let fault = "";
  let deadline = Date.now() + jouleWaitSeconds() * 1000;
  while (true) {
    let tailed = jouleTail(row, cursor);
    if (!tailed.ok) {
      fault = tailed.fault;
      break;
    }
    cursor = tailed.read;
    let k: int = 0;
    while (k < tailed.frames.length) {
      frames.push(tailed.frames[k]);
      k = k + 1;
    }
    if (turnId == "") {
      turnId = jouleTurnFor(frames, prompt);
    }
    if (turnId != "") {
      reason = jouleTurnEndReason(frames, turnId);
      if (reason != "") {
        break;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    process.sleep(JOULE_POLL_MS);
  }
  let read = jouleReadTurn(frames, turnId);
  let harvested = reason == "" ? -1 : envHarvestNow(db, envNamed(db, row.threadId, row.name), `${Date.now()}`);
  let done: JouleDelegated = {
    // A turn that has not finished is not a failure: it is work in progress in
    // a container that is still running, and its files still come back.
    ok: fault == "" && (reason != "error" || read.tools.length > 0),
    turnId: turnId, reason: reason, read: read,
    created: created, started: started, harvested: harvested, fault: fault,
  };
  return done;
}

// ---------------------------------------------------------------------------
// What the model reads
// ---------------------------------------------------------------------------

/** The answer, built apart from the doing so it can be read and tested.
 *
 *  It says what happened and where the result will appear, and it does not
 *  claim the files have arrived: they come back on the workspace sweep, which
 *  is seconds away and not this call. Telling a model that an artifact is
 *  already a new version, when reading it would show the old one, is worse
 *  than telling it to look in a moment. */
export function jouleAnswer(d: JouleDelegated): string {
  if (d.fault != "") {
    return "The task was not delegated: " + d.fault;
  }
  let out = "";
  if (d.created) {
    out = out + "The \"" + JOULE_ENV_NAME + "\" environment was created for this conversation"
      + " and filled with its files.\n";
  }
  if (d.started) {
    out = out + "A joule daemon was started in it.\n";
  }
  if (d.turnId == "") {
    return out + "The task was handed to the daemon, which has not reported a turn for it"
      + " yet. It queues behind anything already running and starts on its own; nothing"
      + " was lost. Say so rather than handing it over again — a second call is a second"
      + " turn, not a retry.";
  }
  if (d.reason == "") {
    out = out + "Turn " + d.turnId + " is still running after " + `${jouleWaitSeconds()}`
      + " seconds. It carries on inside the environment: this call stopped waiting, the"
      + " work did not stop, and its files arrive on their own when it ends. End your turn"
      + " here and say that it is still working — do not wait for it. Sleeping in a script,"
      + " listing the files again, or calling this tool a second time all cost the person a"
      + " turn and none of them make the work arrive sooner.";
  } else if (d.reason == "done") {
    out = out + "Turn " + d.turnId + " finished.";
  } else if (d.reason == "cancelled") {
    out = out + "Turn " + d.turnId + " was cancelled before it finished.";
  } else {
    out = out + "Turn " + d.turnId + (d.read.tools.length > 0
      ? " stopped before it said it was finished. It had already been working, and whatever it wrote comes back on the same harvest as a finished turn would — read the files below before deciding anything is missing, and do not do the work again by another route on the strength of this line alone."
      : " ended in an error without running anything.");
  }
  if (d.read.tools.length > 0) {
    out = out + "\nIt ran: " + jouleToolList(d.read.tools) + ".";
  }
  if (d.read.said != "") {
    out = out + "\nIt said:\n" + d.read.said + (d.read.cut ? "\n(cut here)" : "");
  }
  let e: int = 0;
  while (e < d.read.errors.length) {
    out = out + "\nThe daemon reported an error: " + d.read.errors[e];
    e = e + 1;
  }
  if (d.read.approvals > 0) {
    // Loud on purpose. In full-auto there are none, so one means the mode did
    // not take, and the visible symptom is a turn that takes two minutes per
    // gated call and then denies it — which reads as the delegate being slow
    // and refusing to work.
    out = out + "\nIt asked for " + `${d.read.approvals}` + " approval(s), which it should"
      + " not have to: the daemon is meant to run unattended, and nothing here can answer."
      + " Report this rather than waiting on it.";
  }
  if (d.harvested > 0) {
    out = out + "\nIt left " + `${d.harvested}` + " file(s) in this conversation, noted \""
      + ENV_AGENT_NOTE + "\" — they are here now, and the person opens them themselves. It"
      + " looked at what it produced before it answered, so opening, measuring or re-rendering"
      + " one here checks work that is already checked and costs the person the wait. Say what"
      + " was made, name the file, and end the turn; do not make it again by another route.";
  } else {
    out = out + "\nWhatever it changed in the workspace comes back as new versions of this"
      + " conversation's files, noted \"" + ENV_AGENT_NOTE + "\", within a few seconds of the"
      + " turn ending — read the file to see what it did rather than describing it from this"
      + " message.";
  }
  return out;
}

function jouleToolList(tools: string[]): string {
  let out = "";
  let i: int = 0;
  while (i < tools.length) {
    if (i > 0) {
      out = out + ", ";
    }
    out = out + (tools[i] == "" ? "?" : tools[i]);
    i = i + 1;
  }
  return out;
}

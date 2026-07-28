// Human in the loop: pause an agent before a sensitive tool, resume with a
// verdict — across subagents, so a child's sensitive call pauses the whole
// tree.
//
// The pause is the program ending with state on disk; the resume is a new
// invocation. There is no waiting process and no scheduler: a checkpoint is a
// JSON file holding the conversation, the steps so far, and the call awaiting
// a decision. LangGraph needs interrupt() plus a server holding the thread to
// do this; a synchronous binary needs a file.
//
// The model and the tools are not in the checkpoint — closures do not
// serialize. A resume takes the same registry the run started with and the
// saved state, which is also how the reference implementations work: the
// checkpointer restores state, the code rebuilds the machinery.

import { runToolWithPolicy, toolResultMessage } from "./tools.ts";
import { parseToolCalls, toolCallInput, makeToolCall, toolCallArgument } from "./toolcall.ts";
import { assistantMessage, Message } from "../core/messages.ts";
import { agCallSummary } from "./agent.ts";
import { serializeHistory, parseHistory } from "../memory/memory.ts";

// A token minted once per process. Tool output is the least trusted string in
// the system — an MCP tool relaying a remote server, a fetch_url, a read_file —
// and a fixed marker is something any document can begin with. A forged one
// made the parent checkpoint for a tool that had ALREADY run, and approving it
// ran the tool again, which paused again: a loop repeating the side effect
// every cycle. A child pausing is in-process with its parent and reads this
// constant, so it can name the channel; a remote document cannot guess it.
const APPROVAL_TOKEN = crypto.randomUUID();

// A tool output beginning with this is a pause request bubbling up from a
// child agent: the parent stops instead of treating it as a result. The value
// is not stable across runs, and nothing should persist or hard-code it.
export const APPROVAL_SENTINEL = "[[approval-required:" + APPROVAL_TOKEN + "]]";

// The version this build writes and the only one it reads. It is bumped when
// CheckpointFile gains or loses a field, because JSON.parse<T> rejects a
// document with missing fields: without the bump an older checkpoint would
// come back as an unexplained parse failure rather than as the version
// mismatch it is. Version 2 added `queueTools`/`queueInputs`.
export const APPROVAL_CHECKPOINT_VERSION = 2;

// Why a run stopped, beyond the loop's own reasons: "approval" means a
// sensitive call is waiting for a human, and "error" means the resume was
// handed something it could not read — `answer` holds the sentence saying so.
export type ApprovalRun = {
  answer: string,
  stopReason: string,
  stepCount: int,
  // The call awaiting a verdict, when stopReason is "approval".
  pendingTool: string,
  pendingInput: string,
  // "direct" when this run's own loop paused; "child" when the pause bubbled
  // up from a subagent through the sentinel.
  pendingKind: string,
  // The serialized checkpoint to save; "" when the run did not pause.
  checkpoint: string,
};

// The saved state of a paused run. `steps` is flattened to parallel arrays
// because JSON.parse<T> needs a closed shape and the step record already
// exists elsewhere; a checkpoint is a wire format, not an API.
type CheckpointFile = {
  version: int,
  history: string,
  stepTools: string[],
  stepInputs: string[],
  stepOutputs: string[],
  stepOks: bool[],
  turns: int,
  pendingTool: string,
  pendingInput: string,
  pendingKind: string,
  maxSteps: int,
  // The rest of the paused turn: the calls the assistant declared after the
  // one awaiting a verdict, in order, still to dispatch.
  queueTools: string[],
  queueInputs: string[],
};

// The tool calls dispatched so far, which a resume carries forward. One record
// rather than four parallel parameters threaded through every signature.
type RunSteps = {
  tools: string[],
  inputs: string[],
  outputs: string[],
  oks: bool[],
};

// Calls an assistant turn declared that have not been dispatched yet. A pause
// happens in the MIDDLE of a turn: the loop stopped at call k, and calls
// k+1..n are part of what the assistant already told the model it would do.
// Dropping them left the conversation claiming results that never arrived, and
// nothing said so.
export type PendingCalls = {
  names: string[],
  inputs: string[],
};

function noSteps(): RunSteps {
  let tools: string[] = [];
  let inputs: string[] = [];
  let outputs: string[] = [];
  let oks: bool[] = [];
  let s: RunSteps = { tools: tools, inputs: inputs, outputs: outputs, oks: oks };
  return s;
}

function noPendingCalls(): PendingCalls {
  let names: string[] = [];
  let inputs: string[] = [];
  let q: PendingCalls = { names: names, inputs: inputs };
  return q;
}

function approvalResult(answer: string, stopReason: string, stepCount: int): ApprovalRun {
  let r: ApprovalRun = {
    answer: answer, stopReason: stopReason, stepCount: stepCount,
    pendingTool: "", pendingInput: "", pendingKind: "", checkpoint: "",
  };
  return r;
}

function pausedResult(checkpoint: CheckpointFile): ApprovalRun {
  let r: ApprovalRun = {
    answer: "",
    stopReason: "approval",
    stepCount: checkpoint.stepTools.length,
    pendingTool: checkpoint.pendingTool,
    pendingInput: checkpoint.pendingInput,
    pendingKind: checkpoint.pendingKind,
    checkpoint: JSON.stringify(checkpoint),
  };
  return r;
}

function isSensitive(name: string, sensitive: string[]): bool {
  let i: int = 0;
  while (i < sensitive.length) {
    if (sensitive[i] == name) { return true; }
    i = i + 1;
  }
  return false;
}

// One checkpoint, built the same way from every place that pauses.
function apCheckpoint(messages: Message[], steps: RunSteps, turn: int, name: string, input: string, kind: string, maxSteps: int, rest: PendingCalls): CheckpointFile {
  let cp: CheckpointFile = {
    version: APPROVAL_CHECKPOINT_VERSION,
    history: serializeHistory(messages),
    stepTools: steps.tools, stepInputs: steps.inputs,
    stepOutputs: steps.outputs, stepOks: steps.oks,
    turns: turn,
    pendingTool: name, pendingInput: input, pendingKind: kind,
    maxSteps: maxSteps,
    queueTools: rest.names, queueInputs: rest.inputs,
  };
  return cp;
}

// A child pausing shows up as its tool result carrying the sentinel. The
// sentinel is a per-process token, so this is a channel a child in this process
// can name and a fetched document cannot.
function apChildPaused(result: ToolResult): bool {
  return result.ok && result.output.startsWith(APPROVAL_SENTINEL);
}

// The loop, resumable. `convo`, `steps` and `queue` carry whatever a checkpoint
// restored; a fresh run passes them empty.
//
// One iteration either takes a turn from the model or dispatches one call the
// model already asked for. Both are bounded by `maxSteps` — turns by `turn`,
// dispatches by the step count — so the loop terminates.
function approvalLoop(model: Model, tools: Tool[], sensitive: string[], convo: Message[], steps: RunSteps, turns: int, maxSteps: int, queue: PendingCalls): ApprovalRun {
  let messages = convo.slice(0, convo.length);
  let answer = "";
  let turn = turns;
  let names = queue.names;
  let inputs = queue.inputs;
  let stepTools = steps.tools;
  let stepInputs = steps.inputs;
  let stepOutputs = steps.outputs;
  let stepOks = steps.oks;
  while (true) {
    if (names.length == 0) {
      if (turn >= maxSteps) { return approvalResult(answer, "max_steps", stepTools.length); }
      let raw = model(messages);
      turn = turn + 1;
      let calls = parseToolCalls(raw);
      let text = agApprovalText(raw);
      if (calls.length == 0) {
        return approvalResult(text, "final", stepTools.length);
      }
      if (text != "") { answer = text; }
      // The same summary the plain loop writes, so the text this loop puts in
      // history is the text agentHistoryToTurns reads back into native tool
      // calls. Two formats meant a live second turn sent `"tool_calls":[]`
      // beside a tool message answering nothing, and a provider rejected both.
      messages = [...messages, assistantMessage(agCallSummary(text, calls))];
      let freshNames: string[] = [];
      let freshInputs: string[] = [];
      let k: int = 0;
      while (k < calls.length) {
        freshNames = [...freshNames, calls[k].name];
        freshInputs = [...freshInputs, toolCallInput(calls[k])];
        k = k + 1;
      }
      names = freshNames;
      inputs = freshInputs;
    }
    if (stepTools.length >= maxSteps) { return approvalResult(answer, "max_steps", stepTools.length); }
    let name = names[0];
    let input = inputs[0];
    let rest: PendingCalls = { names: names.slice(1, names.length), inputs: inputs.slice(1, inputs.length) };
    let held: RunSteps = { tools: stepTools, inputs: stepInputs, outputs: stepOutputs, oks: stepOks };
    // The gate: a sensitive call checkpoints BEFORE executing, so nothing has
    // happened yet when the human looks at it. The rest of the turn rides along
    // in the checkpoint and runs on resume.
    if (isSensitive(name, sensitive)) {
      return pausedResult(apCheckpoint(messages, held, turn, name, input, "direct", maxSteps, rest));
    }
    let none: string[] = [];
    let result = runToolWithPolicy(tools, { allow: none, deny: none }, name, input);
    if (apChildPaused(result)) {
      return pausedResult(apCheckpoint(messages, held, turn, name, input, "child", maxSteps, rest));
    }
    let out = result.output;
    if (!result.ok) { out = "error: " + result.error; }
    stepTools = [...stepTools, result.name];
    stepInputs = [...stepInputs, result.input];
    stepOutputs = [...stepOutputs, out];
    stepOks = [...stepOks, result.ok];
    messages = [...messages, toolResultMessage(result)];
    names = rest.names;
    inputs = rest.inputs;
  }
  return approvalResult(answer, "max_steps", stepTools.length);
}

// Run with a pause gate. `sensitive` names the tools that need a human; the
// run stops before the first such call with a checkpoint in the result.
export function runAgentWithApproval(model: Model, tools: Tool[], sensitive: string[], history: Message[], maxSteps: int): ApprovalRun {
  return approvalLoop(model, tools, sensitive, history, noSteps(), 0, maxSteps, noPendingCalls());
}

// Resume a paused run with a verdict.
//
// Approved: the pending call runs now, and the loop continues with its result.
// Denied: the model gets a tool message saying a human refused, and plans
// around it — the tool itself never executes.
export function resumeAgent(model: Model, tools: Tool[], sensitive: string[], checkpointJson: string, approved: bool): ApprovalRun {
  // loadCheckpoint returns "" for a missing file, and JSON.parse<T> rejects a
  // document missing a field the record gained — so the obvious composition
  // took the process down. Both now come back as a sentence a caller can show.
  let problem = checkpointProblem(checkpointJson);
  if (problem != "") { return approvalResult(problem, "error", 0); }

  let cp: CheckpointFile = JSON.parse<CheckpointFile>(checkpointJson);
  let messages = parseHistory(cp.history);
  let steps: RunSteps = {
    tools: cp.stepTools, inputs: cp.stepInputs, outputs: cp.stepOutputs, oks: cp.stepOks,
  };
  // The rest of the paused turn, whichever way the verdict goes: the other
  // calls were not the ones a human was asked about.
  let queue: PendingCalls = { names: cp.queueTools, inputs: cp.queueInputs };

  if (!approved) {
    let refusal: Message = {
      role: "tool",
      content: "[tool " + cp.pendingTool + "] a human reviewed this call and denied it — do not retry it; explain or find another way",
    };
    messages = [...messages, refusal];
    let denied: RunSteps = {
      tools: [...steps.tools, cp.pendingTool],
      inputs: [...steps.inputs, cp.pendingInput],
      outputs: [...steps.outputs, "denied by human"],
      oks: [...steps.oks, false],
    };
    return approvalLoop(model, tools, sensitive, messages, denied, cp.turns, cp.maxSteps, queue);
  }

  // Approved: dispatch the held call. For a child pause the dispatch re-enters
  // the subagent tool, whose runner finds its own checkpoint and the verdict
  // on disk and resumes the child rather than starting over.
  let none: string[] = [];
  let result = runToolWithPolicy(tools, { allow: none, deny: none }, cp.pendingTool, cp.pendingInput);
  if (apChildPaused(result)) {
    // The child paused again — a second sensitive call deeper in its run. The
    // rest of the parent's turn is still waiting behind it.
    return pausedResult(apCheckpoint(messages, steps, cp.turns, cp.pendingTool, cp.pendingInput, "child", cp.maxSteps, queue));
  }
  let out = result.output;
  if (!result.ok) { out = "error: " + result.error; }
  let done: RunSteps = {
    tools: [...steps.tools, result.name],
    inputs: [...steps.inputs, result.input],
    outputs: [...steps.outputs, out],
    oks: [...steps.oks, result.ok],
  };
  messages = [...messages, toolResultMessage(result)];
  return approvalLoop(model, tools, sensitive, messages, done, cp.turns, cp.maxSteps, queue);
}

// --- checkpoint files -----------------------------------------------------------

export function saveCheckpoint(path: string, run: ApprovalRun): bool {
  if (run.checkpoint == "") { return false; }
  fs.writeFileSync(path, run.checkpoint);
  return true;
}

export function loadCheckpoint(path: string): string {
  if (!fs.existsSync(path)) { return ""; }
  return fs.readFileSync(path);
}

// --- reading a checkpoint before trusting it -------------------------------------

// A structural field read that never throws, so the version can be inspected
// before the typed parse that a version mismatch would fail. Same idiom as
// agent.ts's agJsonField.
function apCheckpointField(json: string, key: string): string {
  return toolCallArgument(makeToolCall("", "", json), key);
}

// Why this text would not resume. "" means it will.
export function checkpointProblem(checkpointJson: string): string {
  if (checkpointJson == "") {
    return "there is no checkpoint to resume from: nothing was saved at that path, or the run never paused";
  }
  let version = apCheckpointField(checkpointJson, "version");
  if (version == "") {
    return "this is not an approval checkpoint: it carries no version";
  }
  if (version != `${APPROVAL_CHECKPOINT_VERSION}`) {
    return "this checkpoint is version " + version + ", and this build reads version "
      + `${APPROVAL_CHECKPOINT_VERSION}`;
  }
  try {
    let cp: CheckpointFile = JSON.parse<CheckpointFile>(checkpointJson);
    if (cp.pendingTool == "") {
      return "this checkpoint names no tool awaiting a decision";
    }
  } catch (err) {
    return "this checkpoint says version " + version
      + " but does not carry the fields that version holds";
  }
  return "";
}

// The conversation a checkpoint paused in the middle of, for a caller showing a
// human what the agent was doing. A checkpoint that will not resume has no
// conversation to show, so it reads as empty rather than throwing.
export function checkpointHistory(checkpointJson: string): Message[] {
  let empty: Message[] = [];
  if (checkpointProblem(checkpointJson) != "") { return empty; }
  let cp: CheckpointFile = JSON.parse<CheckpointFile>(checkpointJson);
  return parseHistory(cp.history);
}

// --- text helpers ------------------------------------------------------------------

function agApprovalText(raw: string): string {
  let marker = "\"content\":\"";
  let start = raw.indexOf(marker);
  if (start < 0) { return ""; }
  let i = start + marker.length;
  let out = "";
  let escaped: bool = false;
  while (i < raw.length) {
    let c = raw.charAt(i);
    if (escaped) {
      if (c == "n") { out = out + "\n"; } else { out = out + c; }
      escaped = false;
    } else if (c == "\\") {
      escaped = true;
    } else if (c == "\"") {
      return out;
    } else {
      out = out + c;
    }
    i = i + 1;
  }
  return out;
}

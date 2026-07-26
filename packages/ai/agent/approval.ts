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
import { parseToolCalls, toolCallInput } from "./toolcall.ts";
import { assistantMessage, Message } from "../core/messages.ts";
import { makeAgentStep } from "./agent.ts";
import { serializeHistory, parseHistory } from "../memory/memory.ts";

// A tool output beginning with this is a pause request bubbling up from a
// child agent: the parent stops instead of treating it as a result.
export const APPROVAL_SENTINEL = "[[approval-required]]";

// Why a run stopped, beyond the loop's own reasons: "approval" means a
// sensitive call is waiting for a human.
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
};

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

// The loop, resumable. `convo` and the step arrays carry whatever a checkpoint
// restored; a fresh run passes them empty.
function approvalLoop(model: Model, tools: Tool[], sensitive: string[], convo: Message[], stepTools: string[], stepInputs: string[], stepOutputs: string[], stepOks: bool[], turns: int, maxSteps: int): ApprovalRun {
  let messages = convo.slice(0, convo.length);
  let answer = "";
  let turn = turns;
  while (turn < maxSteps) {
    let raw = model(messages);
    turn = turn + 1;
    let calls = parseToolCalls(raw);
    if (calls.length == 0) {
      let text = agApprovalText(raw);
      return approvalResult(text, "final", stepTools.length);
    }
    let text = agApprovalText(raw);
    if (text != "") { answer = text; }
    messages = [...messages, assistantMessage(agApprovalSummary(text, calls))];
    let i: int = 0;
    while (i < calls.length) {
      if (stepTools.length >= maxSteps) { return approvalResult(answer, "max_steps", stepTools.length); }
      let name = calls[i].name;
      let input = toolCallInput(calls[i]);
      // The gate: a sensitive call checkpoints BEFORE executing, so nothing
      // has happened yet when the human looks at it.
      if (isSensitive(name, sensitive)) {
        let cp: CheckpointFile = {
          version: 1,
          history: serializeHistory(messages),
          stepTools: stepTools, stepInputs: stepInputs, stepOutputs: stepOutputs, stepOks: stepOks,
          turns: turn,
          pendingTool: name, pendingInput: input, pendingKind: "direct",
          maxSteps: maxSteps,
        };
        return pausedResult(cp);
      }
      let none: string[] = [];
      let result = runToolWithPolicy(tools, { allow: none, deny: none }, name, input);
      // A child pausing shows up as its tool result carrying the sentinel:
      // checkpoint the parent with the same call pending, so a resume can
      // re-dispatch into the child.
      if (result.ok && result.output.startsWith(APPROVAL_SENTINEL)) {
        let cp: CheckpointFile = {
          version: 1,
          history: serializeHistory(messages),
          stepTools: stepTools, stepInputs: stepInputs, stepOutputs: stepOutputs, stepOks: stepOks,
          turns: turn,
          pendingTool: name, pendingInput: input, pendingKind: "child",
          maxSteps: maxSteps,
        };
        return pausedResult(cp);
      }
      let out = result.output;
      if (!result.ok) { out = "error: " + result.error; }
      stepTools = [...stepTools, result.name];
      stepInputs = [...stepInputs, result.input];
      stepOutputs = [...stepOutputs, out];
      stepOks = [...stepOks, result.ok];
      messages = [...messages, toolResultMessage(result)];
      i = i + 1;
    }
  }
  return approvalResult(answer, "max_steps", stepTools.length);
}

// Run with a pause gate. `sensitive` names the tools that need a human; the
// run stops before the first such call with a checkpoint in the result.
export function runAgentWithApproval(model: Model, tools: Tool[], sensitive: string[], history: Message[], maxSteps: int): ApprovalRun {
  let noTools: string[] = [];
  let noInputs: string[] = [];
  let noOutputs: string[] = [];
  let noOks: bool[] = [];
  return approvalLoop(model, tools, sensitive, history, noTools, noInputs, noOutputs, noOks, 0, maxSteps);
}

// Resume a paused run with a verdict.
//
// Approved: the pending call runs now, and the loop continues with its result.
// Denied: the model gets a tool message saying a human refused, and plans
// around it — the tool itself never executes.
export function resumeAgent(model: Model, tools: Tool[], sensitive: string[], checkpointJson: string, approved: bool): ApprovalRun {
  let cp: CheckpointFile = JSON.parse<CheckpointFile>(checkpointJson);
  let messages = parseHistory(cp.history);
  let stepTools = cp.stepTools;
  let stepInputs = cp.stepInputs;
  let stepOutputs = cp.stepOutputs;
  let stepOks = cp.stepOks;

  if (!approved) {
    let refusal: Message = {
      role: "tool",
      content: "[tool " + cp.pendingTool + "] a human reviewed this call and denied it — do not retry it; explain or find another way",
    };
    messages = [...messages, refusal];
    stepTools = [...stepTools, cp.pendingTool];
    stepInputs = [...stepInputs, cp.pendingInput];
    stepOutputs = [...stepOutputs, "denied by human"];
    stepOks = [...stepOks, false];
    return approvalLoop(model, tools, sensitive, messages, stepTools, stepInputs, stepOutputs, stepOks, cp.turns, cp.maxSteps);
  }

  // Approved: dispatch the held call. For a child pause the dispatch re-enters
  // the subagent tool, whose runner finds its own checkpoint and the verdict
  // on disk and resumes the child rather than starting over.
  let none: string[] = [];
  let result = runToolWithPolicy(tools, { allow: none, deny: none }, cp.pendingTool, cp.pendingInput);
  if (result.ok && result.output.startsWith(APPROVAL_SENTINEL)) {
    // The child paused again — a second sensitive call deeper in its run.
    let again: CheckpointFile = {
      version: 1,
      history: cp.history,
      stepTools: stepTools, stepInputs: stepInputs, stepOutputs: stepOutputs, stepOks: stepOks,
      turns: cp.turns,
      pendingTool: cp.pendingTool, pendingInput: cp.pendingInput, pendingKind: "child",
      maxSteps: cp.maxSteps,
    };
    return pausedResult(again);
  }
  let out = result.output;
  if (!result.ok) { out = "error: " + result.error; }
  stepTools = [...stepTools, result.name];
  stepInputs = [...stepInputs, result.input];
  stepOutputs = [...stepOutputs, out];
  stepOks = [...stepOks, result.ok];
  messages = [...messages, toolResultMessage(result)];
  return approvalLoop(model, tools, sensitive, messages, stepTools, stepInputs, stepOutputs, stepOks, cp.turns, cp.maxSteps);
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

function agApprovalSummary(text: string, calls: ToolCall[]): string {
  let names = "";
  let i: int = 0;
  while (i < calls.length) {
    if (i > 0) { names = names + ", "; }
    names = names + calls[i].name;
    i = i + 1;
  }
  let head = text;
  if (head != "") { head = head + "\n"; }
  return head + "[tool_calls] " + names;
}

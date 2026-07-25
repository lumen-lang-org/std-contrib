// Human in the loop, offline: pauses before sensitive tools, resumes with a
// verdict, and propagates a child's pause up through a subagent tool.

import { runAgentWithApproval, resumeAgent, saveCheckpoint, loadCheckpoint, APPROVAL_SENTINEL } from "./approval.ts";
import { subAgentGatedAnswer, decideChildPause, childPausePending } from "./subagent.ts";
import { fileCheckpointStore } from "./checkpointstore.ts";
import { fakeModel, agentFakeAnswer, agentFakeToolCall } from "./agent.ts";
import { makeTool } from "./tools.ts";
import { systemMessage, userMessage } from "../core/messages.ts";

const APPROVAL_DIR = "/tmp/lumen-ai-approval-test";

// A tool with an observable side effect, so a test can prove the gate stopped
// execution rather than merely relabelling it.
function sideEffectPath(): string {
  return APPROVAL_DIR + "/fired.txt";
}

function apTools(): AiTool[] {
  let send = makeTool("send_email", "Send an email.", "the message", (input: string) => {
    fs.writeFileSync(APPROVAL_DIR + "/fired.txt", "sent: " + input);
    return "email sent: " + input;
  });
  let look = makeTool("lookup", "Look something up.", "the query", (input: string) => {
    return "found: " + input;
  });
  let tools: AiTool[] = [send, look];
  return tools;
}

function apSensitive(): string[] {
  let s: string[] = ["send_email"];
  return s;
}

function apHistory(): AiMessage[] {
  let h: AiMessage[] = [
    systemMessage("You are an assistant."),
    userMessage("email bob the report"),
  ];
  return h;
}

function apReset(): void {
  if (fs.existsSync(APPROVAL_DIR)) { fs.rmSync(APPROVAL_DIR, true); }
  fs.mkdirSync(APPROVAL_DIR);
}

// --- pausing ------------------------------------------------------------------

test("a sensitive call pauses before executing", () => {
  apReset();
  let script: string[] = [agentFakeToolCall("send_email", "the report")];
  let run = runAgentWithApproval(fakeModel(script), apTools(), apSensitive(), apHistory(), 5);
  expect(run.stopReason == "approval");
  expect(run.pendingTool == "send_email");
  expect(run.pendingInput == "the report");
  expect(run.pendingKind == "direct");
  expect(run.checkpoint.length > 0);
  // The gate held: the tool never fired.
  expect(!fs.existsSync(sideEffectPath()));
});

test("a run with no sensitive calls never pauses", () => {
  apReset();
  let script: string[] = [
    agentFakeToolCall("lookup", "bob's address"),
    agentFakeAnswer("bob is at 12 Elm St"),
  ];
  let run = runAgentWithApproval(fakeModel(script), apTools(), apSensitive(), apHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.answer == "bob is at 12 Elm St");
  expect(run.checkpoint == "");
});

test("an insensitive tool still runs on the way to the gate", () => {
  apReset();
  let script: string[] = [
    agentFakeToolCall("lookup", "the report"),
    agentFakeToolCall("send_email", "the report to bob"),
  ];
  let run = runAgentWithApproval(fakeModel(script), apTools(), apSensitive(), apHistory(), 5);
  expect(run.stopReason == "approval");
  expect(run.stepCount == 1);
});

// --- resuming -------------------------------------------------------------------

test("approving executes the held call and the run completes", () => {
  apReset();
  let script: string[] = [
    agentFakeToolCall("send_email", "the report"),
    agentFakeAnswer("sent it"),
  ];
  let paused = runAgentWithApproval(fakeModel(script), apTools(), apSensitive(), apHistory(), 5);
  expect(paused.stopReason == "approval");
  let resumed = resumeAgent(fakeModel(script), apTools(), apSensitive(), paused.checkpoint, true);
  expect(resumed.stopReason == "final");
  expect(resumed.answer == "sent it");
  // Approval released the side effect.
  expect(fs.existsSync(sideEffectPath()));
  expect(fs.readFileSync(sideEffectPath()) == "sent: the report");
});

test("denying skips the tool and the model plans around it", () => {
  apReset();
  let script: string[] = [
    agentFakeToolCall("send_email", "the report"),
    agentFakeAnswer("understood, I will not send it"),
  ];
  let paused = runAgentWithApproval(fakeModel(script), apTools(), apSensitive(), apHistory(), 5);
  let resumed = resumeAgent(fakeModel(script), apTools(), apSensitive(), paused.checkpoint, false);
  expect(resumed.stopReason == "final");
  expect(resumed.answer == "understood, I will not send it");
  // Denial means the tool never ran.
  expect(!fs.existsSync(sideEffectPath()));
});

test("a checkpoint survives the round trip through a file", () => {
  apReset();
  let script: string[] = [
    agentFakeToolCall("send_email", "the report"),
    agentFakeAnswer("done"),
  ];
  let paused = runAgentWithApproval(fakeModel(script), apTools(), apSensitive(), apHistory(), 5);
  expect(saveCheckpoint(APPROVAL_DIR + "/run.json", paused));
  let loaded = loadCheckpoint(APPROVAL_DIR + "/run.json");
  expect(loaded == paused.checkpoint);
  let resumed = resumeAgent(fakeModel(script), apTools(), apSensitive(), loaded, true);
  expect(resumed.stopReason == "final");
});

test("a completed run has no checkpoint to save", () => {
  apReset();
  let script: string[] = [agentFakeAnswer("nothing to do")];
  let run = runAgentWithApproval(fakeModel(script), apTools(), apSensitive(), apHistory(), 5);
  expect(!saveCheckpoint(APPROVAL_DIR + "/none.json", run));
  expect(loadCheckpoint(APPROVAL_DIR + "/none.json") == "");
});

// --- through a subagent ------------------------------------------------------------

// The gated child, seamed on a fake model: pauses on its sensitive tool, then
// finishes after a verdict.
function apChildRun(task: string): string {
  let script: string[] = [
    agentFakeToolCall("send_email", "draft for " + task),
    agentFakeAnswer("child finished: email away"),
  ];
  return subAgentGatedAnswer(fakeModel(script), "You are a mailer.", apTools(), apSensitive(), fileCheckpointStore(APPROVAL_DIR), "mailer", task, 5);
}

function apChildTool(): AiTool {
  return makeTool("mailer", "Sends mail.", "the task", (task: string) => {
    return apChildRun(task);
  });
}

test("a child's sensitive call pauses the parent too", () => {
  apReset();
  let parentScript: string[] = [
    agentFakeToolCall("mailer", "send bob the report"),
    agentFakeAnswer("all done"),
  ];
  let tools: AiTool[] = [apChildTool()];
  let none: string[] = [];
  let run = runAgentWithApproval(fakeModel(parentScript), tools, none, apHistory(), 6);
  expect(run.stopReason == "approval");
  expect(run.pendingKind == "child");
  expect(run.pendingTool == "mailer");
  // The child holds a checkpoint and awaits a verdict; nothing fired.
  expect(childPausePending(fileCheckpointStore(APPROVAL_DIR), "mailer"));
  expect(!fs.existsSync(sideEffectPath()));
});

test("approving the child resumes it through the parent to completion", () => {
  apReset();
  let parentScript: string[] = [
    agentFakeToolCall("mailer", "send bob the report"),
    agentFakeAnswer("all done"),
  ];
  let tools: AiTool[] = [apChildTool()];
  let none: string[] = [];
  let paused = runAgentWithApproval(fakeModel(parentScript), tools, none, apHistory(), 6);
  expect(paused.stopReason == "approval");

  decideChildPause(fileCheckpointStore(APPROVAL_DIR), "mailer", true);
  let resumed = resumeAgent(fakeModel(parentScript), tools, none, paused.checkpoint, true);
  expect(resumed.stopReason == "final");
  expect(resumed.answer == "all done");
  // The child's held tool fired after approval, and its pause state is gone.
  expect(fs.existsSync(sideEffectPath()));
  expect(!childPausePending(fileCheckpointStore(APPROVAL_DIR), "mailer"));
});

test("denying the child lets it finish without the side effect", () => {
  apReset();
  let parentScript: string[] = [
    agentFakeToolCall("mailer", "send bob the report"),
    agentFakeAnswer("noted"),
  ];
  let tools: AiTool[] = [apChildTool()];
  let none: string[] = [];
  let paused = runAgentWithApproval(fakeModel(parentScript), tools, none, apHistory(), 6);

  decideChildPause(fileCheckpointStore(APPROVAL_DIR), "mailer", false);
  let resumed = resumeAgent(fakeModel(parentScript), tools, none, paused.checkpoint, true);
  expect(resumed.stopReason == "final");
  expect(!fs.existsSync(sideEffectPath()));
});

test("resuming the parent without a verdict pauses again rather than guessing", () => {
  apReset();
  let parentScript: string[] = [
    agentFakeToolCall("mailer", "send bob the report"),
    agentFakeAnswer("all done"),
  ];
  let tools: AiTool[] = [apChildTool()];
  let none: string[] = [];
  let paused = runAgentWithApproval(fakeModel(parentScript), tools, none, apHistory(), 6);
  // No decideChildPause call: the human has not decided yet.
  let resumed = resumeAgent(fakeModel(parentScript), tools, none, paused.checkpoint, true);
  expect(resumed.stopReason == "approval");
  expect(resumed.pendingKind == "child");
  expect(childPausePending(fileCheckpointStore(APPROVAL_DIR), "mailer"));
});

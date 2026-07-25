// Subagents: delegate a task to a child agent and get one answer back.
//
// The child is an ordinary tool call that returns — the pattern LangChain's
// deepagents ships as its `task` tool, and the one their docs now recommend
// over the unmaintained supervisor package. What makes it worth having is
// context quarantine: the child starts from a written task description, not
// the parent's history, and only its final answer comes back. A child that
// makes twenty tool calls costs the parent one message.
//
// Handoffs — transferring control so the child answers the user directly —
// are deliberately absent. They need a graph runtime that can redirect
// execution mid-run, and they solve a different problem (switching personas in
// a conversation) than delegation does.
//
// There is no generic "make me a subagent from any model" factory: a closure
// may not call a function it captured, so a tool's run body cannot invoke an
// arbitrary model value. Instead a subagent names its provider, and the run
// body calls a compiled runner for it. The model choice is a compile-time
// decision per subagent, which is also easier to reason about.

import { runAgent, agentHistoryToTurns } from "./agent.ts";
import { makeTool } from "./tools.ts";
import { systemMessage, userMessage } from "../core/messages.ts";
import { runOpenAIToolChat, runMistralToolChat } from "./toolchat.ts";

// Appended to every subagent's system prompt. Borrowed nearly verbatim from
// deepagents, where it fixes a real failure mode: a child that ends on "done!"
// after doing the work in earlier turns returns "done!" and nothing else.
export const SUBAGENT_CONTRACT = "The calling agent only sees your final message, not your intermediate work or tool results. Ensure your final response contains the complete answer to the task.";

// A subagent definition: what the parent's model reads to choose it, and what
// the child runs with. `provider` is "openai" or "mistral".
export type SubAgent = {
  name: string,
  description: string,
  provider: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  tools: Tool[],
  maxSteps: int,
};

export function makeSubAgent(name: string, description: string, provider: string, apiKey: string, model: string, systemPrompt: string, tools: Tool[], maxSteps: int): SubAgent {
  let s: SubAgent = {
    name: name,
    description: description,
    provider: provider,
    apiKey: apiKey,
    model: model,
    systemPrompt: systemPrompt,
    tools: tools,
    maxSteps: maxSteps,
  };
  return s;
}

// Run a task through a child loop with any model — the seam tests drive with a
// fake, and the live runners below drive with providers.
//
// The child's history is exactly a system prompt and the task: the parent's
// conversation is not passed, which is the isolation this exists for. The
// return value is the child's final answer alone; on a run that ended without
// one, it is an error string, since a tool returns text rather than raising —
// which matches what the reference implementations do by default.
export function subAgentAnswer(model: Model, systemPrompt: string, tools: Tool[], task: string, maxSteps: int): string {
  let history: Message[] = [
    systemMessage(systemPrompt + "\n\n" + SUBAGENT_CONTRACT),
    userMessage(task),
  ];
  let result = runAgent(model, tools, history, maxSteps);
  if (result.stopReason == "final" && result.answer != "") {
    return result.answer;
  }
  if (result.stopReason == "max_steps") {
    return "subagent stopped at its step limit (" + `${maxSteps}` + ") without a final answer";
  }
  if (result.answer != "") {
    return result.answer;
  }
  return "subagent ended without an answer (" + result.stopReason + ")";
}

// The live runner: builds the provider model inside a top-level function, so a
// tool's run closure only ever captures strings and calls this by name.
export function runSubAgent(sub: SubAgent, task: string): string {
  if (sub.provider == "mistral") {
    let mm: Model = (messages: Message[]) => {
      return runMistralToolChat(sub.apiKey, sub.model, agentHistoryToTurns(messages), sub.tools);
    };
    return subAgentAnswer(mm, sub.systemPrompt, sub.tools, task, sub.maxSteps);
  }
  if (sub.provider == "openai") {
    let om: Model = (messages: Message[]) => {
      return runOpenAIToolChat(sub.apiKey, sub.model, agentHistoryToTurns(messages), sub.tools);
    };
    return subAgentAnswer(om, sub.systemPrompt, sub.tools, task, sub.maxSteps);
  }
  return "subagent \"" + sub.name + "\" has unknown provider \"" + sub.provider + "\": use openai or mistral";
}

// Wrap a subagent as a tool for a parent's registry. The input is the task
// description the parent's model writes; the description tells that model when
// to delegate, so it should say what the child is good at.
export function subAgentAsTool(sub: SubAgent): Tool {
  return makeTool(
    sub.name,
    sub.description + " Give it a complete, self-contained task description — it does not see this conversation.",
    "a full description of the task to delegate",
    (task: string) => {
      return runSubAgent(sub, task);
    },
  );
}

// Wrap several at once, for a parent that routes among specialists.
export function subAgentsAsTools(subs: SubAgent[]): Tool[] {
  let out: Tool[] = [];
  let i: int = 0;
  while (i < subs.length) {
    out = [...out, subAgentAsTool(subs[i])];
    i = i + 1;
  }
  return out;
}

// --- approval through a child -------------------------------------------------
// A child's sensitive tool pauses the whole tree. The child checkpoints itself
// into a store, its tool result carries the approval sentinel, and the
// parent's approval loop checkpoints in turn. The verdict travels back down
// through the same store on re-dispatch — the one channel a tool's
// string-to-string contract leaves open.
//
// The store decides where pause state lives — files, a database table, or a
// test's map — because a checkpoint is a string and a verdict is one word.

import { runAgentWithApproval, resumeAgent, APPROVAL_SENTINEL } from "./approval.ts";
import { CheckpointStore } from "./checkpointstore.ts";

function subCheckpointKey(name: string): string {
  return name + ".checkpoint.json";
}

function subDecisionKey(name: string): string {
  return name + ".decision";
}

// Record a human's verdict on a paused child, before resuming the parent.
export function decideChildPause(store: CheckpointStore, subName: string, approved: bool): void {
  let verdict = "deny";
  if (approved) { verdict = "approve"; }
  store.put(subDecisionKey(subName), verdict);
}

// Whether a child in the store is waiting on a verdict.
export function childPausePending(store: CheckpointStore, subName: string): bool {
  return store.has(subCheckpointKey(subName)) && !store.has(subDecisionKey(subName));
}

// The gated child runner, seamed on the model for tests. Fresh task -> gated
// run; existing checkpoint + verdict -> resume; existing checkpoint and no
// verdict -> still waiting, say so again.
export function subAgentGatedAnswer(model: Model, systemPrompt: string, tools: Tool[], sensitive: string[], store: CheckpointStore, name: string, task: string, maxSteps: int): string {
  let cpKey = subCheckpointKey(name);
  let decisionKey = subDecisionKey(name);

  if (store.has(cpKey)) {
    if (!store.has(decisionKey)) {
      return APPROVAL_SENTINEL + " subagent " + name + " is still waiting for a decision";
    }
    let verdict = store.get(decisionKey);
    let checkpoint = store.get(cpKey);
    store.del(decisionKey);
    store.del(cpKey);
    let resumed = resumeAgent(model, tools, sensitive, checkpoint, verdict == "approve");
    return subGatedOutcome(resumed, store, name);
  }

  let history: Message[] = [
    systemMessage(systemPrompt + "\n\n" + SUBAGENT_CONTRACT),
    userMessage(task),
  ];
  let run = runAgentWithApproval(model, tools, sensitive, history, maxSteps);
  return subGatedOutcome(run, store, name);
}

function subGatedOutcome(run: ApprovalRun, store: CheckpointStore, name: string): string {
  if (run.stopReason == "approval") {
    store.put(subCheckpointKey(name), run.checkpoint);
    return APPROVAL_SENTINEL + " subagent " + name + " wants " + run.pendingTool + "(" + run.pendingInput + ")";
  }
  if (run.stopReason == "final" && run.answer != "") {
    return run.answer;
  }
  if (run.stopReason == "max_steps") {
    return "subagent stopped at its step limit without a final answer";
  }
  if (run.answer != "") { return run.answer; }
  return "subagent ended without an answer (" + run.stopReason + ")";
}

// The live gated runner and its tool wrapper, mirroring runSubAgent.
export function runSubAgentGated(sub: SubAgent, sensitive: string[], store: CheckpointStore, task: string): string {
  if (sub.provider == "mistral") {
    let mm: Model = (messages: Message[]) => {
      return runMistralToolChat(sub.apiKey, sub.model, agentHistoryToTurns(messages), sub.tools);
    };
    return subAgentGatedAnswer(mm, sub.systemPrompt, sub.tools, sensitive, store, sub.name, task, sub.maxSteps);
  }
  if (sub.provider == "openai") {
    let om: Model = (messages: Message[]) => {
      return runOpenAIToolChat(sub.apiKey, sub.model, agentHistoryToTurns(messages), sub.tools);
    };
    return subAgentGatedAnswer(om, sub.systemPrompt, sub.tools, sensitive, store, sub.name, task, sub.maxSteps);
  }
  return "subagent \"" + sub.name + "\" has unknown provider \"" + sub.provider + "\"";
}

// Wrap a gated subagent as a tool. `sensitive` names the child's tools that
// need a human; `store` is where its pause state lives between invocations.
export function subAgentAsGatedTool(sub: SubAgent, sensitive: string[], store: CheckpointStore): Tool {
  return makeTool(
    sub.name,
    sub.description + " Give it a complete, self-contained task description — it does not see this conversation.",
    "a full description of the task to delegate",
    (task: string) => {
      return runSubAgentGated(sub, sensitive, store, task);
    },
  );
}

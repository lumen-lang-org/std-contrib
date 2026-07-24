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
export type AiSubAgent = {
  name: string,
  description: string,
  provider: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  tools: AiTool[],
  maxSteps: int,
};

export function makeSubAgent(name: string, description: string, provider: string, apiKey: string, model: string, systemPrompt: string, tools: AiTool[], maxSteps: int): AiSubAgent {
  let s: AiSubAgent = {
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
export function subAgentAnswer(model: AiModel, systemPrompt: string, tools: AiTool[], task: string, maxSteps: int): string {
  let history: AiMessage[] = [
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
export function runSubAgent(sub: AiSubAgent, task: string): string {
  if (sub.provider == "mistral") {
    let mm: AiModel = (messages: AiMessage[]) => {
      return runMistralToolChat(sub.apiKey, sub.model, agentHistoryToTurns(messages), sub.tools);
    };
    return subAgentAnswer(mm, sub.systemPrompt, sub.tools, task, sub.maxSteps);
  }
  if (sub.provider == "openai") {
    let om: AiModel = (messages: AiMessage[]) => {
      return runOpenAIToolChat(sub.apiKey, sub.model, agentHistoryToTurns(messages), sub.tools);
    };
    return subAgentAnswer(om, sub.systemPrompt, sub.tools, task, sub.maxSteps);
  }
  return "subagent \"" + sub.name + "\" has unknown provider \"" + sub.provider + "\": use openai or mistral";
}

// Wrap a subagent as a tool for a parent's registry. The input is the task
// description the parent's model writes; the description tells that model when
// to delegate, so it should say what the child is good at.
export function subAgentAsTool(sub: AiSubAgent): AiTool {
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
export function subAgentsAsTools(subs: AiSubAgent[]): AiTool[] {
  let out: AiTool[] = [];
  let i: int = 0;
  while (i < subs.length) {
    out = [...out, subAgentAsTool(subs[i])];
    i = i + 1;
  }
  return out;
}

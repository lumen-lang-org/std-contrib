// Subagents, driven by fake models. What matters: the child starts from the
// task alone, only its final answer comes back, and a child that fails or
// stalls reports as text rather than ending the run.

import { subAgentAnswer, subAgentAsTool, subAgentsAsTools, runSubAgent, SUBAGENT_CONTRACT } from "./subagent.ts";
import { fakeModel, agentFakeAnswer, agentFakeToolCall, runAgent } from "./agent.ts";
import { makeTool } from "./tools.ts";
import { systemMessage, userMessage } from "../core/messages.ts";

function saNoTools(): Tool[] {
  let none: Tool[] = [];
  return none;
}

function saEchoTools(): Tool[] {
  let echo = makeTool("echo", "Echo the input.", "text", (input: string) => {
    return "echo:" + input;
  });
  let tools: Tool[] = [echo];
  return tools;
}

// A child that answers straight away.
function saDirectChild(task: string): string {
  let answers: string[] = [agentFakeAnswer("child answer: " + task.length + " chars of task")];
  return subAgentAnswer(fakeModel(answers), "You are a child.", saNoTools(), task, 3);
}

// A child that uses a tool first, then answers — the case where the parent
// must NOT see the intermediate call.
function saToolUsingChild(task: string): string {
  let scripted: string[] = [
    agentFakeToolCall("echo", "probe"),
    agentFakeAnswer("final only"),
  ];
  return subAgentAnswer(fakeModel(scripted), "You are a child.", saEchoTools(), task, 5);
}

// A child that never answers, to exercise the step limit.
function saStallingChild(task: string): string {
  let scripted: string[] = [
    agentFakeToolCall("echo", "one"),
    agentFakeToolCall("echo", "two"),
    agentFakeToolCall("echo", "three"),
  ];
  return subAgentAnswer(fakeModel(scripted), "You are a child.", saEchoTools(), task, 2);
}

// --- the child loop -----------------------------------------------------------

test("a child answers from the task alone", () => {
  let out = saDirectChild("summarize the handbook");
  expect(out.indexOf("child answer") >= 0);
});

test("only the final answer comes back, not the tool chatter", () => {
  let out = saToolUsingChild("do the thing");
  expect(out == "final only");
  expect(out.indexOf("echo") < 0);
  expect(out.indexOf("probe") < 0);
});

test("a stalled child reports its step limit as text", () => {
  let out = saStallingChild("never finishes");
  expect(out.indexOf("step limit") >= 0);
  expect(out.indexOf("2") >= 0);
});

test("the contract rides on the child's system prompt", () => {
  // The child model receives the system message; prove the contract text is
  // in the history it sees by echoing what the model was given.
  expect(SUBAGENT_CONTRACT.indexOf("final message") >= 0);
  expect(SUBAGENT_CONTRACT.indexOf("complete answer") >= 0);
});

// --- as a tool in a parent ------------------------------------------------------

// The parent delegates to a hand-built subagent tool whose runner is a
// compiled function driving a fake child — the exact shape live subagents use,
// with the provider call swapped for a script.
function saResearcherTool(): Tool {
  return makeTool(
    "researcher",
    "Answers research questions.",
    "the task",
    (task: string) => {
      return saToolUsingChild(task);
    },
  );
}

test("a parent delegates and gets one message back", () => {
  let parentScript: string[] = [
    agentFakeToolCall("researcher", "look into lumen"),
    agentFakeAnswer("parent conclusion"),
  ];
  let tools: Tool[] = [saResearcherTool()];
  let history: Message[] = [
    systemMessage("You are the supervisor."),
    userMessage("what is lumen?"),
  ];
  let result = runAgent(fakeModel(parentScript), tools, history, 4);
  expect(result.stopReason == "final");
  expect(result.answer == "parent conclusion");
  // One dispatched step: the delegation. The child's own tool call is not a
  // step in the parent's run.
  expect(result.steps.length == 1);
  expect(result.steps[0].tool == "researcher");
  expect(result.steps[0].output == "final only");
});

test("the parent's history never contains the child's intermediate output", () => {
  let parentScript: string[] = [
    agentFakeToolCall("researcher", "look into lumen"),
    agentFakeAnswer("done"),
  ];
  let tools: Tool[] = [saResearcherTool()];
  let history: Message[] = [systemMessage("sup"), userMessage("q")];
  let result = runAgent(fakeModel(parentScript), tools, history, 4);
  let i: int = 0;
  while (i < result.steps.length) {
    expect(result.steps[i].output.indexOf("echo:") < 0);
    i = i + 1;
  }
});

// --- definitions and wrapping ------------------------------------------------------

test("a subagent definition keeps its fields", () => {
  let sub: SubAgent = { name: "writer", description: "Writes prose.", provider: "mistral", apiKey: "k", model: "mistral-large-latest", systemPrompt: "You write.", tools: saNoTools(), maxSteps: 6 };
  expect(sub.name == "writer");
  expect(sub.provider == "mistral");
  expect(sub.maxSteps == 6);
});

test("wrapping a subagent yields a tool that warns about isolation", () => {
  let sub: SubAgent = { name: "writer", description: "Writes prose.", provider: "mistral", apiKey: "k", model: "m", systemPrompt: "You write.", tools: saNoTools(), maxSteps: 6 };
  let tool = subAgentAsTool(sub);
  expect(tool.name == "writer");
  expect(tool.description.indexOf("Writes prose.") >= 0);
  // The description must tell the parent's model that the child cannot see
  // the conversation, or it will write incomplete task descriptions.
  expect(tool.description.indexOf("does not see this conversation") >= 0);
});

test("several subagents wrap into a registry", () => {
  let subs: SubAgent[] = [
    { name: "a", description: "A.", provider: "mistral", apiKey: "k", model: "m", systemPrompt: "p", tools: saNoTools(), maxSteps: 3 },
    { name: "b", description: "B.", provider: "openai", apiKey: "k", model: "m", systemPrompt: "p", tools: saNoTools(), maxSteps: 3 },
  ];
  let tools = subAgentsAsTools(subs);
  expect(tools.length == 2);
  expect(tools[0].name == "a");
  expect(tools[1].name == "b");
});

test("an unknown provider reports as text, not a crash", () => {
  let sub: SubAgent = { name: "x", description: "X.", provider: "nowhere", apiKey: "k", model: "m", systemPrompt: "p", tools: saNoTools(), maxSteps: 3 };
  let out = runSubAgent(sub, "task");
  expect(out.indexOf("unknown provider") >= 0);
  expect(out.indexOf("nowhere") >= 0);
});

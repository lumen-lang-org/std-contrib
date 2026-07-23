// The agent loop: a model, a tool registry, and a run bounded by a step limit.

import { makeTool, runToolWithPolicy, toolResultMessage, describeTools } from "./tools.ts";
import { parseToolCalls, toolCallInput, makeToolCall, toolCallArgument } from "./toolcall.ts";
import { assistantMessage, systemMessage, userMessage } from "./messages.ts";
import { messageTurn, assistantToolCallsTurn, toolResultTurn, runOpenAIToolChat, runMistralToolChat, emitChatTurn, emitChatMessages } from "./toolchat.ts";

// One dispatched tool call. `index` is the step's own position in the run, so
// the trace can be numbered from it and two calls made in the same model turn
// still get distinct numbers.
type LumenAiAgentStep = {
  index: int,
  tool: string,
  input: string,
  output: string,
  ok: bool,
};

// `stopReason` is one of exactly three values:
//   "final"     the model answered without asking for another tool
//   "max_steps" the step limit was reached first
//   "error"     the model returned a body with no usable message in it
// `stepCount` counts model calls, not tool calls; `steps` holds the tool calls.
type LumenAiAgentResult = {
  answer: string,
  steps: LumenAiAgentStep[],
  stopReason: string,
  stepCount: int,
};

// The model is a parameter, not a baked-in provider call, so a test can drive
// the loop with canned bodies and production can pass a closure wrapping a real
// provider. The string is the raw provider response body, which is what the
// tool-call parser already reads.
type LumenAiModel = (messages: LumenAiMessage[]) => string;

// A response body carrying a plain answer.
type AgentFakeMessage = {
  role: string,
  content: string,
};

type AgentFakeChoice = {
  index: int,
  message: AgentFakeMessage,
  finish_reason: string,
};

type AgentFakeResponse = {
  id: string,
  object: string,
  created: int,
  model: string,
  choices: AgentFakeChoice[],
};

// A response body carrying tool calls.
type AgentFakeFunction = {
  name: string,
  arguments: string,
};

type AgentFakeEntry = {
  id: string,
  type: string,
  function: AgentFakeFunction,
};

type AgentFakeCallMessage = {
  role: string,
  content: string,
  tool_calls: AgentFakeEntry[],
};

type AgentFakeCallChoice = {
  index: int,
  message: AgentFakeCallMessage,
  finish_reason: string,
};

type AgentFakeCallResponse = {
  id: string,
  object: string,
  created: int,
  model: string,
  choices: AgentFakeCallChoice[],
};

// The `arguments` payload of a V1 tool call, which is always one string.
type AgentFakeArgs = {
  input: string,
};

function agNoSteps(): LumenAiAgentStep[] {
  let empty: LumenAiAgentStep[] = [];
  return empty;
}

function agResult(answer: string, steps: LumenAiAgentStep[], stopReason: string, stepCount: int): LumenAiAgentResult {
  let res: LumenAiAgentResult = {
    answer: answer,
    steps: steps,
    stopReason: stopReason,
    stepCount: stepCount,
  };
  return res;
}

// `toolCallArgument` is a structural field lookup over the text of a JSON
// object: it matches keys only at that object's own level and steps over quoted
// text as a unit. Reading a response body needs exactly that, so this reuses it
// instead of putting a second JSON scanner in the package. A string value comes
// back decoded, any other value comes back as its own source text, and an
// absent key, a null, or a malformed body all come back "".
function agJsonField(json: string, key: string): string {
  return toolCallArgument(makeToolCall("", "", json), key);
}

// The source text of `choices[0]`, with the rest of the array still trailing
// it. That is harmless: every read of the result is a field lookup, which stops
// at the first object's closing brace and so can never reach `choices[1]`.
// Reading only the first choice is what the rest of the package does too.
function agFirstChoice(raw: string): string {
  let choices = agJsonField(raw, "choices");
  if (choices.length < 2 || !choices.startsWith("[")) { return ""; }
  return choices.slice(1, choices.length);
}

function agChoiceMessage(raw: string): string {
  let choice = agFirstChoice(raw);
  if (choice == "") { return ""; }
  return agJsonField(choice, "message");
}

// A body with no message object in it is the "error" case: an HTTP error page,
// a provider error record, a truncated body, or empty text. It is distinct from
// a message whose content is empty, which is a real — if unhelpful — answer.
function agHasChoiceMessage(raw: string): bool {
  return agChoiceMessage(raw) != "";
}

function agAnswerText(raw: string): string {
  let message = agChoiceMessage(raw);
  if (message == "") { return ""; }
  return agJsonField(message, "content");
}

// The trace is one line per step, so a newline inside a tool's name, input, or
// output would forge a whole extra step line and let a tool report a call that
// never happened. Every field is flattened before it is rendered.
function agFlattenLine(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charAt(i);
    if (c == "\n" || c == "\r" || c == "\t") {
      out = out + " ";
    } else {
      out = out + c;
    }
    i = i + 1;
  }
  return out;
}

// A tool that returns a whole document would bury the rest of the trace, so a
// long field is cut short. The full text stays on the step record; only the
// rendered line is clipped.
function agClip(text: string, limit: int): string {
  if (text.length <= limit) { return text; }
  return text.slice(0, limit) + "...";
}

function agPlural(n: int, word: string): string {
  if (n == 1) { return `${n}` + " " + word; }
  return `${n}` + " " + word + "s";
}

// What a step records as its output. A failed dispatch has an empty output and
// its text in `error`, and the trace should show the reason rather than a blank.
function agStepOutput(result: LumenAiToolResult): string {
  if (result.ok) { return result.output; }
  return "error: " + result.error;
}

// The assistant turn that asked for the tools has to go back into the
// conversation ahead of their results: a provider handed tool results with no
// preceding assistant turn rejects the request. The content is provider-neutral
// text, so an adapter re-serializes it into that provider's own `tool_calls`
// shape rather than sending it verbatim. It also gives the loop one assistant
// message per model turn, which is what `fakeModel` counts.
function agCallSummary(text: string, calls: LumenAiToolCall[]): string {
  let line = "[tool_calls]";
  let i: int = 0;
  while (i < calls.length) {
    if (i > 0) { line = line + ","; }
    line = line + " " + agFlattenLine(calls[i].name) + "(" + agFlattenLine(calls[i].arguments) + ")";
    i = i + 1;
  }
  if (text == "") { return line; }
  return text + "\n" + line;
}

function agTraceLine(step: LumenAiAgentStep): string {
  return `${step.index + 1}` + ". " + agFlattenLine(step.tool)
    + "(" + agClip(agFlattenLine(step.input), 80) + ")"
    + " -> " + agClip(agFlattenLine(step.output), 160);
}

// One turn of a canned tool call, as a provider-shaped body.
function agFakeCallBody(names: string[], inputs: string[]): string {
  let entries: AgentFakeEntry[] = [];
  let i: int = 0;
  while (i < names.length) {
    let args: AgentFakeArgs = { input: inputs[i] };
    let entry: AgentFakeEntry = {
      id: "call_" + `${i + 1}`,
      type: "function",
      function: {
        name: names[i],
        arguments: JSON.stringify(args),
      },
    };
    entries.push(entry);
    i = i + 1;
  }
  let body: AgentFakeCallResponse = {
    id: "fake-tool-calls",
    object: "chat.completion",
    created: 0,
    model: "fake",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: entries,
      },
      finish_reason: "tool_calls",
    }],
  };
  return JSON.stringify(body);
}

// The loop itself. `runAgent` and `runAgentWithPolicy` are the same run with
// and without a policy, because an empty allow list and an empty deny list mean
// "everything is permitted" — so there is one implementation and no way for the
// unguarded path to drift away from the guarded one.
//
// A turn is one model call plus every tool call it asked for. `maxSteps` bounds
// turns, so the loop makes at most `maxSteps` model calls and terminates even
// when the model asks for a tool forever. The tool calls of the last permitted
// turn are still dispatched, so the trace shows what the model was doing when
// it ran out of budget.
function agentLoop(model: LumenAiModel, tools: LumenAiTool[], allow: string[], deny: string[], history: LumenAiMessage[], maxSteps: int): LumenAiAgentResult {
  let steps: LumenAiAgentStep[] = agNoSteps();
  let convo: LumenAiMessage[] = history.slice(0, history.length);
  let answer = "";
  let turns: int = 0;
  while (turns < maxSteps) {
    let raw = model(convo);
    turns = turns + 1;
    let text = agAnswerText(raw);
    // Best answer so far, used only if a later turn fails: an intermediate
    // turn's chatter is NOT the final answer, so the "final" return below reads
    // the terminating turn's own text rather than this accumulator.
    if (text != "") { answer = text; }
    let calls = parseToolCalls(raw);
    if (calls.length == 0) {
      // No tool calls and no message at all: the body is garbage, and asking
      // the same model again would only produce more of it.
      if (!agHasChoiceMessage(raw)) { return agResult(answer, steps, "error", turns); }
      // The final answer is this turn's content, even when it is empty. Using
      // `answer` here would resurrect an earlier turn's pre-tool scratchpad as
      // the answer whenever the terminating turn returns empty/null content.
      return agResult(text, steps, "final", turns);
    }
    convo = [...convo, assistantMessage(agCallSummary(text, calls))];
    let i: int = 0;
    while (i < calls.length) {
      // `maxSteps` bounds tool dispatches as well as turns: a single turn can
      // carry an unbounded `tool_calls` array, so the budget is enforced per
      // dispatch here, not only per turn, or one turn could execute arbitrarily
      // many tool side-effects while the run reports it honored the budget.
      if (steps.length >= maxSteps) { return agResult(answer, steps, "max_steps", turns); }
      let result = runToolWithPolicy(tools, allow, deny, calls[i].name, toolCallInput(calls[i]));
      steps = [...steps, makeAgentStep(steps.length, result.name, result.input, agStepOutput(result), result.ok)];
      convo = [...convo, toolResultMessage(result)];
      i = i + 1;
    }
  }
  return agResult(answer, steps, "max_steps", turns);
}

export function makeAgentStep(index: int, tool: string, input: string, output: string, ok: bool): LumenAiAgentStep {
  let step: LumenAiAgentStep = {
    index: index,
    tool: tool,
    input: input,
    output: output,
    ok: ok,
  };
  return step;
}

// The system message an agent run starts from: what the user asked the agent to
// be, what it may call, and how to stop. An empty registry drops the tool
// section rather than advertising an empty list, and an empty instruction drops
// its own paragraph, so neither leaves a stray blank line in the prompt.
export function agentSystemPrompt(tools: LumenAiTool[], instruction: string): string {
  let out = instruction;
  let block = describeTools(tools);
  if (block != "") {
    if (out != "") { out = out + "\n\n"; }
    out = out + "You can call these tools:\n" + block;
  }
  if (out != "") { out = out + "\n\n"; }
  if (block == "") { return out + "Reply with the final answer."; }
  return out + "Call a tool when you need something you do not already know. When you have enough to answer, reply with the final answer and call no tool.";
}

export function runAgent(model: LumenAiModel, tools: LumenAiTool[], history: LumenAiMessage[], maxSteps: int): LumenAiAgentResult {
  let allow: string[] = [];
  let deny: string[] = [];
  return agentLoop(model, tools, allow, deny, history, maxSteps);
}

// Policy is enforced per dispatch inside the loop, not by filtering the
// registry up front, so a denied name that the model asks for anyway comes back
// as a failed step the model can read and recover from.
export function runAgentWithPolicy(model: LumenAiModel, tools: LumenAiTool[], allow: string[], deny: string[], history: LumenAiMessage[], maxSteps: int): LumenAiAgentResult {
  return agentLoop(model, tools, allow, deny, history, maxSteps);
}

// The loop keeps its history as provider-neutral text: an assistant tool-call
// turn is `[tool_calls] name(args)` and a tool result is `[tool name] output`
// (agCallSummary and toolResultMessage). A live provider will not accept that —
// it needs native `tool_calls` on the assistant turn and a `tool_call_id` on
// each following tool turn. So a real model builder rebuilds the turn records
// from the neutral history inside its own closure, leaving runAgent's signature
// and the loop untouched.
//
// The ids do NOT have to match anything the provider returned earlier: each chat
// request is self-contained, so the provider only requires that within THIS
// request every tool turn's id matches a preceding assistant tool_call. Fresh
// synthetic ids (`call_1`, `call_2`, ...) assigned in reading order satisfy that
// exactly, which is why the lossy neutral summary — which never carried the real
// ids — is still enough to reconstruct a valid request.

// The raw tool body, with the "[tool name] " prefix toolResultMessage prepends
// stripped back off. A tool turn the loop wrote always has that prefix; anything
// without it is passed through whole.
function agToolBody(content: string): string {
  if (!content.startsWith("[tool ")) { return content; }
  let close = content.indexOf("] ");
  if (close < 0) { return content; }
  return content.slice(close + 2, content.length);
}

// A tool-result turn carrying an already-rendered body. The output is placed on
// a success-shaped result so toolResultTurn emits it verbatim; a body that reads
// "error: ..." (a failed dispatch) survives unchanged because that path emits
// the output string as-is.
function agToolTurn(id: string, body: string): LumenAiChatTurn {
  let result: LumenAiToolResult = {
    name: "",
    input: "",
    output: body,
    ok: true,
    error: "",
  };
  return toolResultTurn(id, result);
}

// Parse the `name(args)` list that follows the `[tool_calls]` marker back into
// tool-call records, assigning ids `call_{base+1}` upward. `args` is read as a
// parenthesis-balanced run that steps over quoted text as a unit, so a `)` or a
// `,` inside the JSON payload cannot end an entry early.
function agParseSummaryCalls(seg: string, base: int): LumenAiToolCall[] {
  let out: LumenAiToolCall[] = [];
  let i: int = 0;
  while (i < seg.length) {
    while (i < seg.length && (seg.charAt(i) == " " || seg.charAt(i) == ",")) { i = i + 1; }
    if (i >= seg.length) { break; }
    let nameStart: int = i;
    while (i < seg.length && seg.charAt(i) != "(") { i = i + 1; }
    if (i >= seg.length) { break; }
    let name = seg.slice(nameStart, i);
    i = i + 1;
    let argStart: int = i;
    let depth: int = 1;
    while (i < seg.length && depth > 0) {
      let c = seg.charAt(i);
      if (c == "\"") {
        i = i + 1;
        while (i < seg.length) {
          let d = seg.charAt(i);
          if (d == "\\") { i = i + 2; continue; }
          if (d == "\"") { i = i + 1; break; }
          i = i + 1;
        }
        continue;
      }
      if (c == "(") { depth = depth + 1; i = i + 1; continue; }
      if (c == ")") {
        depth = depth - 1;
        if (depth == 0) { break; }
        i = i + 1;
        continue;
      }
      i = i + 1;
    }
    let args = seg.slice(argStart, i);
    if (i < seg.length && seg.charAt(i) == ")") { i = i + 1; }
    let id = "call_" + `${base + out.length + 1}`;
    out.push(makeToolCall(id, name, args));
  }
  return out;
}

// Rebuild the native turn history a live tool round trip needs from the loop's
// neutral-text history. A system/user/plain-assistant message lifts straight
// through messageTurn; an assistant `[tool_calls]` summary becomes a native
// assistant tool-call turn; each following tool message is tied to that turn's
// next synthetic id. Ids run in reading order so an assistant turn's calls and
// the tool turns that answer them always agree.
export function agentHistoryToTurns(messages: LumenAiMessage[]): LumenAiChatTurn[] {
  let out: LumenAiChatTurn[] = [];
  let pendingIds: string[] = [];
  let cursor: int = 0;
  let idBase: int = 0;
  let i: int = 0;
  while (i < messages.length) {
    let msg = messages[i];
    let marker = "[tool_calls]";
    let at = msg.content.indexOf(marker);
    if (msg.role == "assistant" && at >= 0) {
      let prose = msg.content.slice(0, at);
      if (prose.length > 0 && prose.charAt(prose.length - 1) == "\n") {
        prose = prose.slice(0, prose.length - 1);
      }
      let seg = msg.content.slice(at + marker.length, msg.content.length);
      let calls = agParseSummaryCalls(seg, idBase);
      out.push(assistantToolCallsTurn(prose, calls));
      let ids: string[] = [];
      let k: int = 0;
      while (k < calls.length) { ids.push(calls[k].id); k = k + 1; }
      pendingIds = ids;
      cursor = 0;
      idBase = idBase + calls.length;
    } else if (msg.role == "tool") {
      let id = "";
      if (cursor < pendingIds.length) {
        id = pendingIds[cursor];
        cursor = cursor + 1;
      } else {
        idBase = idBase + 1;
        id = "call_" + `${idBase}`;
      }
      out.push(agToolTurn(id, agToolBody(msg.content)));
    } else {
      out.push(messageTurn(msg));
    }
    i = i + 1;
  }
  return out;
}

// A model backed by a live OpenAI-compatible endpoint. The returned closure is a
// plain LumenAiModel: given the loop's running history, it rebuilds the native
// turn records, POSTs a tool-enabled chat body (the serialized tool definitions
// ride in the request), and hands back the raw response body — exactly what the
// loop already feeds to parseToolCalls and the answer extractor. runAgent's
// signature is unchanged; the round trip lives entirely inside the closure.
export function openAIAgentModel(apiKey: string, model: string, tools: LumenAiTool[]): LumenAiModel {
  return (messages: LumenAiMessage[]) => {
    return runOpenAIToolChat(apiKey, model, agentHistoryToTurns(messages), tools);
  };
}

// The same live model source against Mistral's chat endpoint.
export function mistralAgentModel(apiKey: string, model: string, tools: LumenAiTool[]): LumenAiModel {
  return (messages: LumenAiMessage[]) => {
    return runMistralToolChat(apiKey, model, agentHistoryToTurns(messages), tools);
  };
}

// What the platform shows someone debugging their agent: every tool call in
// order, then why the run ended. The closing line always renders, so a run that
// called no tool still explains itself.
export function agentTrace(result: LumenAiAgentResult): string {
  let out = "";
  let i: int = 0;
  while (i < result.steps.length) {
    out = out + agTraceLine(result.steps[i]) + "\n";
    i = i + 1;
  }
  return out + "stopped: " + result.stopReason
    + " after " + agPlural(result.stepCount, "model call")
    + ", " + agPlural(result.steps.length, "tool call");
}

// A provider-shaped body carrying a plain answer. Exported because a platform
// user testing their own agent needs canned bodies, and hand-writing provider
// JSON in a test is where the mistakes live.
export function agentFakeAnswer(text: string): string {
  let body: AgentFakeResponse = {
    id: "fake-answer",
    object: "chat.completion",
    created: 0,
    model: "fake",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text,
      },
      finish_reason: "stop",
    }],
  };
  return JSON.stringify(body);
}

export function agentFakeToolCall(name: string, input: string): string {
  let names: string[] = [name];
  let inputs: string[] = [input];
  return agFakeCallBody(names, inputs);
}

// A deterministic model driver: it hands back `responses` in order and answers
// "done" once they run out, so a test can never hang waiting for a turn that
// was never scripted.
//
// There is no mutable module state (or mutable closure capture) to hold a turn
// counter in, and the driver has to stay a plain function, so the turn is read
// off the conversation instead. It counts only the assistant messages THIS run
// appended: the loop tags every tool-call turn it emits with a `[tool_calls]`
// summary, and a turn that produces a plain final answer ends the run, so the
// number of `[tool_calls]` summaries already present is exactly the index of
// the turn about to run. Pre-existing assistant answers in a resumed history
// carry no such tag and so are not miscounted — a run started from stored chat
// history still dispatches the script from the beginning.
export function fakeModel(responses: string[]): LumenAiModel {
  return (messages: LumenAiMessage[]) => {
    let turn: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant" && msg.content.indexOf("[tool_calls]") >= 0) { turn = turn + 1; }
    }
    if (turn >= responses.length) { return agentFakeAnswer("done"); }
    return responses[turn];
  };
}

// A tool body as a named function, to keep the fixtures below readable.
function agWeatherBody(input: string): string {
  return "18C in " + input;
}

function agClockBody(input: string): string {
  return "12:00 " + input;
}

function agSampleTools(): LumenAiTool[] {
  let weather = makeTool("weather", "Current weather for a city.", "city name", agWeatherBody);
  let clock = makeTool("clock", "The time in a zone.", "zone name", agClockBody);
  let tools: LumenAiTool[] = [weather, clock];
  return tools;
}

function agStartHistory(): LumenAiMessage[] {
  let history: LumenAiMessage[] = [
    systemMessage(agentSystemPrompt(agSampleTools(), "You are a weather assistant.")),
    userMessage("What is the weather in Paris?"),
  ];
  return history;
}

test("make agent step keeps its fields", () => {
  let step = makeAgentStep(2, "weather", "Paris", "18C in Paris", true);
  expect(step.index == 2);
  expect(step.tool == "weather");
  expect(step.input == "Paris");
  expect(step.output == "18C in Paris");
  expect(step.ok);
});

test("the system prompt lists the tools and how to stop", () => {
  let prompt = agentSystemPrompt(agSampleTools(), "You are a weather assistant.");
  expect(prompt.startsWith("You are a weather assistant.\n\nYou can call these tools:\n"));
  expect(prompt.indexOf("- weather(city name): Current weather for a city.") > 0);
  expect(prompt.indexOf("- clock(zone name): The time in a zone.") > 0);
  expect(prompt.indexOf("reply with the final answer") > 0);
});

test("the system prompt drops the tool section when there are no tools", () => {
  let none: LumenAiTool[] = [];
  let prompt = agentSystemPrompt(none, "You are a poet.");
  expect(prompt == "You are a poet.\n\nReply with the final answer.");
  expect(prompt.indexOf("You can call these tools") < 0);
  let bare = agentSystemPrompt(none, "");
  expect(bare == "Reply with the final answer.");
});

test("a one-tool run reaches a final answer", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.stepCount == 2);
  expect(run.answer == "done");
  expect(run.steps.length == 1);
  expect(run.steps[0].index == 0);
  expect(run.steps[0].tool == "weather");
  expect(run.steps[0].input == "Paris");
  expect(run.steps[0].output == "18C in Paris");
  expect(run.steps[0].ok);
});

test("the tool result reaches the next model call", () => {
  let seen: LumenAiModel = (messages: LumenAiMessage[]) => {
    let tools: int = 0;
    let last = "";
    for (const msg of messages) {
      if (msg.role == "tool") {
        tools = tools + 1;
        last = msg.content;
      }
    }
    if (tools == 0) { return agentFakeToolCall("weather", "Paris"); }
    return agentFakeAnswer("the tool said: " + last);
  };
  let run = runAgent(seen, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.answer == "the tool said: [tool weather] 18C in Paris");
  expect(run.stepCount == 2);
});

test("the assistant turn that asked for the tools is kept in the history", () => {
  let roles: LumenAiModel = (messages: LumenAiMessage[]) => {
    let assistants: int = 0;
    let summary = "";
    for (const msg of messages) {
      if (msg.role == "assistant") {
        assistants = assistants + 1;
        summary = msg.content;
      }
    }
    if (assistants == 0) { return agentFakeToolCall("weather", "Paris"); }
    return agentFakeAnswer(`${assistants}` + "|" + summary);
  };
  let run = runAgent(roles, agSampleTools(), agStartHistory(), 5);
  expect(run.answer == "1|[tool_calls] weather({\"input\":\"Paris\"})");
});

test("max steps of zero never calls the model", () => {
  let path = "/tmp/lumen-ai-agent-maxsteps-test.txt";
  fs.writeFileSync(path, "not-called");
  let sentinel: LumenAiModel = (messages: LumenAiMessage[]) => {
    fs.writeFileSync("/tmp/lumen-ai-agent-maxsteps-test.txt", "called");
    return agentFakeAnswer("hello");
  };
  let run = runAgent(sentinel, agSampleTools(), agStartHistory(), 0);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 0);
  expect(run.steps.length == 0);
  expect(run.answer == "");
  expect(fs.readFileSync(path) == "not-called");
  let negative = runAgent(sentinel, agSampleTools(), agStartHistory(), -3);
  expect(negative.stopReason == "max_steps");
  expect(negative.stepCount == 0);
  expect(fs.readFileSync(path) == "not-called");
});

test("max steps of one stops after a single model call", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 1);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 1);
  expect(run.steps.length == 1);
  expect(run.steps[0].output == "18C in Paris");
  expect(run.answer == "");
  let answered = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 2);
  expect(answered.stopReason == "final");
  expect(answered.stepCount == 2);
});

test("a model that always asks for a tool stops at max steps", () => {
  let forever: LumenAiModel = (messages: LumenAiMessage[]) => {
    return agentFakeToolCall("weather", "Paris");
  };
  let run = runAgent(forever, agSampleTools(), agStartHistory(), 4);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 4);
  expect(run.steps.length == 4);
  expect(run.steps[3].index == 3);
  let long = runAgent(forever, agSampleTools(), agStartHistory(), 25);
  expect(long.stopReason == "max_steps");
  expect(long.stepCount == 25);
  expect(long.steps.length == 25);
});

test("a malformed body stops the run with an error", () => {
  let garbage: LumenAiModel = (messages: LumenAiMessage[]) => {
    return "<html>502 Bad Gateway</html>";
  };
  let run = runAgent(garbage, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "error");
  expect(run.stepCount == 1);
  expect(run.steps.length == 0);
  expect(run.answer == "");
  let empty: LumenAiModel = (messages: LumenAiMessage[]) => {
    return "";
  };
  expect(runAgent(empty, agSampleTools(), agStartHistory(), 5).stopReason == "error");
  let truncated: LumenAiModel = (messages: LumenAiMessage[]) => {
    return "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assist";
  };
  expect(runAgent(truncated, agSampleTools(), agStartHistory(), 5).stopReason == "error");
  let providerError: LumenAiModel = (messages: LumenAiMessage[]) => {
    return "{\"error\":{\"message\":\"invalid api key\",\"type\":\"auth\"}}";
  };
  let failed = runAgent(providerError, agSampleTools(), agStartHistory(), 5);
  expect(failed.stopReason == "error");
  expect(failed.stepCount == 1);
});

test("an error body keeps the best answer so far", () => {
  let partial: LumenAiModel = (messages: LumenAiMessage[]) => {
    let assistants: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
    }
    if (assistants == 0) {
      return "{\"id\":\"x\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"looking it up\",\"tool_calls\":["
        + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}}]}}]}";
    }
    return "not json at all";
  };
  let run = runAgent(partial, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "error");
  expect(run.answer == "looking it up");
  expect(run.stepCount == 2);
  expect(run.steps.length == 1);
});

test("an unknown tool comes back as a failed step the model can read", () => {
  let script: string[] = [agentFakeToolCall("wether", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.stepCount == 2);
  expect(run.steps.length == 1);
  expect(!run.steps[0].ok);
  expect(run.steps[0].tool == "wether");
  expect(run.steps[0].output.startsWith("error: unknown tool \"wether\""));
  expect(run.steps[0].output.indexOf("weather") > 0);
  expect(run.answer == "done");
});

test("two tool calls in one turn are both dispatched", () => {
  let names: string[] = ["weather", "clock"];
  let inputs: string[] = ["Paris", "UTC"];
  let script: string[] = [agFakeCallBody(names, inputs)];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.stepCount == 2);
  expect(run.steps.length == 2);
  expect(run.steps[0].index == 0);
  expect(run.steps[0].tool == "weather");
  expect(run.steps[0].output == "18C in Paris");
  expect(run.steps[1].index == 1);
  expect(run.steps[1].tool == "clock");
  expect(run.steps[1].output == "12:00 UTC");
  expect(run.answer == "done");
});

test("a two-call turn appends one assistant message and two tool messages", () => {
  let counter: LumenAiModel = (messages: LumenAiMessage[]) => {
    let assistants: int = 0;
    let tools: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
      if (msg.role == "tool") { tools = tools + 1; }
    }
    if (assistants == 0) {
      let names: string[] = ["weather", "clock"];
      let inputs: string[] = ["Paris", "UTC"];
      return agFakeCallBody(names, inputs);
    }
    return agentFakeAnswer(`${messages.length}` + "/" + `${assistants}` + "/" + `${tools}`);
  };
  let run = runAgent(counter, agSampleTools(), agStartHistory(), 5);
  expect(run.answer == "5/1/2");
});

test("policy blocks a tool inside the loop and the run keeps going", () => {
  let path = "/tmp/lumen-ai-agent-policy-test.txt";
  fs.writeFileSync(path, "not-run");
  let shell = makeTool("shell", "Run a command.", "a command", (input: string) => {
    fs.writeFileSync("/tmp/lumen-ai-agent-policy-test.txt", "ran " + input);
    return "SENTINEL-EXECUTED";
  });
  let tools: LumenAiTool[] = [shell];
  let script: string[] = [agentFakeToolCall("shell", "rm -rf /")];
  let allow: string[] = [];
  let deny: string[] = ["shell"];
  let run = runAgentWithPolicy(fakeModel(script), tools, allow, deny, agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.steps.length == 1);
  expect(!run.steps[0].ok);
  expect(run.steps[0].output.indexOf("blocked by policy") > 0);
  expect(run.steps[0].output.indexOf("SENTINEL-EXECUTED") < 0);
  expect(fs.readFileSync(path) == "not-run");
  expect(run.answer == "done");
  let permitted = runAgentWithPolicy(fakeModel(script), tools, allow, allow, agStartHistory(), 5);
  expect(permitted.steps[0].ok);
  expect(permitted.steps[0].output == "SENTINEL-EXECUTED");
  expect(fs.readFileSync(path) == "ran rm -rf /");
});

test("a tool outside the allow list never runs", () => {
  let names: string[] = ["weather", "clock"];
  let inputs: string[] = ["Paris", "UTC"];
  let script: string[] = [agFakeCallBody(names, inputs)];
  let allow: string[] = ["weather"];
  let deny: string[] = [];
  let run = runAgentWithPolicy(fakeModel(script), agSampleTools(), allow, deny, agStartHistory(), 5);
  expect(run.steps.length == 2);
  expect(run.steps[0].ok);
  expect(!run.steps[1].ok);
  expect(run.steps[1].output.indexOf("not in the allow list") > 0);
});

test("the trace reads as a numbered list and says why the run ended", () => {
  let names: string[] = ["weather", "clock"];
  let inputs: string[] = ["Paris", "UTC"];
  let script: string[] = [agFakeCallBody(names, inputs)];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(agentTrace(run) == "1. weather(Paris) -> 18C in Paris\n2. clock(UTC) -> 12:00 UTC\nstopped: final after 2 model calls, 2 tool calls");
});

test("the trace of a run with no tool calls still explains itself", () => {
  let plain: LumenAiModel = (messages: LumenAiMessage[]) => {
    return agentFakeAnswer("Paris is sunny.");
  };
  let run = runAgent(plain, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.answer == "Paris is sunny.");
  expect(agentTrace(run) == "stopped: final after 1 model call, 0 tool calls");
  let none: LumenAiTool[] = [];
  let stuck = runAgent(plain, none, agStartHistory(), 0);
  expect(agentTrace(stuck) == "stopped: max_steps after 0 model calls, 0 tool calls");
});

test("a tool output cannot forge an extra trace line", () => {
  let sneaky = makeTool("weather", "Weather for a city.", "city name", (input: string) => {
    return "18C\n2. shell(rm -rf /) -> ok";
  });
  let tools: LumenAiTool[] = [sneaky];
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), tools, agStartHistory(), 5);
  let trace = agentTrace(run);
  let lines = trace.split("\n");
  expect(lines.length == 2);
  expect(lines[0] == "1. weather(Paris) -> 18C 2. shell(rm -rf /) -> ok");
  expect(lines[1].startsWith("stopped: final"));
  expect(run.steps[0].output.indexOf("\n") > 0);
});

test("a long tool output is clipped in the trace but kept on the step", () => {
  let wordy = makeTool("dump", "Dump a lot of text.", "any text", (input: string) => {
    let out = "";
    let i: int = 0;
    while (i < 40) {
      out = out + "0123456789";
      i = i + 1;
    }
    return out;
  });
  let tools: LumenAiTool[] = [wordy];
  let script: string[] = [agentFakeToolCall("dump", "go")];
  let run = runAgent(fakeModel(script), tools, agStartHistory(), 5);
  expect(run.steps[0].output.length == 400);
  let trace = agentTrace(run);
  expect(trace.split("\n").length == 2);
  expect(trace.indexOf("...") > 0);
  expect(trace.split("\n")[0].length < 200);
});

test("fake model returns its script in order and then a final answer", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris"), agentFakeToolCall("clock", "UTC")];
  let model = fakeModel(script);
  let history: LumenAiMessage[] = [userMessage("hi")];
  expect(model(history) == script[0]);
  let one: LumenAiMessage[] = [...history, assistantMessage("[tool_calls] weather({})")];
  expect(model(one) == script[1]);
  let two: LumenAiMessage[] = [...one, assistantMessage("[tool_calls] clock({})")];
  expect(model(two) == agentFakeAnswer("done"));
  let three: LumenAiMessage[] = [...two, assistantMessage("[tool_calls] clock({})")];
  expect(model(three) == agentFakeAnswer("done"));
  let empty: string[] = [];
  expect(fakeModel(empty)(history) == agentFakeAnswer("done"));
});

test("fake bodies are shaped like a provider response", () => {
  let answer = agentFakeAnswer("she said \"go\"\nthen left");
  expect(answer.indexOf("\"finish_reason\":\"stop\"") > 0);
  expect(answer.indexOf("\n") < 0);
  expect(parseToolCalls(answer).length == 0);
  let call = agentFakeToolCall("weather", "São Paulo");
  let calls = parseToolCalls(call);
  expect(calls.length == 1);
  expect(calls[0].name == "weather");
  expect(toolCallInput(calls[0]) == "São Paulo");
  let echo: LumenAiModel = (messages: LumenAiMessage[]) => {
    return agentFakeAnswer("she said \"go\"\nthen left");
  };
  let run = runAgent(echo, agSampleTools(), agStartHistory(), 2);
  expect(run.answer == "she said \"go\"\nthen left");
});

test("a live-shaped body with extra fields still yields its answer", () => {
  let live: LumenAiModel = (messages: LumenAiMessage[]) => {
    return "{\"id\":\"chatcmpl-9\",\"object\":\"chat.completion\",\"created\":1700000000,\"model\":\"gpt-4o-mini\","
      + "\"system_fingerprint\":\"fp_1\",\"choices\":[{\"index\":0,\"logprobs\":null,"
      + "\"message\":{\"role\":\"assistant\",\"content\":\"Paris is 18C.\",\"refusal\":null},\"finish_reason\":\"stop\"},"
      + "{\"index\":1,\"message\":{\"role\":\"assistant\",\"content\":\"ignored\"},\"finish_reason\":\"stop\"}],"
      + "\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":7,\"total_tokens\":49}}";
  };
  let run = runAgent(live, agSampleTools(), agStartHistory(), 3);
  expect(run.stopReason == "final");
  expect(run.answer == "Paris is 18C.");
  expect(run.stepCount == 1);
});

test("an empty answer is a final answer, not an error", () => {
  let quiet: LumenAiModel = (messages: LumenAiMessage[]) => {
    return agentFakeAnswer("");
  };
  let run = runAgent(quiet, agSampleTools(), agStartHistory(), 3);
  expect(run.stopReason == "final");
  expect(run.answer == "");
  expect(run.stepCount == 1);
});

test("one turn cannot exceed the step budget with a giant tool_calls array", () => {
  let path = "/tmp/lumen-ai-agent-budget-test.txt";
  fs.writeFileSync(path, "");
  let counter = makeTool("weather", "Current weather for a city.", "city name", (input: string) => {
    fs.writeFileSync("/tmp/lumen-ai-agent-budget-test.txt", fs.readFileSync("/tmp/lumen-ai-agent-budget-test.txt") + "x");
    return "18C in " + input;
  });
  let tools: LumenAiTool[] = [counter];
  let names: string[] = [];
  let inputs: string[] = [];
  let i: int = 0;
  while (i < 500) { names.push("weather"); inputs.push("Paris"); i = i + 1; }
  let script: string[] = [agFakeCallBody(names, inputs)];
  let run = runAgent(fakeModel(script), tools, agStartHistory(), 2);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 1);
  expect(run.steps.length == 2);
  expect(fs.readFileSync(path) == "xx");
});

test("a final empty answer is not filled from an earlier turn's chatter", () => {
  let sticky: LumenAiModel = (messages: LumenAiMessage[]) => {
    let assistants: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
    }
    if (assistants == 0) {
      return "{\"id\":\"x\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"Let me look that up for you.\",\"tool_calls\":["
        + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}}]}}]}";
    }
    return agentFakeAnswer("");
  };
  let run = runAgent(sticky, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.answer == "");
  let nulled: LumenAiModel = (messages: LumenAiMessage[]) => {
    let assistants: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
    }
    if (assistants == 0) {
      return "{\"id\":\"x\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"secret scratchpad thought\",\"tool_calls\":["
        + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}}]}}]}";
    }
    return "{\"id\":\"y\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":null}}]}";
  };
  let run2 = runAgent(nulled, agSampleTools(), agStartHistory(), 5);
  expect(run2.stopReason == "final");
  expect(run2.answer == "");
});

test("a resumed history does not skip the scripted tool calls", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris"), agentFakeToolCall("clock", "UTC")];
  let resumed: LumenAiMessage[] = [
    systemMessage(agentSystemPrompt(agSampleTools(), "You are a weather assistant.")),
    userMessage("What was the weather yesterday?"),
    assistantMessage("Yesterday Paris was 15C."),
    userMessage("And the weather in Paris now?"),
  ];
  let run = runAgent(fakeModel(script), agSampleTools(), resumed, 5);
  expect(run.steps.length == 2);
  expect(run.steps[0].tool == "weather");
  expect(run.steps[0].input == "Paris");
  expect(run.steps[1].tool == "clock");
  expect(run.steps[1].input == "UTC");
  expect(run.answer == "done");
});

test("the caller's history is left untouched", () => {
  let history = agStartHistory();
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), history, 5);
  expect(run.steps.length == 1);
  expect(history.length == 2);
  expect(history[1].role == "user");
});

test("the live model rebuilds native turns from a neutral tool history", () => {
  let weather = makeTool("weather", "Current weather for a city.", "city name", agWeatherBody);
  let reg: LumenAiTool[] = [weather];
  let allow: string[] = [];
  let deny: string[] = [];
  let history: LumenAiMessage[] = [
    systemMessage("You are a weather assistant."),
    userMessage("What is the weather in Paris?"),
    assistantMessage("[tool_calls] weather({\"input\":\"Paris\"})"),
    toolResultMessage(runToolWithPolicy(reg, allow, deny, "weather", "Paris")),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 4);
  expect(turns[0].role == "system");
  expect(turns[0].tool_calls == "");
  expect(turns[0].tool_call_id == "");
  expect(turns[1].role == "user");
  expect(turns[2].role == "assistant");
  expect(turns[2].tool_calls != "");
  expect(turns[3].role == "tool");
  expect(turns[3].tool_call_id == "call_1");
  expect(turns[3].content == "18C in Paris");
  expect(emitChatMessages(turns).startsWith("["));
  // The rebuilt assistant tool_calls array is valid JSON and its id matches the
  // tool turn that answers it, so the whole request is internally consistent.
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + emitChatTurn(turns[2]) + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].id == "call_1");
  expect(back[0].name == "weather");
  expect(toolCallInput(back[0]) == "Paris");
});

test("the live model ties two tool turns to one assistant turn's ids", () => {
  let weather = makeTool("weather", "Current weather for a city.", "city name", agWeatherBody);
  let clock = makeTool("clock", "The time in a zone.", "zone name", agClockBody);
  let reg: LumenAiTool[] = [weather, clock];
  let allow: string[] = [];
  let deny: string[] = [];
  let history: LumenAiMessage[] = [
    userMessage("weather and time?"),
    assistantMessage("[tool_calls] weather({\"input\":\"Paris\"}), clock({\"input\":\"UTC\"})"),
    toolResultMessage(runToolWithPolicy(reg, allow, deny, "weather", "Paris")),
    toolResultMessage(runToolWithPolicy(reg, allow, deny, "clock", "UTC")),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 4);
  expect(turns[2].tool_call_id == "call_1");
  expect(turns[2].content == "18C in Paris");
  expect(turns[3].tool_call_id == "call_2");
  expect(turns[3].content == "12:00 UTC");
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + emitChatTurn(turns[1]) + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 2);
  expect(back[0].id == "call_1");
  expect(back[0].name == "weather");
  expect(back[1].id == "call_2");
  expect(back[1].name == "clock");
  expect(toolCallInput(back[1]) == "UTC");
});

test("assistant prose before the tool calls is kept and the calls still parse", () => {
  let history: LumenAiMessage[] = [
    userMessage("weather in Paris?"),
    assistantMessage("looking it up\n[tool_calls] weather({\"input\":\"Paris\"})"),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 2);
  let assistantJson = emitChatTurn(turns[1]);
  expect(assistantJson.indexOf("looking it up") > 0);
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + assistantJson + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].id == "call_1");
  expect(toolCallInput(back[0]) == "Paris");
});

test("a failed tool result and a stray tool turn both stay valid", () => {
  let none: LumenAiTool[] = [];
  let allow: string[] = [];
  let deny: string[] = [];
  let history: LumenAiMessage[] = [
    userMessage("do it"),
    toolResultMessage(runToolWithPolicy(none, allow, deny, "wether", "Paris")),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 2);
  expect(turns[1].role == "tool");
  // No preceding assistant tool-call turn, but a tool turn still needs an id for
  // the request to be accepted, so one is synthesized.
  expect(turns[1].tool_call_id == "call_1");
  expect(turns[1].content.startsWith("error: unknown tool \"wether\""));
});

test("a plain chat history lifts through with no tool metadata", () => {
  let history: LumenAiMessage[] = [
    systemMessage("You are concise."),
    userMessage("hi"),
    assistantMessage("Hello. How can I help?"),
    userMessage("what is Lumen?"),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 4);
  let i: int = 0;
  while (i < turns.length) {
    expect(turns[i].tool_calls == "");
    expect(turns[i].tool_call_id == "");
    i = i + 1;
  }
  expect(turns[2].role == "assistant");
  expect(turns[2].content == "Hello. How can I help?");
});

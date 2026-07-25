// The agent loop: a model, a tool registry, and a run bounded by a step limit.

import { makeTool, runToolWithPolicy, toolResultMessage, describeTools } from "./tools.ts";
import { parseToolCalls, toolCallInput, makeToolCall, toolCallArgument } from "./toolcall.ts";
import { assistantMessage, systemMessage, userMessage } from "../core/messages.ts";
import { messageTurn, assistantToolCallsTurn, toolResultTurn, runOpenAIToolChat, runMistralToolChat, emitChatTurn, emitChatMessages } from "./toolchat.ts";

// one dispatched tool call. `index` is the position in the whole run, so two
// calls made in the same model turn still get distinct trace numbers.
type AgentStep = {
  index: int,
  tool: string,
  input: string,
  output: string,
  ok: bool,
};

// `stopReason` is one of "final" (the model answered), "max_steps", or "error"
// (a body with no usable message). `stepCount` counts model calls, not tool
// calls; `steps` holds the tool calls.
type AgentResult = {
  answer: string,
  steps: AgentStep[],
  stopReason: string,
  stepCount: int,
};

// the model is a parameter so a test can drive the loop with canned bodies. the
// string is the raw provider response body, which the tool-call parser reads.
type Model = (messages: Message[]) => string;

// fixture shapes: a response body carrying a plain answer.
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

// a response body carrying tool calls.
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

// the `arguments` payload of a v1 tool call: always one string.
type AgentFakeArgs = {
  input: string,
};

function agNoSteps(): AgentStep[] {
  let empty: AgentStep[] = [];
  return empty;
}

function agResult(answer: string, steps: AgentStep[], stopReason: string, stepCount: int): AgentResult {
  let res: AgentResult = {
    answer: answer,
    steps: steps,
    stopReason: stopReason,
    stepCount: stepCount,
  };
  return res;
}

// reuses toolCallArgument's structural field lookup rather than adding a second
// JSON scanner. an absent key, a null, or a malformed body all come back "".
function agJsonField(json: string, key: string): string {
  return toolCallArgument(makeToolCall("", "", json), key);
}

// the source text of `choices[0]` with the rest of the array still trailing it.
// harmless: every read of the result is a field lookup, which stops at the first
// object's closing brace and can never reach `choices[1]`.
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

// no message object at all is the "error" case (error page, provider error
// record, truncated body). distinct from a message whose content is empty,
// which is a real answer.
function agHasChoiceMessage(raw: string): bool {
  return agChoiceMessage(raw) != "";
}

function agAnswerText(raw: string): string {
  let message = agChoiceMessage(raw);
  if (message == "") { return ""; }
  return agJsonField(message, "content");
}

// the trace is one line per step, so a newline in a tool's name, input, or
// output would forge an extra step line for a call that never happened.
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

// only the rendered trace line is clipped; the full text stays on the step.
function agClip(text: string, limit: int): string {
  if (text.length <= limit) { return text; }
  return text.slice(0, limit) + "...";
}

function agPlural(n: int, word: string): string {
  if (n == 1) { return `${n}` + " " + word; }
  return `${n}` + " " + word + "s";
}

// a failed dispatch has an empty output and its text in `error`, so the trace
// shows the reason rather than a blank.
function agStepOutput(result: ToolResult): string {
  if (result.ok) { return result.output; }
  return "error: " + result.error;
}

// the assistant turn that asked for the tools must precede their results, or a
// provider rejects the request. the content is provider-neutral text that an
// adapter re-serializes into the provider's own `tool_calls` shape; it also
// gives one assistant message per model turn, which is what `fakeModel` counts.
function agCallSummary(text: string, calls: ToolCall[]): string {
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

function agTraceLine(step: AgentStep): string {
  return `${step.index + 1}` + ". " + agFlattenLine(step.tool)
    + "(" + agClip(agFlattenLine(step.input), 80) + ")"
    + " -> " + agClip(agFlattenLine(step.output), 160);
}

// one turn of a canned tool call, as a provider-shaped body.
export function agFakeCallBody(names: string[], inputs: string[]): string {
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

// runAgent and runAgentWithPolicy share this one implementation: two empty lists
// mean "everything permitted", so the unguarded path cannot drift.
//
// a turn is one model call plus every tool call it asked for. `maxSteps` bounds
// turns, so the loop makes at most `maxSteps` model calls and terminates even
// when the model asks for a tool forever.
function agentLoop(model: Model, tools: Tool[], allow: string[], deny: string[], history: Message[], maxSteps: int): AgentResult {
  let steps: AgentStep[] = agNoSteps();
  let convo: Message[] = history.slice(0, history.length);
  let answer = "";
  let turns: int = 0;
  while (turns < maxSteps) {
    let raw = model(convo);
    turns = turns + 1;
    let text = agAnswerText(raw);
    // best answer so far, used only if a later turn fails; the "final" return
    // below deliberately reads the terminating turn's own text instead.
    if (text != "") { answer = text; }
    let calls = parseToolCalls(raw);
    if (calls.length == 0) {
      if (!agHasChoiceMessage(raw)) { return agResult(answer, steps, "error", turns); }
      // this turn's content, even when empty: using `answer` would resurrect an
      // earlier turn's pre-tool scratchpad as the final answer.
      return agResult(text, steps, "final", turns);
    }
    convo = [...convo, assistantMessage(agCallSummary(text, calls))];
    let i: int = 0;
    while (i < calls.length) {
      // `maxSteps` bounds tool dispatches as well as turns: one turn can carry
      // an unbounded `tool_calls` array, so without a per-dispatch check it
      // could run arbitrarily many tool side-effects within the budget.
      if (steps.length >= maxSteps) { return agResult(answer, steps, "max_steps", turns); }
      let result = runToolWithPolicy(tools, allow, deny, calls[i].name, toolCallInput(calls[i]));
      steps = [...steps, makeAgentStep(steps.length, result.name, result.input, agStepOutput(result), result.ok)];
      convo = [...convo, toolResultMessage(result)];
      i = i + 1;
    }
  }
  return agResult(answer, steps, "max_steps", turns);
}

export function makeAgentStep(index: int, tool: string, input: string, output: string, ok: bool): AgentStep {
  let step: AgentStep = {
    index: index,
    tool: tool,
    input: input,
    output: output,
    ok: ok,
  };
  return step;
}

// the system message a run starts from. an empty registry drops the tool section
// and an empty instruction drops its paragraph, so neither leaves a blank line.
export function agentSystemPrompt(tools: Tool[], instruction: string): string {
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

export function runAgent(model: Model, tools: Tool[], history: Message[], maxSteps: int): AgentResult {
  let allow: string[] = [];
  let deny: string[] = [];
  return agentLoop(model, tools, allow, deny, history, maxSteps);
}

// policy is enforced per dispatch inside the loop, not by filtering the registry
// up front, so a denied name comes back as a failed step the model can recover
// from.
export function runAgentWithPolicy(model: Model, tools: Tool[], allow: string[], deny: string[], history: Message[], maxSteps: int): AgentResult {
  return agentLoop(model, tools, allow, deny, history, maxSteps);
}

// the loop keeps history as provider-neutral text (`[tool_calls] name(args)` and
// `[tool name] output`), which a live provider will not accept; a real model
// builder rebuilds native turn records from it inside its own closure, leaving
// runAgent's signature and the loop untouched.
//
// the ids need not match anything the provider returned earlier: each request is
// self-contained, so it only requires that within THIS request every tool turn's
// id matches a preceding assistant tool_call. fresh synthetic ids in reading
// order satisfy that, which is why the lossy neutral summary suffices.

// strips the "[tool name] " prefix toolResultMessage prepends; content without
// that prefix is passed through whole.
function agToolBody(content: string): string {
  if (!content.startsWith("[tool ")) { return content; }
  let close = content.indexOf("] ");
  if (close < 0) { return content; }
  return content.slice(close + 2, content.length);
}

// an already-rendered body is placed on a success-shaped result so toolResultTurn
// emits it verbatim; a body reading "error: ..." survives unchanged.
function agToolTurn(id: string, body: string): ChatTurn {
  let result: ToolResult = {
    name: "",
    input: "",
    output: body,
    ok: true,
    error: "",
  };
  return toolResultTurn(id, result);
}

// parses the `name(args)` list after the `[tool_calls]` marker back into call
// records, ids `call_{base+1}` upward. `args` is read as a paren-balanced run
// that steps over quoted text as a unit, so a `)` or `,` inside the JSON payload
// cannot end an entry early.
function agParseSummaryCalls(seg: string, base: int): ToolCall[] {
  let out: ToolCall[] = [];
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

// rebuilds the native turn history a live round trip needs from the loop's
// neutral-text history. ids run in reading order so an assistant turn's calls
// and the tool turns answering them always agree.
export function agentHistoryToTurns(messages: Message[]): ChatTurn[] {
  let out: ChatTurn[] = [];
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

// a model backed by a live OpenAI-compatible endpoint. the closure rebuilds
// native turn records from the loop's history, POSTs a tool-enabled body, and
// returns the raw response body the loop already knows how to read.
export function openAIAgentModel(apiKey: string, model: string, tools: Tool[]): Model {
  return (messages: Message[]) => {
    return runOpenAIToolChat(apiKey, model, agentHistoryToTurns(messages), tools);
  };
}

// the same against mistral's chat endpoint.
export function mistralAgentModel(apiKey: string, model: string, tools: Tool[]): Model {
  return (messages: Message[]) => {
    return runMistralToolChat(apiKey, model, agentHistoryToTurns(messages), tools);
  };
}

// every tool call in order, then why the run ended. the closing line always
// renders, so a run that called no tool still explains itself.
export function agentTrace(result: AgentResult): string {
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

// a provider-shaped body carrying a plain answer, exported so callers testing
// their own agent do not hand-write provider JSON.
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

// a deterministic driver: hands back `responses` in order, then "done", so a
// test cannot hang on an unscripted turn.
//
// there is no mutable state to hold a turn counter in, so the turn index is read
// off the conversation by counting `[tool_calls]` summaries — the tag the loop
// puts on every tool-call turn it emits. a resumed history's plain assistant
// answers carry no such tag and so are not miscounted.
export function fakeModel(responses: string[]): Model {
  return (messages: Message[]) => {
    let turn: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant" && msg.content.indexOf("[tool_calls]") >= 0) { turn = turn + 1; }
    }
    if (turn >= responses.length) { return agentFakeAnswer("done"); }
    return responses[turn];
  };
}

// test fixture tool bodies.
function agWeatherBody(input: string): string {
  return "18C in " + input;
}

function agClockBody(input: string): string {
  return "12:00 " + input;
}

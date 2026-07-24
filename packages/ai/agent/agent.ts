// The agent loop: a model, a tool registry, and a run bounded by a step limit.

import { makeTool, runToolWithPolicy, toolResultMessage, describeTools } from "./tools.ts";
import { parseToolCalls, toolCallInput, makeToolCall, toolCallArgument } from "./toolcall.ts";
import { assistantMessage, systemMessage, userMessage } from "../core/messages.ts";
import { messageTurn, assistantToolCallsTurn, toolResultTurn, runOpenAIToolChat, runMistralToolChat, emitChatTurn, emitChatMessages } from "./toolchat.ts";

// One dispatched tool call. `index` is the step's own position in the run, so
// the trace can be numbered from it and two calls made in the same model turn
// still get distinct numbers.
type AiAgentStep = {
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
type AiAgentResult = {
  answer: string,
  steps: AiAgentStep[],
  stopReason: string,
  stepCount: int,
};

// The model is a parameter, not a baked-in provider call, so a test can drive
// the loop with canned bodies and production can pass a closure wrapping a real
// provider. The string is the raw provider response body, which is what the
// tool-call parser already reads.
type AiModel = (messages: AiMessage[]) => string;

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

function agNoSteps(): AiAgentStep[] {
  let empty: AiAgentStep[] = [];
  return empty;
}

function agResult(answer: string, steps: AiAgentStep[], stopReason: string, stepCount: int): AiAgentResult {
  let res: AiAgentResult = {
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
function agStepOutput(result: AiToolResult): string {
  if (result.ok) { return result.output; }
  return "error: " + result.error;
}

// The assistant turn that asked for the tools has to go back into the
// conversation ahead of their results: a provider handed tool results with no
// preceding assistant turn rejects the request. The content is provider-neutral
// text, so an adapter re-serializes it into that provider's own `tool_calls`
// shape rather than sending it verbatim. It also gives the loop one assistant
// message per model turn, which is what `fakeModel` counts.
function agCallSummary(text: string, calls: AiToolCall[]): string {
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

function agTraceLine(step: AiAgentStep): string {
  return `${step.index + 1}` + ". " + agFlattenLine(step.tool)
    + "(" + agClip(agFlattenLine(step.input), 80) + ")"
    + " -> " + agClip(agFlattenLine(step.output), 160);
}

// One turn of a canned tool call, as a provider-shaped body.
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
function agentLoop(model: AiModel, tools: AiTool[], allow: string[], deny: string[], history: AiMessage[], maxSteps: int): AiAgentResult {
  let steps: AiAgentStep[] = agNoSteps();
  let convo: AiMessage[] = history.slice(0, history.length);
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

export function makeAgentStep(index: int, tool: string, input: string, output: string, ok: bool): AiAgentStep {
  let step: AiAgentStep = {
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
export function agentSystemPrompt(tools: AiTool[], instruction: string): string {
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

export function runAgent(model: AiModel, tools: AiTool[], history: AiMessage[], maxSteps: int): AiAgentResult {
  let allow: string[] = [];
  let deny: string[] = [];
  return agentLoop(model, tools, allow, deny, history, maxSteps);
}

// Policy is enforced per dispatch inside the loop, not by filtering the
// registry up front, so a denied name that the model asks for anyway comes back
// as a failed step the model can read and recover from.
export function runAgentWithPolicy(model: AiModel, tools: AiTool[], allow: string[], deny: string[], history: AiMessage[], maxSteps: int): AiAgentResult {
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
function agToolTurn(id: string, body: string): AiChatTurn {
  let result: AiToolResult = {
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
function agParseSummaryCalls(seg: string, base: int): AiToolCall[] {
  let out: AiToolCall[] = [];
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
export function agentHistoryToTurns(messages: AiMessage[]): AiChatTurn[] {
  let out: AiChatTurn[] = [];
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
// plain AiModel: given the loop's running history, it rebuilds the native
// turn records, POSTs a tool-enabled chat body (the serialized tool definitions
// ride in the request), and hands back the raw response body — exactly what the
// loop already feeds to parseToolCalls and the answer extractor. runAgent's
// signature is unchanged; the round trip lives entirely inside the closure.
export function openAIAgentModel(apiKey: string, model: string, tools: AiTool[]): AiModel {
  return (messages: AiMessage[]) => {
    return runOpenAIToolChat(apiKey, model, agentHistoryToTurns(messages), tools);
  };
}

// The same live model source against Mistral's chat endpoint.
export function mistralAgentModel(apiKey: string, model: string, tools: AiTool[]): AiModel {
  return (messages: AiMessage[]) => {
    return runMistralToolChat(apiKey, model, agentHistoryToTurns(messages), tools);
  };
}

// What the platform shows someone debugging their agent: every tool call in
// order, then why the run ended. The closing line always renders, so a run that
// called no tool still explains itself.
export function agentTrace(result: AiAgentResult): string {
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
export function fakeModel(responses: string[]): AiModel {
  return (messages: AiMessage[]) => {
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

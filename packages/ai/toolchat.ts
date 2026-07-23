// The live tool-calling adapter: it carries the serialized tool definitions in a
// chat request body and serializes a turn history — including native
// `tool_calls` and `tool_call_id` — into the provider's `messages` array. This
// is the round trip the neutral-text agent loop cannot do on its own: a
// LumenAiMessage carries only role+content, so it provably cannot hold the
// `tool_call_id` an OpenAI follow-up request requires. A superset turn record is
// therefore necessary, not optional.

import { makeTool, runTool } from "./tools.ts";
import { serializeToolDefs, serializeToolDefsMistral, parseToolCalls, toolCallInput, makeToolCall } from "./toolcall.ts";
import { systemMessage, userMessage } from "./messages.ts";
import { bearerJsonHeaders } from "./headers.ts";

// A superset of LumenAiMessage. Absent fields are the empty string, so one
// record shape covers a plain user turn, an assistant turn that asked for tools
// (`tool_calls` holds the native array fragment), and a tool-result turn
// (`tool_call_id` matches an id in the preceding assistant turn). Declared
// without `export`; module inlining exposes it to importers.
type LumenAiChatTurn = {
  role: string,
  content: string,
  tool_call_id: string,
  name: string,
  tool_calls: string,
};

// The scalar half of a chat request body. The `messages` and `tools` arrays are
// emitted by hand — messages omit fields per role, and the tools array comes
// straight from serializeToolDefs — but the scalars go through JSON.stringify so
// a float temperature is formatted the same way the rest of the package formats
// it, with no hand-rolled number-to-string step.
type ChatBodyScalars = {
  model: string,
  temperature: number,
  max_tokens: int,
};

// The `toolCalls` fragment parameter is named `toolCallsFrag`, not `toolCalls`,
// because the barrel (ai.ts) exports a top-level `toolCalls` function and inlines
// this module: a parameter named `toolCalls` would shadow that declaration and
// the native backend rejects the generated code.
function chatTurn(role: string, content: string, toolCallId: string, name: string, toolCallsFrag: string): LumenAiChatTurn {
  let t: LumenAiChatTurn = {
    role: role,
    content: content,
    tool_call_id: toolCallId,
    name: name,
    tool_calls: toolCallsFrag,
  };
  return t;
}

// Rebuild the assistant `tool_calls` array from parsed calls. Each `arguments`
// value is itself a JSON string, so it is re-escaped with JSON.stringify rather
// than concatenated raw — otherwise a payload like {"input":"São Paulo"} would
// break the body. The id and name go through JSON.stringify for the same reason.
function nativeToolCalls(calls: LumenAiToolCall[]): string {
  let out = "[";
  let i: int = 0;
  while (i < calls.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"id\":" + JSON.stringify(calls[i].id)
      + ",\"type\":\"function\",\"function\":{\"name\":" + JSON.stringify(calls[i].name)
      + ",\"arguments\":" + JSON.stringify(calls[i].arguments) + "}}";
    i = i + 1;
  }
  return out + "]";
}

// One emitted message, branching on role and omitting empty fields:
//   tool                    -> role, tool_call_id, content
//   assistant with calls    -> role, content, tool_calls (fragment, not escaped)
//   anything else           -> role, content
// Every string value is escaped with JSON.stringify; the `tool_calls` fragment
// is already valid JSON and is concatenated verbatim.
export function emitChatTurn(turn: LumenAiChatTurn): string {
  if (turn.role == "tool") {
    return "{\"role\":\"tool\",\"tool_call_id\":" + JSON.stringify(turn.tool_call_id)
      + ",\"content\":" + JSON.stringify(turn.content) + "}";
  }
  if (turn.tool_calls != "") {
    return "{\"role\":" + JSON.stringify(turn.role)
      + ",\"content\":" + JSON.stringify(turn.content)
      + ",\"tool_calls\":" + turn.tool_calls + "}";
  }
  return "{\"role\":" + JSON.stringify(turn.role)
    + ",\"content\":" + JSON.stringify(turn.content) + "}";
}

export function emitChatMessages(turns: LumenAiChatTurn[]): string {
  let out = "[";
  let i: int = 0;
  while (i < turns.length) {
    if (i > 0) { out = out + ","; }
    out = out + emitChatTurn(turns[i]);
    i = i + 1;
  }
  return out + "]";
}

// A plain turn lifted from ordinary chat history. Tool metadata is empty, so it
// emits as a bare `{role, content}` message.
export function messageTurn(msg: LumenAiMessage): LumenAiChatTurn {
  return chatTurn(msg.role, msg.content, "", "", "");
}

// The assistant turn that asked for tools. `content` is whatever prose the model
// produced alongside the calls (often empty); `calls` become the native
// `tool_calls` fragment every following tool turn's id must match.
export function assistantToolCallsTurn(content: string, calls: LumenAiToolCall[]): LumenAiChatTurn {
  return chatTurn("assistant", content, "", "", nativeToolCalls(calls));
}

// A tool-result turn. `toolCallId` ties it back to a call in the preceding
// assistant turn — the association OpenAI requires and that plain role="tool"
// text cannot carry. A failed dispatch is reported to the model in the same
// shape as a success, matching toolResultMessage's one-path rule.
export function toolResultTurn(toolCallId: string, result: LumenAiToolResult): LumenAiChatTurn {
  let body = result.output;
  if (!result.ok) { body = "error: " + result.error; }
  return chatTurn("tool", body, toolCallId, result.name, "");
}

// Lift a plain neutral-text history into turn records so it can seed a tool
// round trip. Nothing here carries tool metadata yet; the assistant/tool turns
// are appended by the loop as calls happen.
export function toChatTurns(messages: LumenAiMessage[]): LumenAiChatTurn[] {
  let out: LumenAiChatTurn[] = [];
  let i: int = 0;
  while (i < messages.length) {
    out.push(messageTurn(messages[i]));
    i = i + 1;
  }
  return out;
}

// Concatenate the scalars, the emitted messages array, and — only when the
// registry is non-empty — the serialized tools array. An empty registry omits
// the `tools` field entirely rather than sending `"tools":[]`, which some
// providers reject. Build only concatenates, so it never throws.
function buildToolBody(model: string, turns: LumenAiChatTurn[], frag: string, temperature: number, maxTokens: int): string {
  let scalars: ChatBodyScalars = {
    model: model,
    temperature: temperature,
    max_tokens: maxTokens,
  };
  let head = JSON.stringify(scalars);
  let inner = head.slice(1, head.length - 1);
  let body = "{" + inner + ",\"messages\":" + emitChatMessages(turns);
  if (frag != "[]") { body = body + ",\"tools\":" + frag; }
  return body + "}";
}

export function buildOpenAIToolBody(model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[], temperature: number, maxTokens: int): string {
  return buildToolBody(model, turns, serializeToolDefs(tools), temperature, maxTokens);
}

// Mistral takes the same OpenAI-compatible body, so this only differs in which
// serializer it calls — leaving room for the two to diverge later without
// moving every caller.
export function buildMistralToolBody(model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[], temperature: number, maxTokens: int): string {
  return buildToolBody(model, turns, serializeToolDefsMistral(tools), temperature, maxTokens);
}

// The one function in this module that does I/O. It stays thin — build the body,
// POST it, hand back the raw response body — so the caller parses tool calls or
// the final answer with parseToolCalls/finishReason, and everything else in the
// module is offline-testable.
export function runOpenAIToolChat(apiKey: string, model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[]): string {
  const body = buildOpenAIToolBody(model, turns, tools, 0.7, 1024);
  const res = http.request("https://api.openai.com/v1/chat/completions", "POST", body, bearerJsonHeaders(apiKey));
  return res.body;
}

export function runMistralToolChat(apiKey: string, model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[]): string {
  const body = buildMistralToolBody(model, turns, tools, 0.7, 1024);
  const res = http.request("https://api.mistral.ai/v1/chat/completions", "POST", body, bearerJsonHeaders(apiKey));
  return res.body;
}

// A structural validity check for the tests: brackets and braces balanced,
// strings closed, escapes stepped over. It steps over a quoted run as a unit so
// a brace inside a string cannot unbalance the count — the same guarantee the
// tool-call scanner relies on. It is not a full JSON validator, but combined
// with the exact-shape JSON.parse checks below it proves an emitted body is
// well-formed.
function chatBalanced(src: string): bool {
  let depth: int = 0;
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\"") {
      i = i + 1;
      let closed: bool = false;
      while (i < src.length) {
        let d = src.charAt(i);
        if (d == "\\") { i = i + 2; continue; }
        if (d == "\"") { closed = true; i = i + 1; break; }
        i = i + 1;
      }
      if (!closed) { return false; }
      continue;
    }
    if (c == "{" || c == "[") { depth = depth + 1; }
    else if (c == "}" || c == "]") {
      depth = depth - 1;
      if (depth < 0) { return false; }
    }
    i = i + 1;
  }
  return depth == 0;
}

// Exact-shape types used only to prove — via JSON.parse, which throws on any
// unknown or missing field — that an emitted body/message is genuinely valid
// JSON of the shape the provider expects.
type ChatPlainMsgT = {
  role: string,
  content: string,
};

type ChatPlainBodyT = {
  model: string,
  temperature: number,
  max_tokens: int,
  messages: ChatPlainMsgT[],
};

type ChatCallFnT = {
  name: string,
  arguments: string,
};

type ChatCallEntryT = {
  id: string,
  type: string,
  function: ChatCallFnT,
};

type ChatAssistantMsgT = {
  role: string,
  content: string,
  tool_calls: ChatCallEntryT[],
};

type ChatToolMsgT = {
  role: string,
  tool_call_id: string,
  content: string,
};

function ctSampleTools(): LumenAiTool[] {
  let weather = makeTool("weather", "Look up the weather.", "A city name.", (input: string) => "sunny in " + input);
  let clock = makeTool("clock", "Read the clock.", "A time zone.", (input: string) => "12:00 " + input);
  let tools: LumenAiTool[] = [weather, clock];
  return tools;
}

test("a plain-history body omits the tools array and round-trips as JSON", () => {
  let turns = toChatTurns([systemMessage("You are helpful."), userMessage("Hello")]);
  let none: LumenAiTool[] = [];
  let body = buildOpenAIToolBody("gpt-4o-mini", turns, none, 0.7, 1024);
  expect(body.indexOf("\"tools\":") < 0);
  expect(body.indexOf("\"messages\":[") > 0);
  expect(body.indexOf("\"model\":\"gpt-4o-mini\"") >= 0);
  expect(chatBalanced(body));
  let parsed: ChatPlainBodyT = JSON.parse<ChatPlainBodyT>(body);
  expect(parsed.model == "gpt-4o-mini");
  expect(parsed.max_tokens == 1024);
  expect(parsed.messages.length == 2);
  expect(parsed.messages[0].role == "system");
  expect(parsed.messages[0].content == "You are helpful.");
  expect(parsed.messages[1].role == "user");
  expect(parsed.messages[1].content == "Hello");
});

test("a non-empty registry embeds a valid tools array", () => {
  let turns = toChatTurns([userMessage("weather in Paris?")]);
  let tools = ctSampleTools();
  let body = buildOpenAIToolBody("gpt-4o-mini", turns, tools, 0.2, 256);
  expect(body.indexOf("\"tools\":[{\"type\":\"function\"") > 0);
  expect(body.indexOf("\"name\":\"weather\"") > 0);
  expect(body.indexOf("\"name\":\"clock\"") > 0);
  expect(body.indexOf("\"description\":\"A city name.\"") > 0);
  expect(chatBalanced(body));
  // Mistral takes the identical OpenAI-compatible body today.
  expect(buildMistralToolBody("gpt-4o-mini", turns, tools, 0.2, 256) == body);
});

test("an assistant tool-calls turn and two tool-result turns serialize with matching ids", () => {
  let calls: LumenAiToolCall[] = [
    makeToolCall("call_a", "weather", "{\"input\":\"Paris\"}"),
    makeToolCall("call_b", "clock", "{\"input\":\"UTC\"}"),
  ];
  let reg = ctSampleTools();
  let r1 = runTool(reg, "weather", "Paris");
  let r2 = runTool(reg, "clock", "UTC");
  let convo: LumenAiChatTurn[] = [
    assistantToolCallsTurn("", calls),
    toolResultTurn("call_a", r1),
    toolResultTurn("call_b", r2),
  ];
  let msgs = emitChatMessages(convo);
  expect(chatBalanced(msgs));

  // Each emitted message is genuinely valid JSON of its provider shape.
  let assistantJson = emitChatTurn(convo[0]);
  let parsedA: ChatAssistantMsgT = JSON.parse<ChatAssistantMsgT>(assistantJson);
  expect(parsedA.role == "assistant");
  expect(parsedA.tool_calls.length == 2);
  expect(parsedA.tool_calls[0].id == "call_a");
  expect(parsedA.tool_calls[0].function.name == "weather");
  expect(parsedA.tool_calls[1].id == "call_b");

  let toolJson = emitChatTurn(convo[1]);
  let parsedT: ChatToolMsgT = JSON.parse<ChatToolMsgT>(toolJson);
  expect(parsedT.role == "tool");
  expect(parsedT.tool_call_id == "call_a");
  expect(parsedT.content == "18C in Paris" || parsedT.content == "sunny in Paris");
  let parsedT2: ChatToolMsgT = JSON.parse<ChatToolMsgT>(emitChatTurn(convo[2]));
  expect(parsedT2.tool_call_id == "call_b");
  expect(parsedT2.content == "12:00 UTC");

  // The rebuilt tool_calls fragment is lossless: wrapped back into a response
  // body, parseToolCalls recovers every id, name, and decoded input.
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + assistantJson + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 2);
  expect(back[0].id == "call_a");
  expect(back[0].name == "weather");
  expect(toolCallInput(back[0]) == "Paris");
  expect(back[1].id == "call_b");
  expect(toolCallInput(back[1]) == "UTC");
});

test("content escaping holds for quotes, newlines, and unicode", () => {
  let turns = toChatTurns([userMessage("she said \"go\"\nfrom São Paulo")]);
  let none: LumenAiTool[] = [];
  let body = buildOpenAIToolBody("m", turns, none, 0.7, 1024);
  expect(body.indexOf("\n") < 0);
  expect(body.indexOf("\\n") > 0);
  expect(body.indexOf("\\\"go\\\"") > 0);
  expect(chatBalanced(body));
  let parsed: ChatPlainBodyT = JSON.parse<ChatPlainBodyT>(body);
  expect(parsed.messages[0].content == "she said \"go\"\nfrom São Paulo");
});

test("a tool call argument with quotes and newlines survives the round trip", () => {
  let odd: LumenAiToolCall[] = [
    makeToolCall("call_x", "say", "{\"input\":\"she said \\\"hi\\\"\\nbye\"}"),
  ];
  let turn = assistantToolCallsTurn("thinking", odd);
  let json = emitChatTurn(turn);
  expect(json.indexOf("\n") < 0);
  expect(chatBalanced(json));
  let parsedA: ChatAssistantMsgT = JSON.parse<ChatAssistantMsgT>(json);
  expect(parsedA.content == "thinking");
  expect(parsedA.tool_calls[0].id == "call_x");
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + json + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].name == "say");
  expect(toolCallInput(back[0]) == "she said \"hi\"\nbye");
});

test("a failed tool result serializes as a tool message the model can read", () => {
  let reg = ctSampleTools();
  let miss = runTool(reg, "wether", "Paris");
  let turn = toolResultTurn("call_z", miss);
  let json = emitChatTurn(turn);
  expect(chatBalanced(json));
  let parsed: ChatToolMsgT = JSON.parse<ChatToolMsgT>(json);
  expect(parsed.role == "tool");
  expect(parsed.tool_call_id == "call_z");
  expect(parsed.content.startsWith("error: unknown tool \"wether\""));
});

test("a malformed response is handled by the parse helpers the caller relies on", () => {
  expect(parseToolCalls("<html>502 Bad Gateway</html>").length == 0);
  expect(parseToolCalls("").length == 0);
  expect(parseToolCalls("{not json").length == 0);
  expect(parseToolCalls("{\"choices\":[]}").length == 0);
});

test("lifting history and re-emitting keeps every role and content intact", () => {
  let history: LumenAiMessage[] = [
    systemMessage("You are a weather assistant."),
    userMessage("What is the weather in Paris?"),
  ];
  let turns = toChatTurns(history);
  expect(turns.length == 2);
  expect(turns[0].role == "system");
  expect(turns[1].role == "user");
  expect(turns[0].tool_calls == "");
  expect(turns[0].tool_call_id == "");
  let body = buildOpenAIToolBody("gpt-4o-mini", turns, ctSampleTools(), 0.7, 1024);
  let parsed: ChatPlainBodyT = JSON.parse<ChatPlainBodyT>("{\"model\":\"m\",\"temperature\":0.0,\"max_tokens\":0,\"messages\":" + emitChatMessages(turns) + "}");
  expect(parsed.messages.length == 2);
  expect(parsed.messages[1].content == "What is the weather in Paris?");
  expect(body.indexOf("\"tools\":") > 0);
});

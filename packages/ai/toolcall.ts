// Provider tool-call JSON: tool definitions out, model tool calls back in.

import { makeTool } from "./tools.ts";

type LumenAiToolCall = {
  id: string,
  name: string,
  arguments: string,
};

// The `tools` array an OpenAI-compatible chat request carries. V1 tools take a
// single string, so every tool advertises the same one-property object schema
// and the tool's own `params` text becomes that property's description.
type ToolCallInputProperty = {
  type: string,
  description: string,
};

type ToolCallProperties = {
  input: ToolCallInputProperty,
};

type ToolCallParameters = {
  type: string,
  properties: ToolCallProperties,
  required: string[],
};

type ToolCallFunctionDef = {
  name: string,
  description: string,
  parameters: ToolCallParameters,
};

type ToolCallDefEntry = {
  type: string,
  function: ToolCallFunctionDef,
};

type ToolCallFunctionBody = {
  name: string,
  arguments: string,
};

type ToolCallEntry = {
  id: string,
  type: string,
  function: ToolCallFunctionBody,
};

type ToolCallMessage = {
  role: string,
  content: string,
  tool_calls: ToolCallEntry[],
};

type ToolCallChoice = {
  index: int,
  message: ToolCallMessage,
  finish_reason: string,
};

type ToolCallResponse = {
  id: string,
  choices: ToolCallChoice[],
};

// A decoded JSON string plus the index just past its closing quote. `next` is
// negative when the text at that position is not a well-formed JSON string.
type TcString = {
  value: string,
  next: int,
};

function tcStr(value: string, next: int): TcString {
  return {
    value: value,
    next: next,
  };
}

function tcNoCalls(): LumenAiToolCall[] {
  let empty: LumenAiToolCall[] = [];
  return empty;
}

function tcNoItems(): int[] {
  let empty: int[] = [];
  return empty;
}

function tcIsWhitespace(c: string): bool {
  return c == " " || c == "\n" || c == "\r" || c == "\t";
}

function tcSkipWhitespace(src: string, from: int): int {
  let i: int = from;
  while (i < src.length && tcIsWhitespace(src.charAt(i))) {
    i = i + 1;
  }
  return i;
}

function tcHexDigit(c: string): int {
  let code = c.charCodeAt(0);
  if (code >= "0".charCodeAt(0) && code <= "9".charCodeAt(0)) { return code - "0".charCodeAt(0); }
  if (code >= "a".charCodeAt(0) && code <= "f".charCodeAt(0)) { return code - "a".charCodeAt(0) + 10; }
  if (code >= "A".charCodeAt(0) && code <= "F".charCodeAt(0)) { return code - "A".charCodeAt(0) + 10; }
  return -1;
}

function tcHex4(src: string, at: int): int {
  if (at + 3 >= src.length) { return -1; }
  let value: int = 0;
  let i: int = 0;
  while (i < 4) {
    let digit = tcHexDigit(src.charAt(at + i));
    if (digit < 0) { return -1; }
    value = value * 16 + digit;
    i = i + 1;
  }
  return value;
}

// Strings are byte-indexed, so a `\uXXXX` escape is re-emitted as its UTF-8
// bytes. Without this a tool argument like "São Paulo" would reach the
// tool as the literal text `São Paulo`.
function tcEncodeCodePoint(cp: int): string {
  if (cp < 0x80) { return String.fromCharCode(cp); }
  if (cp < 0x800) {
    return String.fromCharCode(0xC0 | (cp >> 6)) + String.fromCharCode(0x80 | (cp & 0x3F));
  }
  if (cp < 0x10000) {
    return String.fromCharCode(0xE0 | (cp >> 12))
      + String.fromCharCode(0x80 | ((cp >> 6) & 0x3F))
      + String.fromCharCode(0x80 | (cp & 0x3F));
  }
  return String.fromCharCode(0xF0 | (cp >> 18))
    + String.fromCharCode(0x80 | ((cp >> 12) & 0x3F))
    + String.fromCharCode(0x80 | ((cp >> 6) & 0x3F))
    + String.fromCharCode(0x80 | (cp & 0x3F));
}

// Reads the JSON string starting at `at` and returns it decoded. An unpaired
// surrogate is kept as-is rather than dropped, so a half-escaped argument still
// reaches the tool instead of vanishing.
function tcReadString(src: string, at: int): TcString {
  if (at >= src.length || src.charAt(at) != "\"") { return tcStr("", -1); }
  let out = "";
  let i: int = at + 1;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\"") { return tcStr(out, i + 1); }
    if (c != "\\") {
      out = out + c;
      i = i + 1;
      continue;
    }
    if (i + 1 >= src.length) { return tcStr("", -1); }
    let esc = src.charAt(i + 1);
    if (esc == "n") { out = out + "\n"; i = i + 2; continue; }
    if (esc == "r") { out = out + "\r"; i = i + 2; continue; }
    if (esc == "t") { out = out + "\t"; i = i + 2; continue; }
    if (esc == "b") { out = out + String.fromCharCode(8); i = i + 2; continue; }
    if (esc == "f") { out = out + String.fromCharCode(12); i = i + 2; continue; }
    if (esc == "\"" || esc == "\\" || esc == "/") { out = out + esc; i = i + 2; continue; }
    if (esc != "u") { return tcStr("", -1); }
    let cp = tcHex4(src, i + 2);
    if (cp < 0) { return tcStr("", -1); }
    i = i + 6;
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 5 < src.length && src.charAt(i) == "\\" && src.charAt(i + 1) == "u") {
      let low = tcHex4(src, i + 2);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cp = 0x10000 + (cp - 0xD800) * 0x400 + (low - 0xDC00);
        i = i + 6;
      }
    }
    out = out + tcEncodeCodePoint(cp);
  }
  return tcStr("", -1);
}

// Index just past the object or array that starts at `from`. Quoted text is
// stepped over as a unit, so a brace or bracket inside a string — which is
// exactly what a serialized `arguments` payload is full of — cannot close the
// container early.
function tcSkipContainer(src: string, from: int): int {
  let depth: int = 0;
  let i: int = from;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\"") {
      let str = tcReadString(src, i);
      if (str.next < 0) { return -1; }
      i = str.next;
      continue;
    }
    if (c == "{" || c == "[") {
      depth = depth + 1;
    } else if (c == "}" || c == "]") {
      depth = depth - 1;
      if (depth == 0) { return i + 1; }
      if (depth < 0) { return -1; }
    }
    i = i + 1;
  }
  return -1;
}

function tcSkipValue(src: string, from: int): int {
  let i = tcSkipWhitespace(src, from);
  if (i >= src.length) { return -1; }
  let c = src.charAt(i);
  if (c == "\"") { return tcReadString(src, i).next; }
  if (c == "{" || c == "[") { return tcSkipContainer(src, i); }
  let start: int = i;
  while (i < src.length) {
    let d = src.charAt(i);
    if (d == "," || d == "}" || d == "]" || tcIsWhitespace(d)) { break; }
    i = i + 1;
  }
  if (i == start) { return -1; }
  return i;
}

// Index of the value bound to `key` in the object starting at `objectAt`, or -1
// when the object does not carry that key. Keys are matched only at this
// object's own level, so `"name"` inside a nested `arguments` payload is never
// mistaken for the function name.
function tcFieldValue(src: string, objectAt: int, key: string): int {
  let i = tcSkipWhitespace(src, objectAt);
  if (i >= src.length || src.charAt(i) != "{") { return -1; }
  i = tcSkipWhitespace(src, i + 1);
  while (i < src.length) {
    if (src.charAt(i) == "}") { return -1; }
    let name = tcReadString(src, i);
    if (name.next < 0) { return -1; }
    let colon = tcSkipWhitespace(src, name.next);
    if (colon >= src.length || src.charAt(colon) != ":") { return -1; }
    let valueAt = tcSkipWhitespace(src, colon + 1);
    if (name.value == key) { return valueAt; }
    let after = tcSkipValue(src, valueAt);
    if (after < 0) { return -1; }
    let next = tcSkipWhitespace(src, after);
    if (next >= src.length || src.charAt(next) != ",") { return -1; }
    i = tcSkipWhitespace(src, next + 1);
  }
  return -1;
}

// Start index of every element of the array at `arrayAt`. An empty list stands
// for "no array here", "empty array", and "malformed array" alike, which is the
// degrade every caller in this module wants.
function tcArrayItems(src: string, arrayAt: int): int[] {
  let i = tcSkipWhitespace(src, arrayAt);
  if (i >= src.length || src.charAt(i) != "[") { return tcNoItems(); }
  i = tcSkipWhitespace(src, i + 1);
  let out: int[] = [];
  if (i < src.length && src.charAt(i) == "]") { return out; }
  while (i < src.length) {
    out.push(i);
    let after = tcSkipValue(src, i);
    if (after < 0) { return tcNoItems(); }
    let next = tcSkipWhitespace(src, after);
    if (next >= src.length) { return tcNoItems(); }
    if (src.charAt(next) == "]") { return out; }
    if (src.charAt(next) != ",") { return tcNoItems(); }
    i = tcSkipWhitespace(src, next + 1);
  }
  return tcNoItems();
}

function tcStringField(src: string, objectAt: int, key: string): string {
  let at = tcFieldValue(src, objectAt, key);
  if (at < 0) { return ""; }
  return tcReadString(src, at).value;
}

// A string value comes back decoded; any other JSON value comes back as its own
// source text so a caller can re-parse it. `null` comes back empty.
function tcValueText(src: string, at: int): string {
  if (at < 0 || at >= src.length) { return ""; }
  if (src.charAt(at) == "\"") { return tcReadString(src, at).value; }
  let end = tcSkipValue(src, at);
  if (end < 0) { return ""; }
  let text = src.slice(at, end);
  if (text == "null") { return ""; }
  return text;
}

// Index of the first choice's `message` object, or -1.
function tcFirstMessage(raw: string): int {
  let root = tcSkipWhitespace(raw, 0);
  if (root >= raw.length || raw.charAt(root) != "{") { return -1; }
  let choices = tcFieldValue(raw, root, "choices");
  if (choices < 0) { return -1; }
  let items = tcArrayItems(raw, choices);
  if (items.length == 0) { return -1; }
  return tcFieldValue(raw, items[0], "message");
}

function tcMakeCall(id: string, name: string, args: string): LumenAiToolCall {
  return {
    id: id,
    name: name,
    arguments: args,
  };
}

// The typed parse below only accepts a body whose shape is exactly the response
// record, and real provider bodies always carry extra fields, so this scanner —
// not the typed path — is what handles live responses.
function tcScanToolCalls(raw: string): LumenAiToolCall[] {
  let message = tcFirstMessage(raw);
  if (message < 0) { return tcNoCalls(); }
  let calls = tcFieldValue(raw, message, "tool_calls");
  if (calls < 0) { return tcNoCalls(); }
  let items = tcArrayItems(raw, calls);
  let out: LumenAiToolCall[] = [];
  let i: int = 0;
  while (i < items.length) {
    let entry = items[i];
    let id = tcStringField(raw, entry, "id");
    let fn = tcFieldValue(raw, entry, "function");
    if (fn >= 0) {
      let name = tcStringField(raw, fn, "name");
      let args = tcValueText(raw, tcFieldValue(raw, fn, "arguments"));
      if (name != "") { out.push(tcMakeCall(id, name, args)); }
    }
    i = i + 1;
  }
  return out;
}

function tcScanFinishReason(raw: string): string {
  let root = tcSkipWhitespace(raw, 0);
  if (root >= raw.length || raw.charAt(root) != "{") { return ""; }
  let choices = tcFieldValue(raw, root, "choices");
  if (choices < 0) { return ""; }
  let items = tcArrayItems(raw, choices);
  if (items.length == 0) { return ""; }
  return tcStringField(raw, items[0], "finish_reason");
}

function tcToolDefEntry(tool: LumenAiTool): ToolCallDefEntry {
  let hint = tool.params;
  if (hint == "") { hint = "Input for the " + tool.name + " tool."; }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: hint,
          },
        },
        required: ["input"],
      },
    },
  };
}

export function makeToolCall(id: string, name: string, args: string): LumenAiToolCall {
  return tcMakeCall(id, name, args);
}

// JSON.stringify does the escaping, so a tool name or description holding a
// quote, a newline, or a brace cannot break out of the request body.
export function serializeToolDefs(tools: LumenAiTool[]): string {
  let entries: ToolCallDefEntry[] = [];
  let i: int = 0;
  while (i < tools.length) {
    entries.push(tcToolDefEntry(tools[i]));
    i = i + 1;
  }
  return JSON.stringify(entries);
}

// Mistral takes the same OpenAI-compatible `tools` array, so the two
// serializers share one implementation and can diverge later without moving
// every caller.
export function serializeToolDefsMistral(tools: LumenAiTool[]): string {
  return serializeToolDefs(tools);
}

// Tool calls from an OpenAI-compatible chat completion. A body with no tool
// calls, a plain text answer, a malformed body, and an empty body all yield an
// empty list rather than an error.
export function parseToolCalls(raw: string): LumenAiToolCall[] {
  try {
    const parsed: ToolCallResponse = JSON.parse<ToolCallResponse>(raw);
    if (parsed.choices.length == 0) { return tcNoCalls(); }
    let entries = parsed.choices[0].message.tool_calls;
    let out: LumenAiToolCall[] = [];
    let i: int = 0;
    while (i < entries.length) {
      // Drop a nameless call, exactly as the scanner fallback does (tcScanToolCalls
      // guards `if (name != "")`). Without this the typed fast path and the scanner
      // disagree on the same call — one dispatches an unknown-tool "" call and burns
      // the step budget, the other finalizes — decided only by whether the body
      // carried an extra top-level field.
      let name = entries[i].function.name;
      if (name != "") {
        out.push(tcMakeCall(entries[i].id, name, entries[i].function.arguments));
      }
      i = i + 1;
    }
    return out;
  } catch (err) {
    return tcScanToolCalls(raw);
  }
}

export function parseMistralToolCalls(raw: string): LumenAiToolCall[] {
  return parseToolCalls(raw);
}

// One value out of the call's `arguments` payload — the step that turns
// {"input":"Paris"} into `Paris` for dispatch. Absent key, non-object payload,
// and malformed payload all give "".
export function toolCallArgument(call: LumenAiToolCall, key: string): string {
  let at = tcFieldValue(call.arguments, 0, key);
  if (at < 0) { return ""; }
  return tcValueText(call.arguments, at);
}

// V1 tools take a single string under `input`, so this is the argument the
// dispatcher actually wants.
export function toolCallInput(call: LumenAiToolCall): string {
  return toolCallArgument(call, "input");
}

export function hasToolCalls(raw: string): bool {
  return parseToolCalls(raw).length > 0;
}

export function finishReason(raw: string): string {
  try {
    const parsed: ToolCallResponse = JSON.parse<ToolCallResponse>(raw);
    if (parsed.choices.length == 0) { return ""; }
    return parsed.choices[0].finish_reason;
  } catch (err) {
    return tcScanFinishReason(raw);
  }
}

function tcTwoCallResponse(): string {
  return "{\"id\":\"chatcmpl-1\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"gpt-4o-mini\","
    + "\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":["
    + "{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}},"
    + "{\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"clock\",\"arguments\":\"{\\\"input\\\":\\\"UTC\\\"}\"}}"
    + "]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":42,\"total_tokens\":57}}";
}

function tcTextResponse(): string {
  return "{\"id\":\"chatcmpl-2\",\"object\":\"chat.completion\",\"created\":2,\"model\":\"gpt-4o-mini\","
    + "\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Paris is sunny.\"},"
    + "\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":8,\"total_tokens\":12}}";
}

function tcNullToolCallsResponse(): string {
  return "{\"id\":\"cmpl-test\",\"created\":1,\"model\":\"mistral-large-latest\",\"object\":\"chat.completion\","
    + "\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":\"lumen ok\"}}]}";
}

function tcExactShapeResponse(): string {
  return "{\"id\":\"chatcmpl-3\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\","
    + "\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_z\",\"type\":\"function\",\"function\":{\"name\":\"echo\",\"arguments\":\"{\\\"input\\\":\\\"hi\\\"}\"}}]}}]}";
}

function tcSampleTools(): LumenAiTool[] {
  let weather = makeTool("weather", "Look up the weather.", "A city name.", (input: string) => "sunny in " + input);
  let clock = makeTool("clock", "Read the clock.", "", (input: string) => "12:00 " + input);
  let tools: LumenAiTool[] = [weather, clock];
  return tools;
}

test("serialize tool definitions", () => {
  let raw = serializeToolDefs(tcSampleTools());
  expect(raw.startsWith("[{\"type\":\"function\","));
  expect(raw.indexOf("\"name\":\"weather\"") > 0);
  expect(raw.indexOf("\"description\":\"Look up the weather.\"") > 0);
  expect(raw.indexOf("\"parameters\":{\"type\":\"object\",\"properties\":{\"input\":{\"type\":\"string\",\"description\":\"A city name.\"}},\"required\":[\"input\"]}") > 0);
  expect(raw.indexOf("\"name\":\"clock\"") > 0);
  expect(raw.indexOf("\"description\":\"Input for the clock tool.\"") > 0);
  expect(raw.endsWith("}}]"));
});

test("serialize an empty tool list", () => {
  let none: LumenAiTool[] = [];
  expect(serializeToolDefs(none) == "[]");
  expect(serializeToolDefsMistral(none) == "[]");
});

test("mistral tool definitions match the openai-compatible shape", () => {
  let tools = tcSampleTools();
  expect(serializeToolDefsMistral(tools) == serializeToolDefs(tools));
});

test("tool definitions escape quotes and newlines", () => {
  let odd = makeTool("say", "Says \"hi\"\nloudly.", "Text to say, e.g. {\"a\":1}", (input: string) => input);
  let tools: LumenAiTool[] = [odd];
  let raw = serializeToolDefs(tools);
  expect(raw.indexOf("\\\"hi\\\"") > 0);
  expect(raw.indexOf("\\nloudly.") > 0);
  expect(raw.indexOf("\n") < 0);
  let back = parseToolCalls(raw);
  expect(back.length == 0);
});

test("parse two tool calls", () => {
  let calls = parseToolCalls(tcTwoCallResponse());
  expect(calls.length == 2);
  expect(calls[0].id == "call_a");
  expect(calls[0].name == "weather");
  expect(calls[0].arguments == "{\"input\":\"Paris\"}");
  expect(calls[1].id == "call_b");
  expect(calls[1].name == "clock");
  expect(toolCallArgument(calls[0], "input") == "Paris");
  expect(toolCallInput(calls[1]) == "UTC");
});

test("parse a body whose shape is exactly the response record", () => {
  let calls = parseToolCalls(tcExactShapeResponse());
  expect(calls.length == 1);
  expect(calls[0].id == "call_z");
  expect(calls[0].name == "echo");
  expect(toolCallInput(calls[0]) == "hi");
  expect(finishReason(tcExactShapeResponse()) == "tool_calls");
});

test("a text response carries no tool calls", () => {
  expect(parseToolCalls(tcTextResponse()).length == 0);
  expect(hasToolCalls(tcTextResponse()) == false);
  expect(finishReason(tcTextResponse()) == "stop");
  expect(hasToolCalls(tcTwoCallResponse()));
  expect(finishReason(tcTwoCallResponse()) == "tool_calls");
});

test("a null tool_calls field degrades to no calls", () => {
  expect(parseToolCalls(tcNullToolCallsResponse()).length == 0);
  expect(parseMistralToolCalls(tcNullToolCallsResponse()).length == 0);
  expect(hasToolCalls(tcNullToolCallsResponse()) == false);
  expect(finishReason(tcNullToolCallsResponse()) == "stop");
});

test("malformed and empty bodies degrade", () => {
  expect(parseToolCalls("").length == 0);
  expect(parseToolCalls("   ").length == 0);
  expect(parseToolCalls("{not json").length == 0);
  expect(parseToolCalls("{\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"a\",").length == 0);
  expect(parseToolCalls("[]").length == 0);
  expect(parseToolCalls("null").length == 0);
  expect(parseToolCalls("<html>502 Bad Gateway</html>").length == 0);
  expect(hasToolCalls("") == false);
  expect(finishReason("") == "");
  expect(finishReason("{not json") == "");
  expect(finishReason("{\"choices\":[]}") == "");
  expect(parseToolCalls("{\"choices\":[]}").length == 0);
  expect(parseMistralToolCalls("{oops").length == 0);
});

test("an empty tool name is dropped on both parse paths alike", () => {
  // Exact response shape -> JSON.parse succeeds -> typed fast path.
  let exact = "{\"id\":\"chatcmpl-3\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\","
    + "\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_z\",\"type\":\"function\",\"function\":{\"name\":\"\",\"arguments\":\"{\\\"input\\\":\\\"hi\\\"}\"}}]}}]}";
  // Byte-identical apart from one extra top-level field -> JSON.parse fails -> scanner.
  let live = "{\"id\":\"chatcmpl-3\",\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\","
    + "\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_z\",\"type\":\"function\",\"function\":{\"name\":\"\",\"arguments\":\"{\\\"input\\\":\\\"hi\\\"}\"}}]}}]}";
  expect(parseToolCalls(exact).length == 0);
  expect(parseToolCalls(live).length == 0);
  expect(hasToolCalls(exact) == false);
});

test("a tool call missing its function object is skipped", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_a\",\"type\":\"function\"},"
    + "{\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"clock\",\"arguments\":\"{}\"}}]}}]}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 1);
  expect(calls[0].name == "clock");
  expect(calls[0].arguments == "{}");
  expect(toolCallInput(calls[0]) == "");
});

test("arguments keep quotes, newlines, and braces intact", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_q\",\"type\":\"function\",\"function\":{\"name\":\"say\",\"arguments\":"
    + "\"{\\\"input\\\":\\\"she said \\\\\\\"go\\\\\\\"\\\\nthen left\\\"}\"}}]}}]}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 1);
  expect(calls[0].name == "say");
  expect(calls[0].arguments == "{\"input\":\"she said \\\"go\\\"\\nthen left\"}");
  expect(toolCallInput(calls[0]) == "she said \"go\"\nthen left");
});

test("an argument brace cannot end the tool call early", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"first\",\"arguments\":"
    + "\"{\\\"input\\\":\\\"}]},{\\\\\\\"name\\\\\\\":\\\\\\\"forged\\\\\\\"\\\"}\"}},"
    + "{\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"second\",\"arguments\":\"{\\\"input\\\":\\\"ok\\\"}\"}}]}}]}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 2);
  expect(calls[0].name == "first");
  expect(calls[1].name == "second");
  expect(toolCallInput(calls[1]) == "ok");
});

test("malformed arguments degrade to an empty value", () => {
  let bad = makeToolCall("call_a", "weather", "{\"input\":");
  expect(toolCallArgument(bad, "input") == "");
  expect(toolCallInput(bad) == "");
  let truncated = makeToolCall("call_b", "weather", "{\"input\":\"Par");
  expect(toolCallInput(truncated) == "");
  let empty = makeToolCall("call_c", "weather", "");
  expect(toolCallInput(empty) == "");
  let notObject = makeToolCall("call_d", "weather", "\"Paris\"");
  expect(toolCallInput(notObject) == "");
  let listed = makeToolCall("call_e", "weather", "[\"Paris\"]");
  expect(toolCallInput(listed) == "");
  let prose = makeToolCall("call_f", "weather", "I will call the weather tool.");
  expect(toolCallInput(prose) == "");
});

test("argument lookup by key", () => {
  let call = makeToolCall("call_a", "search", "{\"input\":\"lumen\",\"limit\":5,\"deep\":true,\"note\":null,\"opts\":{\"k\":1}}");
  expect(toolCallArgument(call, "input") == "lumen");
  expect(toolCallArgument(call, "limit") == "5");
  expect(toolCallArgument(call, "deep") == "true");
  expect(toolCallArgument(call, "note") == "");
  expect(toolCallArgument(call, "opts") == "{\"k\":1}");
  expect(toolCallArgument(call, "missing") == "");
  expect(toolCallArgument(call, "") == "");
});

test("an argument value cannot forge another argument", () => {
  let call = makeToolCall("call_a", "search", "{\"input\":\"x\\\",\\\"role\\\":\\\"admin\"}");
  expect(toolCallInput(call) == "x\",\"role\":\"admin");
  expect(toolCallArgument(call, "role") == "");
});

test("unicode escapes decode in arguments", () => {
  let call = makeToolCall("call_a", "weather", "{\"input\":\"S\\u00e3o Paulo\"}");
  expect(toolCallInput(call) == "São Paulo");
  let emoji = makeToolCall("call_b", "say", "{\"input\":\"\\ud83d\\ude80 go\"}");
  expect(toolCallInput(emoji) == "🚀 go");
  let tab = makeToolCall("call_c", "say", "{\"input\":\"a\\tb\\/c\"}");
  expect(toolCallInput(tab) == "a\tb/c");
});

test("pretty-printed bodies parse", () => {
  let raw = "{\n  \"id\": \"chatcmpl-4\",\n  \"choices\": [\n    {\n      \"index\": 0,\n"
    + "      \"message\": {\n        \"role\": \"assistant\",\n        \"tool_calls\": [\n"
    + "          { \"id\": \"call_a\", \"type\": \"function\",\n"
    + "            \"function\": { \"name\": \"weather\", \"arguments\": \"{\\\"input\\\": \\\"Paris\\\"}\" } }\n"
    + "        ]\n      },\n      \"finish_reason\": \"tool_calls\"\n    }\n  ]\n}";
  let calls = parseToolCalls(raw);
  expect(calls.length == 1);
  expect(calls[0].id == "call_a");
  expect(calls[0].name == "weather");
  expect(toolCallInput(calls[0]) == "Paris");
  expect(finishReason(raw) == "tool_calls");
  expect(hasToolCalls(raw));
});

test("only the first choice is read", () => {
  let raw = "{\"id\":\"x\",\"model\":\"m\",\"choices\":["
    + "{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"done\"}},"
    + "{\"index\":1,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
    + "{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{}\"}}]}}]}";
  expect(parseToolCalls(raw).length == 0);
  expect(finishReason(raw) == "stop");
});

test("a tool definition round-trips into a parsed call", () => {
  let tools = tcSampleTools();
  let defs = serializeToolDefs(tools);
  expect(defs.indexOf("\"name\":\"weather\"") > 0);
  let call = makeToolCall("call_a", "weather", "{\"input\":\"Paris\"}");
  expect(call.name == tools[0].name);
  expect(tools[0].run(toolCallInput(call)) == "sunny in Paris");
});

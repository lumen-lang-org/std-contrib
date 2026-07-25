// Provider tool-call JSON: tool definitions out, model tool calls back in.

import { makeTool } from "./tools.ts";

type ToolCall = {
  id: string,
  name: string,
  arguments: string,
};

// the `tools` array of an OpenAI-compatible chat request. v1 tools take a single
// string, so every tool advertises the same one-property object schema with the
// tool's `params` text as that property's description.
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

// a decoded JSON string plus the index past its closing quote. `next` is
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

function tcNoCalls(): ToolCall[] {
  let empty: ToolCall[] = [];
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

// strings are byte-indexed, so a `\uXXXX` escape is re-emitted as its utf-8
// bytes; otherwise "São Paulo" reaches the tool as `São Paulo`.
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

// an unpaired surrogate is kept as-is rather than dropped, so a half-escaped
// argument still reaches the tool instead of vanishing.
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

// index just past the object or array starting at `from`. quoted text is stepped
// over as a unit, so a brace inside a string — which a serialized `arguments`
// payload is full of — cannot close the container early.
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

// index of the value bound to `key` in the object at `objectAt`, or -1. keys are
// matched only at this object's own level, so a `"name"` nested inside an
// `arguments` payload is never mistaken for the function name.
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

// start index of every element of the array at `arrayAt`. an empty list covers
// "no array", "empty array", and "malformed array" alike.
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

// a string comes back decoded; any other JSON value comes back as its own source
// text so a caller can re-parse it. `null` comes back empty.
function tcValueText(src: string, at: int): string {
  if (at < 0 || at >= src.length) { return ""; }
  if (src.charAt(at) == "\"") { return tcReadString(src, at).value; }
  let end = tcSkipValue(src, at);
  if (end < 0) { return ""; }
  let text = src.slice(at, end);
  if (text == "null") { return ""; }
  return text;
}

function tcFirstMessage(raw: string): int {
  let root = tcSkipWhitespace(raw, 0);
  if (root >= raw.length || raw.charAt(root) != "{") { return -1; }
  let choices = tcFieldValue(raw, root, "choices");
  if (choices < 0) { return -1; }
  let items = tcArrayItems(raw, choices);
  if (items.length == 0) { return -1; }
  return tcFieldValue(raw, items[0], "message");
}

function tcMakeCall(id: string, name: string, args: string): ToolCall {
  return {
    id: id,
    name: name,
    arguments: args,
  };
}

// JSON.parse<T> throws on any unknown field, and live provider bodies always
// carry extras, so this scanner — not the typed path — handles real responses.
function tcScanToolCalls(raw: string): ToolCall[] {
  let message = tcFirstMessage(raw);
  if (message < 0) { return tcNoCalls(); }
  let calls = tcFieldValue(raw, message, "tool_calls");
  if (calls < 0) { return tcNoCalls(); }
  let items = tcArrayItems(raw, calls);
  let out: ToolCall[] = [];
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

function tcToolDefEntry(entry: Tool): ToolCallDefEntry {
  let hint = entry.params;
  if (hint == "") { hint = "Input for the " + entry.name + " entry."; }
  return {
    type: "function",
    function: {
      name: entry.name,
      description: entry.description,
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

export function makeToolCall(id: string, name: string, args: string): ToolCall {
  return tcMakeCall(id, name, args);
}

// JSON.stringify does the escaping, so a quote or brace in a tool name or
// description cannot break out of the request body.
export function serializeToolDefs(tools: Tool[]): string {
  let entries: ToolCallDefEntry[] = [];
  let i: int = 0;
  while (i < tools.length) {
    entries.push(tcToolDefEntry(tools[i]));
    i = i + 1;
  }
  return JSON.stringify(entries);
}

// mistral takes the same OpenAI-compatible `tools` array; separate entry point
// so the two can diverge later without moving callers.
export function serializeToolDefsMistral(tools: Tool[]): string {
  return serializeToolDefs(tools);
}

// tool calls from an OpenAI-compatible chat completion. no calls, plain text, a
// malformed body, and an empty body all yield an empty list rather than an error.
export function parseToolCalls(raw: string): ToolCall[] {
  try {
    const parsed: ToolCallResponse = JSON.parse<ToolCallResponse>(raw);
    if (parsed.choices.length == 0) { return tcNoCalls(); }
    let entries = parsed.choices[0].message.tool_calls;
    let out: ToolCall[] = [];
    let i: int = 0;
    while (i < entries.length) {
      // drop a nameless call, matching the scanner fallback; otherwise the two
      // paths disagree on the same call purely on whether the body had an extra
      // top-level field.
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

export function parseMistralToolCalls(raw: string): ToolCall[] {
  return parseToolCalls(raw);
}

// one value out of the call's `arguments` payload. absent key, non-object
// payload, and malformed payload all give "".
export function toolCallArgument(call: ToolCall, key: string): string {
  let at = tcFieldValue(call.arguments, 0, key);
  if (at < 0) { return ""; }
  return tcValueText(call.arguments, at);
}

// v1 tools take a single string under `input`.
export function toolCallInput(call: ToolCall): string {
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

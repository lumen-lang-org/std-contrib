// MCP (Model Context Protocol) client over HTTP. MCP is JSON-RPC 2.0: a POST
// carries one request object, the response body carries one result-or-error
// object. Transport here is HTTP only — one request, one complete JSON reply —
// so every call below is a synchronous http.request round trip.

import { makeTool } from "../agent/tools.ts";

type McpTool = {
  name: string,
  description: string,
  schema: string,
};

type McpResult = {
  ok: bool,
  content: string,
  error: string,
};

// A decoded JSON string plus the index just past its closing quote. `next` is
// negative when the text at that position is not a well-formed JSON string.
type McString = {
  value: string,
  next: int,
};

function mcStr(value: string, next: int): McString {
  return {
    value: value,
    next: next,
  };
}

function mcNoTools(): McpTool[] {
  let empty: McpTool[] = [];
  return empty;
}

function mcNoItems(): int[] {
  let empty: int[] = [];
  return empty;
}

// The record with an `ok: bool` + `error: string` pair cannot be returned as a
// literal, so both constructors bind an annotated local first.
function mcpResultOk(content: string): McpResult {
  let r: McpResult = {
    ok: true,
    content: content,
    error: "",
  };
  return r;
}

function mcpResultErr(message: string): McpResult {
  let r: McpResult = {
    ok: false,
    content: "",
    error: message,
  };
  return r;
}

function mcIsWhitespace(c: string): bool {
  return c == " " || c == "\n" || c == "\r" || c == "\t";
}

function mcSkipWhitespace(src: string, from: int): int {
  let i: int = from;
  if (i < 0) { i = 0; }
  while (i < src.length && mcIsWhitespace(src.charAt(i))) {
    i = i + 1;
  }
  return i;
}

function mcHexDigit(c: string): int {
  let code = c.charCodeAt(0);
  if (code >= "0".charCodeAt(0) && code <= "9".charCodeAt(0)) { return code - "0".charCodeAt(0); }
  if (code >= "a".charCodeAt(0) && code <= "f".charCodeAt(0)) { return code - "a".charCodeAt(0) + 10; }
  if (code >= "A".charCodeAt(0) && code <= "F".charCodeAt(0)) { return code - "A".charCodeAt(0) + 10; }
  return -1;
}

function mcHex4(src: string, at: int): int {
  if (at + 3 >= src.length) { return -1; }
  let value: int = 0;
  let i: int = 0;
  while (i < 4) {
    let digit = mcHexDigit(src.charAt(at + i));
    if (digit < 0) { return -1; }
    value = value * 16 + digit;
    i = i + 1;
  }
  return value;
}

// A `\uXXXX` escape is re-emitted as its UTF-8 bytes, so a tool description or
// text part carrying "São Paulo" reaches the caller as the accented text, not
// the literal escape.
function mcEncodeCodePoint(cp: int): string {
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

// Reads the JSON string starting at `at` and returns it decoded. A lone
// surrogate is kept as-is rather than dropped, so a half-escaped value still
// reaches the caller instead of vanishing.
function mcReadString(src: string, at: int): McString {
  if (at < 0 || at >= src.length || src.charAt(at) != "\"") { return mcStr("", -1); }
  let out = "";
  let i: int = at + 1;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\"") { return mcStr(out, i + 1); }
    if (c != "\\") {
      out = out + c;
      i = i + 1;
      continue;
    }
    if (i + 1 >= src.length) { return mcStr("", -1); }
    let esc = src.charAt(i + 1);
    if (esc == "n") { out = out + "\n"; i = i + 2; continue; }
    if (esc == "r") { out = out + "\r"; i = i + 2; continue; }
    if (esc == "t") { out = out + "\t"; i = i + 2; continue; }
    if (esc == "b") { out = out + String.fromCharCode(8); i = i + 2; continue; }
    if (esc == "f") { out = out + String.fromCharCode(12); i = i + 2; continue; }
    if (esc == "\"" || esc == "\\" || esc == "/") { out = out + esc; i = i + 2; continue; }
    if (esc != "u") { return mcStr("", -1); }
    let cp = mcHex4(src, i + 2);
    if (cp < 0) { return mcStr("", -1); }
    i = i + 6;
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 5 < src.length && src.charAt(i) == "\\" && src.charAt(i + 1) == "u") {
      let low = mcHex4(src, i + 2);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cp = 0x10000 + (cp - 0xD800) * 0x400 + (low - 0xDC00);
        i = i + 6;
      }
    }
    out = out + mcEncodeCodePoint(cp);
  }
  return mcStr("", -1);
}

// Index just past the object or array that starts at `from`. Quoted text is
// stepped over as a unit, so a brace or bracket inside a string — which a
// serialized inputSchema or a tool's text output is full of — cannot close the
// container early.
function mcSkipContainer(src: string, from: int): int {
  let depth: int = 0;
  let i: int = from;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\"") {
      let str = mcReadString(src, i);
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

function mcSkipValue(src: string, from: int): int {
  let i = mcSkipWhitespace(src, from);
  if (i >= src.length) { return -1; }
  let c = src.charAt(i);
  if (c == "\"") { return mcReadString(src, i).next; }
  if (c == "{" || c == "[") { return mcSkipContainer(src, i); }
  let start: int = i;
  while (i < src.length) {
    let d = src.charAt(i);
    if (d == "," || d == "}" || d == "]" || mcIsWhitespace(d)) { break; }
    i = i + 1;
  }
  if (i == start) { return -1; }
  return i;
}

// Index of the value bound to `key` in the object at `objectAt`, or -1 when the
// object does not carry that key. Keys are matched only at this object's own
// level, so a nested `"name"` inside an inputSchema is never mistaken for the
// tool name.
export function mcFieldValue(src: string, objectAt: int, key: string): int {
  if (objectAt < 0) { return -1; }
  let i = mcSkipWhitespace(src, objectAt);
  if (i >= src.length || src.charAt(i) != "{") { return -1; }
  i = mcSkipWhitespace(src, i + 1);
  while (i < src.length) {
    if (src.charAt(i) == "}") { return -1; }
    let name = mcReadString(src, i);
    if (name.next < 0) { return -1; }
    let colon = mcSkipWhitespace(src, name.next);
    if (colon >= src.length || src.charAt(colon) != ":") { return -1; }
    let valueAt = mcSkipWhitespace(src, colon + 1);
    if (name.value == key) { return valueAt; }
    let after = mcSkipValue(src, valueAt);
    if (after < 0) { return -1; }
    let next = mcSkipWhitespace(src, after);
    if (next >= src.length || src.charAt(next) != ",") { return -1; }
    i = mcSkipWhitespace(src, next + 1);
  }
  return -1;
}

// Start index of every element of the array at `arrayAt`. An empty list stands
// for "no array here", "empty array", and "malformed array" alike — the degrade
// every parser below wants.
function mcArrayItems(src: string, arrayAt: int): int[] {
  if (arrayAt < 0) { return mcNoItems(); }
  let i = mcSkipWhitespace(src, arrayAt);
  if (i >= src.length || src.charAt(i) != "[") { return mcNoItems(); }
  i = mcSkipWhitespace(src, i + 1);
  let out: int[] = [];
  if (i < src.length && src.charAt(i) == "]") { return out; }
  while (i < src.length) {
    out.push(i);
    let after = mcSkipValue(src, i);
    if (after < 0) { return mcNoItems(); }
    let next = mcSkipWhitespace(src, after);
    if (next >= src.length) { return mcNoItems(); }
    if (src.charAt(next) == "]") { return out; }
    if (src.charAt(next) != ",") { return mcNoItems(); }
    i = mcSkipWhitespace(src, next + 1);
  }
  return mcNoItems();
}

export function mcStringField(src: string, objectAt: int, key: string): string {
  let at = mcFieldValue(src, objectAt, key);
  if (at < 0) { return ""; }
  return mcReadString(src, at).value;
}

// A string value comes back decoded; any other JSON value comes back as its own
// source text so a caller can re-parse it. `null` comes back empty.
export function mcValueText(src: string, at: int): string {
  if (at < 0 || at >= src.length) { return ""; }
  if (src.charAt(at) == "\"") { return mcReadString(src, at).value; }
  let end = mcSkipValue(src, at);
  if (end < 0) { return ""; }
  let text = src.slice(at, end);
  if (text == "null") { return ""; }
  return text;
}

// Top-level integer field, e.g. the response `id`. A leading minus is honored so
// a negative id round-trips; a missing or non-numeric field reads as 0.
export function mcIntField(src: string, objectAt: int, key: string): int {
  let at = mcFieldValue(src, objectAt, key);
  if (at < 0) { return 0; }
  let i = at;
  let neg: bool = false;
  if (i < src.length && src.charAt(i) == "-") { neg = true; i = i + 1; }
  let out: int = 0;
  while (i < src.length) {
    let code = src.charAt(i).charCodeAt(0);
    if (code >= "0".charCodeAt(0) && code <= "9".charCodeAt(0)) {
      out = out * 10 + (code - "0".charCodeAt(0));
      i = i + 1;
    } else {
      break;
    }
  }
  if (neg) { return -out; }
  return out;
}

// --- JSON-RPC framing -------------------------------------------------------

// A JSON-RPC 2.0 request. `params` is a raw JSON object string embedded
// verbatim (e.g. "{}"); the method goes through JSON.stringify so a method name
// holding a quote cannot break the body.
export function mcpRequest(id: int, method: string, params: string): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":" + `${id}`
    + ",\"method\":" + JSON.stringify(method)
    + ",\"params\":" + params + "}";
}

// The source text of the top-level `result` object, or "" when the body carries
// no result (an error reply, a malformed body).
export function mcpResultField(raw: string): string {
  let at = mcFieldValue(raw, 0, "result");
  if (at < 0) { return ""; }
  return mcValueText(raw, at);
}

// The human-readable error detail, or "" when there is none. Handles both the
// spec's object form (`"error":{"message":"..."}`) and the string form some
// servers emit (`"error":"database offline"`).
export function mcpErrorMessage(raw: string): string {
  let at = mcFieldValue(raw, 0, "error");
  if (at < 0) { return ""; }
  // String-form error: the value itself is the message.
  if (raw.charAt(at) == "\"") { return mcValueText(raw, at); }
  // Object-form error: read its `message` field.
  return mcStringField(raw, at, "message");
}

export function mcpIsError(raw: string): bool {
  let at = mcFieldValue(raw, 0, "error");
  if (at < 0) { return false; }
  let text = mcValueText(raw, at);
  // A present-but-falsy `error` (null/false/0) is a success signal some servers
  // send alongside `result`; only a truthy error value is a real error.
  return text != "" && text != "null" && text != "false" && text != "0";
}

export function mcpResponseId(raw: string): int {
  return mcIntField(raw, 0, "id");
}

// --- Request builders -------------------------------------------------------

export function mcpInitializeRequest(): string {
  let params = "{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},"
    + "\"clientInfo\":{\"name\":\"lumen-ai\",\"version\":\"0.1.0\"}}";
  return mcpRequest(1, "initialize", params);
}

export function mcpListToolsRequest(id: int): string {
  return mcpRequest(id, "tools/list", "{}");
}

// `argumentsJson` is a raw JSON value embedded verbatim under "arguments"; the
// tool name is escaped so a name holding a quote or newline cannot break out.
// An empty/blank `argumentsJson` would produce invalid JSON-RPC, so it defaults
// to an empty object — the caller is still responsible for passing valid JSON.
export function mcpCallToolRequest(id: int, name: string, argumentsJson: string): string {
  let args = argumentsJson;
  if (args.trim() == "") { args = "{}"; }
  let params = "{\"name\":" + JSON.stringify(name)
    + ",\"arguments\":" + args + "}";
  return mcpRequest(id, "tools/call", params);
}

// --- Response parsers -------------------------------------------------------

// Every tool under result.tools[], each carrying its name, description, and the
// raw inputSchema JSON. A real body carries far more fields than a typed parse
// would accept, so this walks the string; any malformed or error body degrades
// to an empty list.
export function parseMcpTools(raw: string): McpTool[] {
  let resultAt = mcFieldValue(raw, 0, "result");
  if (resultAt < 0) { return mcNoTools(); }
  let toolsAt = mcFieldValue(raw, resultAt, "tools");
  let items = mcArrayItems(raw, toolsAt);
  let out: McpTool[] = [];
  let i: int = 0;
  while (i < items.length) {
    let entry = items[i];
    let name = mcStringField(raw, entry, "name");
    if (name != "") {
      let description = mcStringField(raw, entry, "description");
      let schema = mcValueText(raw, mcFieldValue(raw, entry, "inputSchema"));
      let tool: McpTool = {
        name: name,
        description: description,
        schema: schema,
      };
      out.push(tool);
    }
    i = i + 1;
  }
  return out;
}

// The text of a tools/call reply: every text part in result.content[] joined
// into one string. A JSON-RPC error body comes back ok:false with the error
// message. Never throws — a garbage body yields ok:true with empty content.
export function parseMcpToolResult(raw: string): McpResult {
  if (mcpIsError(raw)) {
    return mcpResultErr(mcpErrorMessage(raw));
  }
  let text = "";
  let resultAt = mcFieldValue(raw, 0, "result");
  if (resultAt >= 0) {
    let contentAt = mcFieldValue(raw, resultAt, "content");
    let items = mcArrayItems(raw, contentAt);
    let i: int = 0;
    while (i < items.length) {
      text = text + mcStringField(raw, items[i], "text");
      i = i + 1;
    }
  }
  return mcpResultOk(text);
}

// --- HTTP-backed calls (thin, untested — the only I/O here) -----------------

// Content-Type is forced on; any auth headers the caller supplied ride along.
function mcpHeaders(headers: Map<string, string>): Map<string, string> {
  headers.set("Content-Type", "application/json");
  return headers;
}

export function mcpInitialize(url: string, headers: Map<string, string>): string {
  const res = http.request(url, "POST", mcpInitializeRequest(), mcpHeaders(headers));
  return res.body;
}

export function mcpListTools(url: string, headers: Map<string, string>): McpTool[] {
  const res = http.request(url, "POST", mcpListToolsRequest(1), mcpHeaders(headers));
  return parseMcpTools(res.body);
}

export function mcpCallTool(url: string, headers: Map<string, string>, name: string, argumentsJson: string): McpResult {
  const res = http.request(url, "POST", mcpCallToolRequest(1, name, argumentsJson), mcpHeaders(headers));
  return parseMcpToolResult(res.body);
}

// --- Adapter into a first-class AiTool ---------------------------------

// A McpTool becomes an AiTool whose run POSTs a tools/call request.
// run wraps its single string input as {"input": <input>} — this package's
// one-string-arg tool convention — and never throws: http.request does not
// throw and parseMcpToolResult does not throw, so trouble comes back as text.
export function mcpToolToLumen(url: string, headers: Map<string, string>, tool: McpTool): AiTool {
  let toolName = tool.name;
  return makeTool(tool.name, tool.description, tool.schema, (input: string) => {
    let args = "{\"input\":" + JSON.stringify(input) + "}";
    let result = mcpCallTool(url, headers, toolName, args);
    if (result.ok) { return result.content; }
    return "error: " + result.error;
  });
}

export function mcpToolsToRegistry(url: string, headers: Map<string, string>, tools: McpTool[]): AiTool[] {
  let out: AiTool[] = [];
  let i: int = 0;
  while (i < tools.length) {
    out.push(mcpToolToLumen(url, headers, tools[i]));
    i = i + 1;
  }
  return out;
}

// --- Tests (offline, hand-written JSON-RPC literals only) -------------------

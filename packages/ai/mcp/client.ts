// MCP (Model Context Protocol) client over HTTP. MCP is JSON-RPC 2.0: one POST
// carries one request object, the reply body carries one result-or-error object.
// Every call here is a synchronous http.request round trip.

import { makeTool, mergeToolsKeepingLocal } from "../agent/tools.ts";

export type McpTool = {
  name: string,
  description: string,
  schema: string,
};

export type McpResult = {
  ok: bool,
  content: string,
  error: string,
};

// a decoded JSON string plus the index just past its closing quote; `next` is
// negative when the text there is not a well-formed JSON string.
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

function mcNoStrings(): string[] {
  let empty: string[] = [];
  return empty;
}

// a record literal with an `ok: bool` + `error: string` pair cannot be returned
// directly, so both constructors bind an annotated local first.
function mcpResultOk(content: string): McpResult {
  let r: McpResult = {
    ok: true,
    content: content,
    error: "",
  };
  return r;
}

// a failure always carries a sentence: the empty message is what turns a tool
// step into the output "error: " with nothing after it.
function mcpResultErr(message: string): McpResult {
  let text = message.trim();
  if (text == "") { text = "the MCP server reported a failure with no message"; }
  let r: McpResult = {
    ok: false,
    content: "",
    error: text,
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

// re-emit a code point as its UTF-8 bytes, so a `\uXXXX` escape in a
// description or text part decodes to the accented text.
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

// decode the JSON string starting at `at`. a lone surrogate is kept as-is
// rather than dropped, so a half-escaped value still reaches the caller.
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

// index just past the object or array starting at `from`. quoted text is
// stepped over as a unit, so a brace or bracket inside a string cannot close
// the container early.
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

// index of the value bound to `key` in the object at `objectAt`, else -1. keys
// match only at this object's own level, so a nested `"name"` inside an
// inputSchema is never mistaken for the tool name.
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

// start index of every element of the array at `arrayAt`. an empty list stands
// for "no array here", "empty array", and "malformed array" alike.
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

// a string value comes back decoded; any other JSON value comes back as its own
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

// integer field, e.g. the response `id`. a leading minus is honored so a
// negative id round-trips; a missing or non-numeric field reads as 0.
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

// decimal text to an int; anything else reads as 0. the digits must run to the
// end, so "7" parses and "7abc" does not.
function mcParseInt(text: string): int {
  let body = text.trim();
  if (body.length == 0) { return 0; }
  let i: int = 0;
  let neg: bool = false;
  if (body.charAt(0) == "-") { neg = true; i = 1; }
  if (i >= body.length) { return 0; }
  let out: int = 0;
  while (i < body.length) {
    let code = body.charAt(i).charCodeAt(0);
    if (code < "0".charCodeAt(0) || code > "9".charCodeAt(0)) { return 0; }
    out = out * 10 + (code - "0".charCodeAt(0));
    i = i + 1;
  }
  if (neg) { return -out; }
  return out;
}

function mcIsNumberText(text: string): bool {
  let body = text.trim();
  if (body.length == 0) { return false; }
  let i: int = 0;
  if (body.charAt(0) == "-") { i = 1; }
  let digits: int = 0;
  let dots: int = 0;
  while (i < body.length) {
    let c = body.charAt(i);
    if (c == ".") {
      dots = dots + 1;
      if (dots > 1) { return false; }
    } else {
      let code = c.charCodeAt(0);
      if (code < "0".charCodeAt(0) || code > "9".charCodeAt(0)) { return false; }
      digits = digits + 1;
    }
    i = i + 1;
  }
  return digits > 0;
}

// boolean field. absent, null, or any non-`true` value reads as false, so
// `"isError":true` is the only spelling that turns a result into a failure.
export function mcBoolField(src: string, objectAt: int, key: string): bool {
  let at = mcFieldValue(src, objectAt, key);
  if (at < 0) { return false; }
  return mcValueText(src, at) == "true";
}

// the keys of the object at `objectAt`, in source order. a malformed object
// yields an empty list, same as an object with no keys.
export function mcObjectKeys(src: string, objectAt: int): string[] {
  if (objectAt < 0) { return mcNoStrings(); }
  let i = mcSkipWhitespace(src, objectAt);
  if (i >= src.length || src.charAt(i) != "{") { return mcNoStrings(); }
  i = mcSkipWhitespace(src, i + 1);
  let out: string[] = [];
  if (i < src.length && src.charAt(i) == "}") { return out; }
  while (i < src.length) {
    let name = mcReadString(src, i);
    if (name.next < 0) { return mcNoStrings(); }
    let colon = mcSkipWhitespace(src, name.next);
    if (colon >= src.length || src.charAt(colon) != ":") { return mcNoStrings(); }
    let valueAt = mcSkipWhitespace(src, colon + 1);
    out.push(name.value);
    let after = mcSkipValue(src, valueAt);
    if (after < 0) { return mcNoStrings(); }
    let next = mcSkipWhitespace(src, after);
    if (next >= src.length) { return mcNoStrings(); }
    if (src.charAt(next) == "}") { return out; }
    if (src.charAt(next) != ",") { return mcNoStrings(); }
    i = mcSkipWhitespace(src, next + 1);
  }
  return mcNoStrings();
}

function mcHasString(list: string[], value: string): bool {
  for (const item of list) {
    if (item == value) { return true; }
  }
  return false;
}

// one flattened line of a body, for an error a person has to read. an HTML
// error page and a JSON-RPC frame both survive this legibly.
function mcPreview(raw: string): string {
  let text = raw.trim();
  let out = "";
  let i: int = 0;
  while (i < text.length && i < 160) {
    let c = text.charAt(i);
    if (c == "\n" || c == "\r" || c == "\t") { out = out + " "; } else { out = out + c; }
    i = i + 1;
  }
  if (text.length > 160) { out = out + "..."; }
  return out;
}

// --- JSON-RPC framing -------------------------------------------------------

// `params` is a raw JSON object string embedded verbatim (e.g. "{}"); the
// method is escaped so a name holding a quote cannot break the body.
export function mcpRequest(id: int, method: string, params: string): string {
  return "{\"jsonrpc\":\"2.0\",\"id\":" + `${id}`
    + ",\"method\":" + JSON.stringify(method)
    + ",\"params\":" + params + "}";
}

// source text of the top-level `result`, or "" when the body carries none.
export function mcpResultField(raw: string): string {
  let at = mcFieldValue(raw, 0, "result");
  if (at < 0) { return ""; }
  return mcValueText(raw, at);
}

// the standard JSON-RPC codes, so an error object carrying only a code still
// reads as a sentence rather than as a number.
function mcpErrorCodeName(code: int): string {
  if (code == -32700) { return "parse error"; }
  if (code == -32600) { return "invalid request"; }
  if (code == -32601) { return "method not found"; }
  if (code == -32602) { return "invalid arguments"; }
  if (code == -32603) { return "internal error"; }
  return "";
}

// handles both the spec's object form (`"error":{"message":"..."}`) and the
// string form some servers emit (`"error":"database offline"`). an error object
// with no `message` falls back to its `code`: a bare `{"code":-32602}` has to
// reach the model as something other than the empty string, or an expired token
// and a refused argument both read as "the tool returned nothing".
export function mcpErrorMessage(raw: string): string {
  let at = mcFieldValue(raw, 0, "error");
  if (at < 0) { return ""; }
  if (raw.charAt(at) == "\"") { return mcValueText(raw, at); }
  let message = mcStringField(raw, at, "message");
  if (message != "") { return message; }
  if (mcFieldValue(raw, at, "code") >= 0) {
    let code = mcIntField(raw, at, "code");
    let named = mcpErrorCodeName(code);
    if (named != "") { return "JSON-RPC error " + `${code}` + " (" + named + ")"; }
    return "JSON-RPC error " + `${code}`;
  }
  let text = mcValueText(raw, at);
  if (text != "" && text != "null" && text != "false" && text != "0") {
    return "MCP error: " + text;
  }
  return "";
}

export function mcpIsError(raw: string): bool {
  let at = mcFieldValue(raw, 0, "error");
  if (at < 0) { return false; }
  let text = mcValueText(raw, at);
  // a present-but-falsy `error` (null/false/0) rides alongside `result` on some
  // servers; only a truthy error value is a real error.
  return text != "" && text != "null" && text != "false" && text != "0";
}

// the reply's `id` as text. JSON-RPC 2.0 allows a string id and several MCP
// servers send one, so `"id":"7"` and `"id":7` both have to read as `7` here;
// a decimal scan of the raw source stops at the opening quote and reads 0,
// which makes every reply from such a server look like somebody else's.
export function mcpResponseIdText(raw: string): string {
  let at = mcFieldValue(raw, 0, "id");
  if (at < 0) { return ""; }
  return mcValueText(raw, at).trim();
}

export function mcpResponseId(raw: string): int {
  return mcParseInt(mcpResponseIdText(raw));
}

// whether this reply answers the request that carried `expected`. a missing id
// (a notification) and a non-numeric string id (a server-initiated request)
// both fail to match rather than matching id 0.
export function mcpIdMatches(raw: string, expected: int): bool {
  let text = mcpResponseIdText(raw);
  if (text == "") { return false; }
  return text == `${expected}`;
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

// `argumentsJson` is embedded verbatim under "arguments" (the caller owns its
// validity); the tool name is escaped. blank defaults to "{}" because an empty
// value would produce invalid JSON-RPC.
export function mcpCallToolRequest(id: int, name: string, argumentsJson: string): string {
  let args = argumentsJson;
  if (args.trim() == "") { args = "{}"; }
  let params = "{\"name\":" + JSON.stringify(name)
    + ",\"arguments\":" + args + "}";
  return mcpRequest(id, "tools/call", params);
}

// --- Arguments from the server's own inputSchema ----------------------------

// whether `text` is one complete JSON object with nothing after it.
function mcIsJsonObject(text: string): bool {
  if (text.length == 0 || text.charAt(0) != "{") { return false; }
  let end = mcSkipContainer(text, 0);
  if (end < 0) { return false; }
  return mcSkipWhitespace(text, end) == text.length;
}

// whether `text` is one complete JSON value with nothing after it.
function mcIsJsonValue(text: string): bool {
  if (text.length == 0) { return false; }
  let end = mcSkipValue(text, 0);
  if (end < 0) { return false; }
  return mcSkipWhitespace(text, end) == text.length;
}

// the declared type of one property, e.g. "string" / "number"; "" when the
// schema does not say.
function mcSchemaPropType(schema: string, name: string): string {
  let propsAt = mcFieldValue(schema, 0, "properties");
  if (propsAt < 0) { return ""; }
  let at = mcFieldValue(schema, propsAt, name);
  if (at < 0) { return ""; }
  return mcStringField(schema, at, "type");
}

// the schema's parameter names, required ones first and then the rest, so a
// single input string fills what the server insists on before what it merely
// accepts.
export function mcpSchemaFields(schema: string): string[] {
  let out: string[] = [];
  let requiredItems = mcArrayItems(schema, mcFieldValue(schema, 0, "required"));
  let i: int = 0;
  while (i < requiredItems.length) {
    let name = mcReadString(schema, requiredItems[i]);
    if (name.next >= 0 && name.value != "" && !mcHasString(out, name.value)) {
      out.push(name.value);
    }
    i = i + 1;
  }
  let keys = mcObjectKeys(schema, mcFieldValue(schema, 0, "properties"));
  let k: int = 0;
  while (k < keys.length) {
    if (!mcHasString(out, keys[k])) { out.push(keys[k]); }
    k = k + 1;
  }
  return out;
}

// one argument value, JSON-encoded the way the schema declares it: a field
// typed number/integer/boolean is emitted unquoted, because a server validates
// `arguments` against its own inputSchema and rejects `{"a":"2"}` for a number.
function mcArgValue(schema: string, name: string, raw: string): string {
  let declared = mcSchemaPropType(schema, name);
  let text = raw.trim();
  if ((declared == "number" || declared == "integer") && mcIsNumberText(text)) { return text; }
  if (declared == "boolean" && (text == "true" || text == "false")) { return text; }
  if ((declared == "array" || declared == "object") && mcIsJsonValue(text)) { return text; }
  return JSON.stringify(raw);
}

// a comma-separated input split and trimmed, so "2, 3" can fill add(a, b).
function mcSplitArgs(input: string): string[] {
  let parts = input.split(",");
  let out: string[] = [];
  let i: int = 0;
  while (i < parts.length) {
    out.push(parts[i].trim());
    i = i + 1;
  }
  return out;
}

// Build the `arguments` object of a tools/call from the server's own
// inputSchema and the one string a Lumen tool body is handed.
//
// Hardcoding `{"input": <string>}` here is what makes every call to a real
// server fail with -32602: the server validates `arguments` against the
// inputSchema it advertised, and no schema in the wild declares a property
// called `input`. So:
//
//   - an input that is already a complete JSON object is passed through
//     untouched, which is how a model calls a multi-parameter tool;
//   - one parameter takes the whole string;
//   - several parameters split the string on commas when the counts line up,
//     which is how "2, 3" reaches add(a, b);
//   - a schema declaring no properties at all keeps the old
//     `{"input": <string>}` shape for a non-empty input, and "{}" for none.
export function mcpBuildArguments(schema: string, input: string): string {
  let text = input.trim();
  if (mcIsJsonObject(text)) { return text; }
  let fields = mcpSchemaFields(schema);
  if (fields.length == 0) {
    if (text == "") { return "{}"; }
    return "{\"input\":" + JSON.stringify(input) + "}";
  }
  if (fields.length == 1) {
    return "{" + JSON.stringify(fields[0]) + ":" + mcArgValue(schema, fields[0], input) + "}";
  }
  let parts = mcSplitArgs(input);
  if (parts.length != fields.length) {
    return "{" + JSON.stringify(fields[0]) + ":" + mcArgValue(schema, fields[0], input) + "}";
  }
  let out = "{";
  let i: int = 0;
  while (i < fields.length) {
    if (i > 0) { out = out + ","; }
    out = out + JSON.stringify(fields[i]) + ":" + mcArgValue(schema, fields[i], parts[i]);
    i = i + 1;
  }
  return out + "}";
}

// --- Response parsers -------------------------------------------------------

// every tool under result.tools[] with its raw inputSchema JSON. a real body
// carries more fields than JSON.parse<T> accepts (it throws on unknown fields),
// so this walks the string; a malformed or error body degrades to an empty list.
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

// one content part rendered as text. MCP parts are typed: text, image, audio,
// and embedded resource. Reading only `text` drops the other three without a
// trace, so the model is told an image came back rather than being handed the
// empty string.
function mcpContentPart(raw: string, at: int): string {
  let kind = mcStringField(raw, at, "type");
  if (kind == "" || kind == "text") { return mcStringField(raw, at, "text"); }
  if (kind == "image" || kind == "audio") {
    let mime = mcStringField(raw, at, "mimeType");
    if (mime == "") { mime = "unknown format"; }
    return "[" + kind + " (" + mime + ") not shown]";
  }
  if (kind == "resource") {
    let resourceAt = mcFieldValue(raw, at, "resource");
    let embedded = mcStringField(raw, resourceAt, "text");
    if (embedded != "") { return embedded; }
    let uri = mcStringField(raw, resourceAt, "uri");
    if (uri == "") { uri = "no uri"; }
    return "[resource " + uri + " not shown]";
  }
  let uri = mcStringField(raw, at, "uri");
  if (uri != "") { return "[" + kind + " " + uri + " not shown]"; }
  return "[" + kind + " content not shown]";
}

function mcpContentText(raw: string, resultAt: int): string {
  let items = mcArrayItems(raw, mcFieldValue(raw, resultAt, "content"));
  let text = "";
  let i: int = 0;
  while (i < items.length) {
    text = text + mcpContentPart(raw, items[i]);
    i = i + 1;
  }
  return text;
}

// every content part in result.content[] joined into one string.
//
// Three ways a call fails, all of which used to read as an empty success:
//   - a JSON-RPC `error` object (an expired token, a refused argument);
//   - `result.isError`, which is how MCP reports a tool that ran and failed
//     ("permission denied") rather than a protocol fault;
//   - a body that is neither — an HTML error page, a JSON-RPC batch reply, a
//     bare `{"jsonrpc":"2.0","id":1}`, an empty body.
// Never throws: every one of them comes back as ok:false with a sentence.
export function parseMcpToolResult(raw: string): McpResult {
  if (raw.trim() == "") { return mcpResultErr("no reply from the MCP server"); }
  if (mcpIsError(raw)) { return mcpResultErr(mcpErrorMessage(raw)); }
  let resultAt = mcFieldValue(raw, 0, "result");
  if (resultAt < 0) {
    return mcpResultErr("the MCP server sent neither a result nor an error: " + mcPreview(raw));
  }
  let text = mcpContentText(raw, resultAt);
  if (mcBoolField(raw, resultAt, "isError")) {
    let why = text.trim();
    if (why == "") { why = "the tool reported a failure with no message"; }
    return mcpResultErr(why);
  }
  return mcpResultOk(text);
}

// --- HTTP-backed calls (the only I/O here) ----------------------------------

// Content-Type is forced on; caller-supplied auth headers ride along.
function mcpHeaders(headers: Map<string, string>): Map<string, string> {
  headers.set("Content-Type", "application/json");
  return headers;
}

// "" when the transport carried the reply, else the sentence a user reads. An
// MCP server answers an expired token with 401 and a body that is not JSON-RPC
// at all; handing that body to the JSON-RPC parser reads it as "the tool
// returned nothing", so the status is checked before the body is believed.
export function mcpHttpProblem(status: int, body: string): string {
  if (status >= 200 && status < 300) { return ""; }
  if (status == 0) { return "no answer from the MCP server"; }
  let why = "the MCP server answered HTTP " + `${status}`;
  let detail = mcpErrorMessage(body);
  if (detail != "") { return why + ": " + detail; }
  let preview = mcPreview(body);
  if (preview != "") { return why + ": " + preview; }
  return why;
}

export function mcpInitialize(url: string, headers: Map<string, string>): string {
  const res = http.request(url, "POST", mcpInitializeRequest(), mcpHeaders(headers));
  return res.body;
}

// a transport failure yields an empty list, the same as a server with no tools:
// the return type has no room for the reason. mcpListToolsProblem reports it.
export function mcpListTools(url: string, headers: Map<string, string>): McpTool[] {
  const res = http.request(url, "POST", mcpListToolsRequest(1), mcpHeaders(headers));
  if (mcpHttpProblem(res.status, res.body) != "") { return mcNoTools(); }
  return parseMcpTools(res.body);
}

// "" when the server listed its tools, else why it did not. A caller that has
// to tell "this server has no tools" from "this token expired" asks this.
export function mcpListToolsProblem(url: string, headers: Map<string, string>): string {
  const res = http.request(url, "POST", mcpListToolsRequest(1), mcpHeaders(headers));
  let problem = mcpHttpProblem(res.status, res.body);
  if (problem != "") { return problem; }
  if (mcpIsError(res.body)) { return mcpErrorMessage(res.body); }
  if (mcFieldValue(res.body, 0, "result") < 0) {
    return "the MCP server sent neither a result nor an error: " + mcPreview(res.body);
  }
  return "";
}

export function mcpCallTool(url: string, headers: Map<string, string>, name: string, argumentsJson: string): McpResult {
  const res = http.request(url, "POST", mcpCallToolRequest(1, name, argumentsJson), mcpHeaders(headers));
  let problem = mcpHttpProblem(res.status, res.body);
  if (problem != "") { return mcpResultErr(problem); }
  return parseMcpToolResult(res.body);
}

// --- Adapter into a first-class Tool --------------------------------------

// run turns its single string input into the arguments object the server's own
// inputSchema describes, and never throws: neither http.request nor
// parseMcpToolResult throws, so trouble comes back as text.
export function mcpToolToLumen(url: string, headers: Map<string, string>, entry: McpTool): Tool {
  let toolName = entry.name;
  let toolSchema = entry.schema;
  return makeTool(entry.name, entry.description, entry.schema, (input: string) => {
    let result = mcpCallTool(url, headers, toolName, mcpBuildArguments(toolSchema, input));
    if (result.ok) { return result.content; }
    return "error: " + result.error;
  });
}

export function mcpToolsToRegistry(url: string, headers: Map<string, string>, tools: McpTool[]): Tool[] {
  let out: Tool[] = [];
  let i: int = 0;
  while (i < tools.length) {
    out.push(mcpToolToLumen(url, headers, tools[i]));
    i = i + 1;
  }
  return out;
}

// Add a server's tools to a registry without letting them displace a local
// tool of the same name. registerTool replaces in place, so the obvious loop
// hands a server that declares `search_docs` the local name — and the policy
// allow list is checked by name, so `["search_docs"]` then permits the
// substitute. Local wins here; `toolClashProblem(local, mcpToolsToRegistry(...))`
// names the server tools a merge drops.
export function mcpRegisterTools(local: Tool[], url: string, headers: Map<string, string>, tools: McpTool[]): Tool[] {
  return mergeToolsKeepingLocal(local, mcpToolsToRegistry(url, headers, tools));
}

// Reading one value out of JSON text, without parsing the document.
//
//   let calls = jsonRaw(reply, "tool_calls");     // the array, as text
//   let name  = jsonText(call, "name");           // the string, decoded
//   let each  = jsonList(calls);                  // its elements, as text
//
// Everything this file reads is a document whose shape no record type can
// declare: a provider's reply carries usage counters and keys it invented last
// month, an MCP tool's result carries whatever that tool defines, and a tool's
// input schema is arbitrary by design. `JSON.parse<T>` refuses those, and it is
// right to — so these read the one member they need and step over the rest.
//
// This is not plume's `jsonMember`, which reads a *top-level* member of a row
// document and is deliberately blind to nesting. What a provider names lives
// several levels down — `choices[0].message.tool_calls` — so these search at
// any depth, and take the first match.
//
//   cd packages/agents && lumen test scan.test.ts

export function jsonBlank(ch: string): bool {
  return ch == " " || ch == "\n" || ch == "\t" || ch == "\r";
}

// The index just past the colon of the first `"key":`, at any depth, or -1.
//
// Strings are read whole rather than searched, so a document whose *text*
// contains `"tool_calls":` — a model quoting itself, say — does not match. A
// key is a string followed by a colon; anything else is a value to step over.
export function jsonFind(document: string, key: string): int {
  let i: int = 0;
  while (i < document.length) {
    if (document.charAt(i) != "\"") { i = i + 1; continue; }
    let j = i + 1;
    let name = "";
    while (j < document.length) {
      let ch = document.charAt(j);
      if (ch == "\\") {
        name = name + document.slice(j, j + 2);
        j = j + 2;
        continue;
      }
      if (ch == "\"") { break; }
      name = name + ch;
      j = j + 1;
    }
    if (j >= document.length) { return -1; }
    let after = j + 1;
    while (after < document.length && jsonBlank(document.charAt(after))) { after = after + 1; }
    if (name == key && after < document.length && document.charAt(after) == ":") {
      return after + 1;
    }
    i = j + 1;
  }
  return -1;
}

// The raw text of the value beginning at `from`, quotes and braces included.
// Nesting is counted and strings are skipped whole, so a brace inside a string
// does not end an object early.
export function jsonValueAt(document: string, from: int): string {
  let i = from;
  while (i < document.length && jsonBlank(document.charAt(i))) { i = i + 1; }
  if (i >= document.length) { return ""; }
  let start = i;
  let first = document.charAt(i);

  if (first == "\"") {
    i = i + 1;
    while (i < document.length) {
      let ch = document.charAt(i);
      if (ch == "\\") { i = i + 2; continue; }
      if (ch == "\"") { return document.slice(start, i + 1); }
      i = i + 1;
    }
    return "";
  }

  if (first == "{" || first == "[") {
    let depth: int = 0;
    let inString: bool = false;
    while (i < document.length) {
      let ch = document.charAt(i);
      if (inString) {
        if (ch == "\\") { i = i + 2; continue; }
        if (ch == "\"") { inString = false; }
        i = i + 1;
        continue;
      }
      if (ch == "\"") { inString = true; i = i + 1; continue; }
      if (ch == "{" || ch == "[") { depth = depth + 1; }
      if (ch == "}" || ch == "]") {
        depth = depth - 1;
        if (depth == 0) { return document.slice(start, i + 1); }
      }
      i = i + 1;
    }
    // Unbalanced: better to report nothing than half a value.
    return "";
  }

  // A number, true, false or null, ending at the first delimiter.
  while (i < document.length) {
    let ch = document.charAt(i);
    if (ch == "," || ch == "}" || ch == "]" || jsonBlank(ch)) {
      return document.slice(start, i);
    }
    i = i + 1;
  }
  return document.slice(start, document.length);
}

// The raw text of the first `"key"`'s value, or "" when there is none.
export function jsonRaw(document: string, key: string): string {
  let at = jsonFind(document, key);
  if (at < 0) { return ""; }
  return jsonValueAt(document, at);
}

// The first `"key"`'s value as text, with its escapes resolved. A member that
// is not a string reads as "", because a caller asking for text has been
// handed something else and should not receive `{"a":1}` as if it were.
export function jsonText(document: string, key: string): string {
  let raw = jsonRaw(document, key);
  if (raw.length < 2 || !raw.startsWith("\"")) { return ""; }
  return jsonUnescape(raw.slice(1, raw.length - 1));
}

export type JsonText = {
  found: bool,
  text: string,
};

// The first `"key"` whose value is actually a string, with its escapes
// resolved.
//
// A member spelled the same but holding something else is stepped over rather
// than accepted. This is not pedantry: a reply that is only tool calls carries
// `"content":null`, and the assistant's text — when there is any — is further
// along the document. `found` separates "there is no text" from "the text is
// empty", which are different answers to a caller deciding what to show.
export function jsonStringMember(document: string, key: string): JsonText {
  let absent: JsonText = { found: false, text: "" };
  let rest = document;
  while (true) {
    let at = jsonFind(rest, key);
    if (at < 0) { return absent; }
    let raw = jsonValueAt(rest, at);
    if (raw.length >= 2 && raw.startsWith("\"")) {
      let hit: JsonText = { found: true, text: jsonUnescape(raw.slice(1, raw.length - 1)) };
      return hit;
    }
    let step = raw.length;
    if (step < 1) { step = 1; }
    if (at + step >= rest.length) { return absent; }
    rest = rest.slice(at + step, rest.length);
  }
  return absent;
}

// The elements of an array, each as raw text. Given anything that is not an
// array, no elements — the caller asked the wrong document a question.
export function jsonList(array: string): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < array.length && jsonBlank(array.charAt(i))) { i = i + 1; }
  if (i >= array.length || array.charAt(i) != "[") { return out; }
  i = i + 1;
  while (i < array.length) {
    while (i < array.length) {
      let ch = array.charAt(i);
      if (!jsonBlank(ch) && ch != ",") { break; }
      i = i + 1;
    }
    if (i >= array.length || array.charAt(i) == "]") { return out; }
    let item = jsonValueAt(array, i);
    if (item == "") { return out; }
    out.push(item);
    i = i + item.length;
  }
  return out;
}

// A hex digit's value, or -1.
function hexDigit(ch: string): int {
  let c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) { return c - 48; }
  if (c >= 97 && c <= 102) { return c - 87; }
  if (c >= 65 && c <= 70) { return c - 55; }
  return -1;
}

// The four hex digits at `from` as a number, or -1 when they are not four hex
// digits.
function hex4(literal: string, from: int): int {
  if (from + 4 > literal.length) { return -1; }
  let value: int = 0;
  let i: int = 0;
  while (i < 4) {
    let d = hexDigit(literal.charAt(from + i));
    if (d < 0) { return -1; }
    value = value * 16 + d;
    i = i + 1;
  }
  return value;
}

// The text a JSON string literal stands for, given its body — what sits
// between the quotes.
//
// `\u` is resolved rather than dropped, surrogate pairs included, because a
// tool result carrying an accented name or an emoji is ordinary and arriving
// as `u00e9` would be a bug the user sees and cannot explain.
export function jsonUnescape(body: string): string {
  let out = "";
  let i: int = 0;
  while (i < body.length) {
    let ch = body.charAt(i);
    if (ch != "\\" || i + 1 >= body.length) {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let next = body.charAt(i + 1);
    if (next == "n") { out = out + "\n"; i = i + 2; continue; }
    if (next == "t") { out = out + "\t"; i = i + 2; continue; }
    if (next == "r") { out = out + "\r"; i = i + 2; continue; }
    if (next == "b" || next == "f") { i = i + 2; continue; }
    if (next == "u") {
      let code = hex4(body, i + 2);
      if (code < 0) { out = out + next; i = i + 2; continue; }
      i = i + 6;
      // A high surrogate is half a character; the low half follows it.
      if (code >= 55296 && code <= 56319 && i + 1 < body.length) {
        if (body.charAt(i) == "\\" && body.charAt(i + 1) == "u") {
          let low = hex4(body, i + 2);
          if (low >= 56320 && low <= 57343) {
            code = 65536 + (code - 55296) * 1024 + (low - 56320);
            i = i + 6;
          }
        }
      }
      out = out + String.fromCodePoint(code);
      continue;
    }
    // `\"`, `\\`, `\/` and anything else stand for the character itself.
    out = out + next;
    i = i + 2;
  }
  return out;
}


// Whether a fragment is one whole JSON object, and nothing else.
//
// A tool call's arguments arrive as text the model produced, and a model that
// hits its output cap mid-argument produces a prefix — `{"path": "/a.css",
// "content": "…` with no closing anything. Stored as-is it corrupts the turn
// it belongs to: the replay parses the first call, meets the break, and stops,
// so the round goes back to the provider with one announced call and two
// results. Mistral answers "Unexpected tool call id … in tool results" and
// every later turn in that conversation fails. Cheaper to notice here.
//
// The question is "is this one JSON object", not "do the brackets balance" —
// the value goes into the stored `calls` column verbatim and into an
// Anthropic `input`, where a second document after the first, a stray tail, or
// an array where an object belongs is the same kind of corrupted row that
// motivated this in the first place. So: one object, opened with `{`, every
// bracket closed by its own kind, no string left open and no raw control
// character in one, and nothing but whitespace either side of it.
//
// Not a full JSON grammar — commas and colons are not checked, because every
// failure this has ever had to catch is structural.
export function jsonComplete(text: string): bool {
  let i: int = 0;
  while (i < text.length && jsonBlank(text.charAt(i))) { i = i + 1; }
  // "" and "not json at all" are not documents, and neither is `[1,2]` or a
  // bare string where a tool's arguments belong.
  if (i >= text.length || text.charAt(i) != "{") { return false; }

  // What is still open, innermost last, as the characters that would close it.
  // A count would accept `{"a":[1}`, which is not one object.
  let open = "";
  let inString = false;
  let escaped = false;
  let end: int = -1;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch == "\\") { escaped = true; }
      else if (ch == "\"") { inString = false; }
      else if (ch == "\n" || ch == "\r" || ch == "\t") {
        // A literal control character inside a string is not legal JSON, and
        // it is exactly what a truncated stream leaves behind.
        return false;
      }
      i = i + 1;
      continue;
    }
    if (ch == "\"") { inString = true; }
    else if (ch == "{") { open = open + "}"; }
    else if (ch == "[") { open = open + "]"; }
    else if (ch == "}" || ch == "]") {
      if (open.length == 0 || open.charAt(open.length - 1) != ch) { return false; }
      open = open.slice(0, open.length - 1);
      if (open.length == 0) { end = i; break; }
    }
    i = i + 1;
  }
  // Never closed: the model stopped writing partway through.
  if (end < 0) { return false; }

  // `{"a":1}{"b":2}` is two documents and `{"a":1} junk` is one and a mess.
  // Either one, spliced into a row or a request, is a document nothing can
  // read back.
  let after = end + 1;
  while (after < text.length) {
    if (!jsonBlank(text.charAt(after))) { return false; }
    after = after + 1;
  }
  return true;
}

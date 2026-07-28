// Reading one member out of a provider reply, without parsing the whole thing.
//
// `JSON.parse<T>` rejects a body that carries a field the record does not
// declare, and every live reply carries several: `usage`, `service_tier`,
// `system_fingerprint`, `logprobs`, `message.refusal`, `message.annotations`,
// and whatever the provider ships next month. A record cannot be kept in step
// with a wire format nobody controls, so a reply is read one member at a time
// instead.
//
// A plain substring search is not the alternative: `"content":"` matches a
// gateway's echo of the request, matches a nested `meta.content`, and misses
// the same field the moment a proxy re-serializes the JSON with a space after
// the colon. Everything here walks the document's structure, so a member is
// found where it actually lives and nowhere else.

function hexDigitValue(c: string): int {
  let code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) { return code - 48; }
  if (code >= 97 && code <= 102) { return code - 87; }
  if (code >= 65 && code <= 70) { return code - 55; }
  return -1;
}

// A code point as UTF-8 bytes. `String.fromCharCode` writes one byte, so
// anything above ASCII is assembled here.
function utf8FromCodePoint(cp: int): string {
  if (cp < 0x80) {
    return String.fromCharCode(cp);
  }
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

// The four hex digits of a \uXXXX escape at `i`, or -1 when they are not all
// hex.
function readHex4(src: string, i: int): int {
  if (i + 3 >= src.length) { return -1; }
  let value: int = 0;
  let k: int = 0;
  while (k < 4) {
    let d = hexDigitValue(src.charAt(i + k));
    if (d < 0) { return -1; }
    value = value * 16 + d;
    k = k + 1;
  }
  return value;
}

// The text behind a JSON string body (the bytes between the quotes), with every
// escape resolved: the two-character ones, \uXXXX, and surrogate pairs.
//
// \uXXXX is not optional decoration. A model that writes an accent or an emoji
// sends it that way, and a Go-based OpenAI-compatible gateway sends `<`, `>`
// and `&` that way too, because `encoding/json` HTML-escapes them by default.
// Dropping the backslash and keeping the digits turns `café` into `cafu00e9`.
export function decodeJsonText(src: string): string {
  let out = "";
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\\" && i + 1 < src.length) {
      let n = src.charAt(i + 1);
      if (n == "n") { out = out + "\n"; i = i + 2; continue; }
      if (n == "t") { out = out + "\t"; i = i + 2; continue; }
      if (n == "r") { out = out + "\r"; i = i + 2; continue; }
      if (n == "b") { out = out + "\u{08}"; i = i + 2; continue; }
      if (n == "f") { out = out + "\u{0C}"; i = i + 2; continue; }
      if (n == "\"") { out = out + "\""; i = i + 2; continue; }
      if (n == "\\") { out = out + "\\"; i = i + 2; continue; }
      if (n == "/") { out = out + "/"; i = i + 2; continue; }
      if (n == "u") {
        let cp = readHex4(src, i + 2);
        if (cp < 0) { out = out + c; i = i + 1; continue; }
        i = i + 6;
        // A character outside the basic plane arrives as a surrogate pair;
        // decoding each half alone would emit two invalid characters.
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < src.length
            && src.charAt(i) == "\\" && src.charAt(i + 1) == "u") {
          let low = readHex4(src, i + 2);
          if (low >= 0xDC00 && low <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) * 0x400) + (low - 0xDC00);
            i = i + 6;
          }
        }
        out = out + utf8FromCodePoint(cp);
        continue;
      }
    }
    out = out + c;
    i = i + 1;
  }
  return out;
}

function jsonSkipSpace(s: string, i: int): int {
  let j = i;
  while (j < s.length) {
    let c = s.charAt(j);
    if (c != " " && c != "\t" && c != "\n" && c != "\r") { return j; }
    j = j + 1;
  }
  return j;
}

// `i` is at the opening quote; the index just past the closing quote, or -1.
function jsonStringEnd(s: string, i: int): int {
  let j = i + 1;
  while (j < s.length) {
    let c = s.charAt(j);
    if (c == "\\") { j = j + 2; continue; }
    if (c == "\"") { return j + 1; }
    j = j + 1;
  }
  return -1;
}

// The index just past the value starting at `i`, whatever its kind. Strings are
// skipped whole so a brace or bracket inside one never moves the depth.
function jsonValueEnd(s: string, i: int): int {
  let j = jsonSkipSpace(s, i);
  if (j >= s.length) { return -1; }
  let c = s.charAt(j);
  if (c == "\"") { return jsonStringEnd(s, j); }
  if (c == "{" || c == "[") {
    let depth: int = 0;
    let k = j;
    while (k < s.length) {
      let d = s.charAt(k);
      if (d == "\"") {
        let e = jsonStringEnd(s, k);
        if (e < 0) { return -1; }
        k = e;
        continue;
      }
      if (d == "{" || d == "[") { depth = depth + 1; }
      if (d == "}" || d == "]") {
        depth = depth - 1;
        if (depth == 0) { return k + 1; }
      }
      k = k + 1;
    }
    return -1;
  }
  let k = j;
  while (k < s.length) {
    let d = s.charAt(k);
    if (d == "," || d == "}" || d == "]" || d == " " || d == "\t" || d == "\n" || d == "\r") { return k; }
    k = k + 1;
  }
  return k;
}

// The index where `key`'s value begins, searching only the immediate members of
// the object at `objStart`, and -1 when the object has no such member. Nested
// objects are stepped over, which is what keeps a `content` deeper in the
// payload — or one in an echoed copy of the request — from being mistaken for
// the reply's own.
export function jsonMemberStart(s: string, objStart: int, key: string): int {
  let j = jsonSkipSpace(s, objStart);
  if (j >= s.length || s.charAt(j) != "{") { return -1; }
  j = j + 1;
  while (j < s.length) {
    j = jsonSkipSpace(s, j);
    if (j >= s.length) { return -1; }
    if (s.charAt(j) == "}") { return -1; }
    if (s.charAt(j) != "\"") { return -1; }
    let keyEnd = jsonStringEnd(s, j);
    if (keyEnd < 0) { return -1; }
    let name = s.slice(j + 1, keyEnd - 1);
    j = jsonSkipSpace(s, keyEnd);
    if (j >= s.length || s.charAt(j) != ":") { return -1; }
    j = jsonSkipSpace(s, j + 1);
    if (name == key) { return j; }
    let ve = jsonValueEnd(s, j);
    if (ve < 0) { return -1; }
    j = jsonSkipSpace(s, ve);
    if (j >= s.length) { return -1; }
    if (s.charAt(j) == ",") { j = j + 1; continue; }
    return -1;
  }
  return -1;
}

// Whether the value at `at` is the literal `null`. A member that is present and
// null is not a value a caller can use, and "absent" is the right reading.
export function jsonIsNullAt(s: string, at: int): bool {
  let j = jsonSkipSpace(s, at);
  if (j + 4 > s.length) { return false; }
  return s.slice(j, j + 4) == "null";
}

// The decoded string value of `key` in the object at `objStart`, or "" when the
// key is absent or its value is not a string (`"finish_reason":null`).
export function jsonStringMemberAt(s: string, objStart: int, key: string): string {
  let at = jsonMemberStart(s, objStart, key);
  if (at < 0) { return ""; }
  let j = jsonSkipSpace(s, at);
  if (j >= s.length || s.charAt(j) != "\"") { return ""; }
  let end = jsonStringEnd(s, j);
  if (end < 0) { return ""; }
  return decodeJsonText(s.slice(j + 1, end - 1));
}

// The integer value of `key` in the object at `objStart`, or 0 when the key is
// absent or its value is not a number.
export function jsonIntMemberAt(s: string, objStart: int, key: string): int {
  let at = jsonMemberStart(s, objStart, key);
  if (at < 0) { return 0; }
  let i = jsonSkipSpace(s, at);
  let sign: int = 1;
  if (i < s.length && s.charAt(i) == "-") { sign = -1; i = i + 1; }
  let out: int = 0;
  let digits: int = 0;
  while (i < s.length) {
    let code = s.charAt(i).charCodeAt(0);
    if (code < 48 || code > 57) { break; }
    out = out * 10 + (code - 48);
    digits = digits + 1;
    i = i + 1;
  }
  if (digits == 0) { return 0; }
  return sign * out;
}

// The first element of the `choices` array, or -1. A reply may carry several
// choices; only the first is this call's answer, and reading past it would
// splice another completion's text into this one.
export function jsonFirstChoice(doc: string): int {
  let at = jsonMemberStart(doc, 0, "choices");
  if (at < 0) { return -1; }
  let j = jsonSkipSpace(doc, at);
  if (j >= doc.length || doc.charAt(j) != "[") { return -1; }
  j = jsonSkipSpace(doc, j + 1);
  if (j >= doc.length || doc.charAt(j) != "{") { return -1; }
  return j;
}

// `content` of the first choice's `container` object, and nowhere else.
// `container` is "message" for a buffered reply and "delta" for a stream chunk;
// that one word is the whole difference between the two wire shapes.
export function jsonChoiceText(doc: string, container: string): string {
  let choice = jsonFirstChoice(doc);
  if (choice < 0) { return ""; }
  let at = jsonMemberStart(doc, choice, container);
  if (at < 0) { return ""; }
  let d = jsonSkipSpace(doc, at);
  if (d >= doc.length || doc.charAt(d) != "{") { return ""; }
  return jsonStringMemberAt(doc, d, "content");
}

// A string member of the first choice itself, such as `finish_reason`. A value
// on a later choice belongs to a different completion.
export function jsonChoiceString(doc: string, key: string): string {
  let choice = jsonFirstChoice(doc);
  if (choice < 0) { return ""; }
  return jsonStringMemberAt(doc, choice, key);
}

// The provider's error text, wherever this provider puts it: `error.message`
// (OpenAI), a bare `error` string, or a top-level `message`/`detail` (Mistral).
// "" when the body names no error.
export function jsonErrorText(doc: string): string {
  let at = jsonMemberStart(doc, 0, "error");
  if (at >= 0 && !jsonIsNullAt(doc, at)) {
    let nested = jsonStringMemberAt(doc, at, "message");
    if (nested != "") { return nested; }
    let plain = jsonStringMemberAt(doc, 0, "error");
    if (plain != "") { return plain; }
  }
  let detail = jsonStringMemberAt(doc, 0, "detail");
  if (detail != "") { return detail; }
  return jsonStringMemberAt(doc, 0, "message");
}

// Whether the document carries a non-null top-level `error` member. A streaming
// provider that fails after the headers are out sends exactly this, as one more
// `data:` line; it has no `choices`, so classifying it by its text is the only
// way it is ever seen.
export function jsonHasError(doc: string): bool {
  let at = jsonMemberStart(doc, 0, "error");
  if (at < 0) { return false; }
  return !jsonIsNullAt(doc, at);
}

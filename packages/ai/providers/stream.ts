// Token streaming over server-sent events.
//
// A streaming completion arrives as a sequence of `data:` lines, each carrying
// one chunk of the answer, terminated by `data: [DONE]`. This module turns that
// wire traffic into a sequence of normalized events and hands them to a caller's
// handler as they arrive, so an application can show text while the model is
// still generating it.
//
// OpenAI and Mistral emit the same chunk shape here, so one parser serves both
// and the per-provider entry points differ only in endpoint and auth. That is a
// property of the wire format, not an assumption: `streamEventFromLine` reads
// `choices[0].delta.content`, which both produce.

import { modelBaseUrl } from "../core/model.ts";
import { AiMessage } from "../core/messages.ts";
import { makeAiResult } from "../core/result.ts";
import { bearerJsonHeaders } from "../core/headers.ts";

// One normalized step of a stream. `kind` is the discriminator:
//
//   "delta" - `delta` holds the next piece of text.
//   "done"  - the stream ended; `finishReason` carries the provider's reason
//             when it sent one.
//   "other" - a chunk that carried no text and did not end the stream (a role
//             announcement, a keep-alive). Handlers can usually ignore these.
//   "error" - the line could not be read as a chunk; `raw` holds it verbatim.
//
// `raw` is always the original payload, so a handler can reach past this record
// when it needs a field the record does not model.
export type AiStreamEvent = {
  kind: string,
  delta: string,
  finishReason: string,
  raw: string,
};

// Called once per event, in arrival order. It must not throw: a stream is read
// inside a loop that cannot unwind past it.
export type AiStreamHandler = (event: AiStreamEvent) => void;

const DONE_SENTINEL = "[DONE]";

// `finish` rather than `finishReason`: every module is inlined into one flat
// namespace, so a parameter may not share a name with a top-level declaration,
// and the package already exports a `finishReason` function.
function makeStreamEvent(kind: string, delta: string, finish: string, raw: string): AiStreamEvent {
  let e: AiStreamEvent = {
    kind: kind,
    delta: delta,
    finishReason: finish,
    raw: raw,
  };
  return e;
}

// --- JSON reading -----------------------------------------------------------
// A chunk is read with a small structure-aware scanner rather than JSON.parse<T>
// (which rejects the provider-specific fields chunks carry, and a rejected chunk
// means dropped tokens) and rather than plain substring search (which cannot
// tell `choices[0].delta.content` from a `content` key nested somewhere else in
// the payload, and so reports the wrong text).

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

// JSON string escapes, including \uXXXX and surrogate pairs — a model emitting
// an accent or an emoji sends those, and passing them through verbatim would
// corrupt the text.
function decodeStreamString(src: string): string {
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

function jsonSkipWs(s: string, i: int): int {
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
  let j = jsonSkipWs(s, i);
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
// the object at `objStart`. Nested objects are stepped over, which is what keeps
// a `content` deeper in the payload from being mistaken for the delta's own.
function jsonFindKey(s: string, objStart: int, key: string): int {
  let j = jsonSkipWs(s, objStart);
  if (j >= s.length || s.charAt(j) != "{") { return -1; }
  j = j + 1;
  while (j < s.length) {
    j = jsonSkipWs(s, j);
    if (j >= s.length) { return -1; }
    if (s.charAt(j) == "}") { return -1; }
    if (s.charAt(j) != "\"") { return -1; }
    let keyEnd = jsonStringEnd(s, j);
    if (keyEnd < 0) { return -1; }
    let name = s.slice(j + 1, keyEnd - 1);
    j = jsonSkipWs(s, keyEnd);
    if (j >= s.length || s.charAt(j) != ":") { return -1; }
    j = jsonSkipWs(s, j + 1);
    if (name == key) { return j; }
    let ve = jsonValueEnd(s, j);
    if (ve < 0) { return -1; }
    j = jsonSkipWs(s, ve);
    if (j >= s.length) { return -1; }
    if (s.charAt(j) == ",") { j = j + 1; continue; }
    return -1;
  }
  return -1;
}

// The decoded string value of `key` in the object at `objStart`, or "" when the
// key is absent or its value is not a string (`"finish_reason":null`).
function jsonStringMember(s: string, objStart: int, key: string): string {
  let at = jsonFindKey(s, objStart, key);
  if (at < 0) { return ""; }
  let j = jsonSkipWs(s, at);
  if (j >= s.length || s.charAt(j) != "\"") { return ""; }
  let end = jsonStringEnd(s, j);
  if (end < 0) { return ""; }
  return decodeStreamString(s.slice(j + 1, end - 1));
}

// The first element of the `choices` array. A chunk may carry several choices;
// only the first is this stream's reply, and reading past it would splice
// another completion's text into this one.
function firstChoiceObject(payload: string): int {
  let at = jsonFindKey(payload, 0, "choices");
  if (at < 0) { return -1; }
  let j = jsonSkipWs(payload, at);
  if (j >= payload.length || payload.charAt(j) != "[") { return -1; }
  j = jsonSkipWs(payload, j + 1);
  if (j >= payload.length || payload.charAt(j) != "{") { return -1; }
  return j;
}

// `content` of the first choice's `delta` object, and nowhere else.
function scanDeltaContent(payload: string): string {
  let choice = firstChoiceObject(payload);
  if (choice < 0) { return ""; }
  let at = jsonFindKey(payload, choice, "delta");
  if (at < 0) { return ""; }
  let d = jsonSkipWs(payload, at);
  if (d >= payload.length || payload.charAt(d) != "{") { return ""; }
  return jsonStringMember(payload, d, "content");
}

// `finish_reason` of the first choice. A reason on a later choice belongs to a
// different completion.
function scanFinishReason(payload: string): string {
  let choice = firstChoiceObject(payload);
  if (choice < 0) { return ""; }
  return jsonStringMember(payload, choice, "finish_reason");
}

// Strip the `data:` prefix of one server-sent-events line. Returns "" for a
// blank separator or a non-data line (a `event:` or `id:` field, a comment).
export function streamLinePayload(line: string): string {
  let s = line.trim();
  if (s.length == 0) { return ""; }
  if (!s.startsWith("data:")) { return ""; }
  return s.slice(5).trim();
}

// One SSE line to one event. A blank separator, a comment, or a non-data field
// yields an "other" event with no text, so a caller can hand every line here
// without pre-filtering.
export function streamEventFromLine(line: string): AiStreamEvent {
  let payload = streamLinePayload(line);
  if (payload.length == 0) {
    return makeStreamEvent("other", "", "", line);
  }
  if (payload == DONE_SENTINEL) {
    return makeStreamEvent("done", "", "", payload);
  }
  if (!payload.startsWith("{")) {
    return makeStreamEvent("error", "", "", payload);
  }
  let delta = scanDeltaContent(payload);
  let finish = scanFinishReason(payload);
  if (delta.length > 0) {
    return makeStreamEvent("delta", delta, finish, payload);
  }
  // A chunk with a finish reason and no text is the provider closing the
  // message; the [DONE] sentinel may or may not follow it.
  if (finish.length > 0) {
    return makeStreamEvent("done", "", finish, payload);
  }
  return makeStreamEvent("other", "", "", payload);
}

// Both provider entry points below normalize through the same parser; these
// names exist because the milestone lists each wire format separately, and
// because a future divergence has a place to land without moving callers.
export function openAIStreamEvent(line: string): AiStreamEvent {
  return streamEventFromLine(line);
}

export function mistralStreamEvent(line: string): AiStreamEvent {
  return streamEventFromLine(line);
}

type StreamChatRequest = {
  model: string,
  messages: AiMessage[],
  temperature: number,
  max_tokens: int,
  stream: bool,
};

// A chat body with `stream` set, which the buffered builders do not carry.
export function buildStreamChatBody(model: string, messages: AiMessage[], temperature: number, maxTokens: int): string {
  const req: StreamChatRequest = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
    stream: true,
  };
  return JSON.stringify(req);
}

function streamHeaders(apiKey: string): Map<string, string> {
  let h = bearerJsonHeaders(apiKey);
  h.set("Accept", "text/event-stream");
  return h;
}

// Stream a completion, calling `onEvent` for each event as it arrives, and
// return the assembled reply once the stream ends.
//
// The returned result's `content` is every delta concatenated, so a caller that
// wants both live output and the whole answer needs only this one call. `raw`
// carries the last line seen, which is where a provider puts an error when it
// fails mid-stream.
//
// An unroutable config fails the same way the buffered path does rather than
// guessing an endpoint.
export function streamConfiguredChat(cfg: AiModelConfig, messages: AiMessage[], onEvent: AiStreamHandler): AiResult {
  let base = modelBaseUrl(cfg);
  if (base == "") {
    return makeAiResult(0, false, "", "unroutable model config: provider \"" + cfg.provider + "\" has no default endpoint — set a baseUrl");
  }
  let url = base + "/chat/completions";
  let body = buildStreamChatBody(cfg.model, messages, cfg.temperature, cfg.maxTokens);
  let s = http.stream(url, "POST", body, streamHeaders(cfg.apiKey));

  let status = s.status();
  if (status < 200 || status >= 300) {
    // The body of a failed streaming request is an ordinary error payload, not
    // events: drain it so the caller sees why.
    let errBody = "";
    while (!s.done()) {
      let line = s.readLine();
      if (s.done()) { break; }
      errBody = errBody + line;
    }
    s.close();
    return makeAiResult(status, false, "", errBody);
  }

  let content = "";
  let last = "";
  while (!s.done()) {
    let line = s.readLine();
    if (s.done()) { break; }
    let event = streamEventFromLine(line);
    if (event.kind == "other") { continue; }
    last = event.raw;
    if (event.kind == "delta") { content = content + event.delta; }
    onEvent(event);
    if (event.kind == "done" && event.raw == DONE_SENTINEL) { break; }
  }
  s.close();
  return makeAiResult(status, true, content, last);
}

// Collect a stream without a handler, for a caller that wants streaming's
// time-to-first-byte on the wire but has nothing to do per token.
export function streamChatToString(cfg: AiModelConfig, messages: AiMessage[]): AiResult {
  let sink: AiStreamHandler = (event: AiStreamEvent) => {
  };
  return streamConfiguredChat(cfg, messages, sink);
}

// Replay a captured stream body through the parser, for tests and for reading a
// recorded session back. Splits on newlines and reports the same events a live
// stream would, in order.
export function streamEventsFromBody(body: string): AiStreamEvent[] {
  let out: AiStreamEvent[] = [];
  let lines = body.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    let event = streamEventFromLine(lines[i]);
    if (event.kind != "other") {
      out = [...out, event];
    }
    i = i + 1;
  }
  return out;
}

// The text of a captured stream: every delta concatenated, ignoring everything
// else.
export function streamBodyText(body: string): string {
  let events = streamEventsFromBody(body);
  let out = "";
  let i: int = 0;
  while (i < events.length) {
    if (events[i].kind == "delta") { out = out + events[i].delta; }
    i = i + 1;
  }
  return out;
}

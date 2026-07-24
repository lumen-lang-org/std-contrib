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
      if (n == "\"") { out = out + "\""; i = i + 2; continue; }
      if (n == "\\") { out = out + "\\"; i = i + 2; continue; }
      if (n == "/") { out = out + "/"; i = i + 2; continue; }
    }
    out = out + c;
    i = i + 1;
  }
  return out;
}

// The string value of `field` starting from `from`, or "" when the field is not
// present. A hand-rolled scan rather than JSON.parse<T>: a chunk carries
// provider-specific fields that a typed parse would reject outright, and a
// rejected chunk means dropped tokens.
function scanStringFieldFrom(raw: string, field: string, from: int): string {
  let marker = "\"" + field + "\":\"";
  let start = raw.indexOf(marker, from);
  if (start < 0) { return ""; }
  let i = start + marker.length;
  let out = "";
  let escaped: bool = false;
  while (i < raw.length) {
    let c = raw.charAt(i);
    if (escaped) {
      out = out + "\\" + c;
      escaped = false;
      i = i + 1;
    } else if (c == "\\") {
      escaped = true;
      i = i + 1;
    } else {
      if (c == "\"") { return decodeStreamString(out); }
      out = out + c;
      i = i + 1;
    }
  }
  return "";
}

// `content` inside the first `delta` object. Anchoring on `"delta"` keeps a
// non-streaming `message.content` in the same payload from being mistaken for a
// token, which matters because some providers echo both.
function scanDeltaContent(raw: string): string {
  let at = raw.indexOf("\"delta\"");
  if (at < 0) { return ""; }
  return scanStringFieldFrom(raw, "content", at);
}

// A JSON string field whose value may also be null (`"finish_reason":null`),
// which the string scanner cannot see because it looks for an opening quote.
function scanNullableStringField(raw: string, field: string): string {
  let marker = "\"" + field + "\":";
  let start = raw.indexOf(marker);
  if (start < 0) { return ""; }
  let i = start + marker.length;
  while (i < raw.length && raw.charAt(i) == " ") { i = i + 1; }
  if (i >= raw.length || raw.charAt(i) != "\"") { return ""; }
  return scanStringFieldFrom(raw, field, start);
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
  let finish = scanNullableStringField(payload, "finish_reason");
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

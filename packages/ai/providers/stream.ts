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
import { Message } from "../core/messages.ts";
import { makeAiResult } from "../core/result.ts";
import { bearerJsonHeaders } from "../core/headers.ts";
import { jsonChoiceText, jsonChoiceString, jsonErrorText, jsonHasError } from "../core/jsonscan.ts";
import { makeProviderError, providerFailureText } from "../core/error.ts";

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
export type StreamEvent = {
  kind: string,
  delta: string,
  finishReason: string,
  raw: string,
};

// Called once per event, in arrival order. It must not throw: a stream is read
// inside a loop that cannot unwind past it.
export type StreamHandler = (event: StreamEvent) => void;

const DONE_SENTINEL = "[DONE]";

// `finish` rather than `finishReason`: every module is inlined into one flat
// namespace, so a parameter may not share a name with a top-level declaration,
// and the package already exports a `finishReason` function.
function makeStreamEvent(kind: string, delta: string, finish: string, raw: string): StreamEvent {
  let e: StreamEvent = {
    kind: kind,
    delta: delta,
    finishReason: finish,
    raw: raw,
  };
  return e;
}

// --- JSON reading -----------------------------------------------------------
// A chunk is read with the package's structure-aware member reader
// (core/jsonscan.ts) rather than JSON.parse<T> (which rejects the
// provider-specific fields chunks carry, and a rejected chunk means dropped
// tokens) and rather than plain substring search (which cannot tell
// `choices[0].delta.content` from a `content` key nested somewhere else in the
// payload, and so reports the wrong text). The buffered path reads
// `choices[0].message.content` through the same reader; "delta" against
// "message" is the whole difference between the two wire shapes.

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
export function streamEventFromLine(line: string): StreamEvent {
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
  // A provider that fails after the headers are out sends the failure as one
  // more `data:` line: `{"error":{"message":...,"type":"server_error"}}`. It
  // begins with `{` and carries no `choices`, so classifying it by shape alone
  // filed it as "other" — the one kind the collector drops before it reaches
  // `content`, `raw` or the handler. The error text is the whole reason the
  // stream stopped, so it is checked for first.
  if (jsonHasError(payload)) {
    return makeStreamEvent("error", "", "", payload);
  }
  let delta = jsonChoiceText(payload, "delta");
  let finish = jsonChoiceString(payload, "finish_reason");
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
export function openAIStreamEvent(line: string): StreamEvent {
  return streamEventFromLine(line);
}

export function mistralStreamEvent(line: string): StreamEvent {
  return streamEventFromLine(line);
}

type StreamChatRequest = {
  model: string,
  messages: Message[],
  temperature: number,
  max_tokens: int,
  stream: bool,
};

// A chat body with `stream` set, which the buffered builders do not carry.
export function buildStreamChatBody(model: string, messages: Message[], temperature: number, maxTokens: int): string {
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

// --- Collecting a stream ----------------------------------------------------
//
// What a completed stream added up to. `terminated` is the load-bearing field:
// a stream that ran to `[DONE]` and a stream whose connection was reset both
// end, and once the last byte is read the socket cannot be asked which happened
// — the runtime reports any read failure the same way it reports a clean end of
// stream, as `done()`. What does distinguish them is on the wire: a provider
// that finished sent a terminating event, and one that died did not. So the
// terminator is what is tracked, and a stream that never saw one is not
// reported as a success no matter how much text arrived first.
type StreamOutcome = {
  content: string,
  last: string,
  terminated: bool,
  failed: bool,
};

function emptyStreamOutcome(): StreamOutcome {
  let acc: StreamOutcome = { content: "", last: "", terminated: false, failed: false };
  return acc;
}

// Records are immutable, so folding one event rebuilds the accumulator.
function streamOutcomeStep(acc: StreamOutcome, event: StreamEvent): StreamOutcome {
  if (event.kind == "other") { return acc; }
  let content = acc.content;
  if (event.kind == "delta") { content = content + event.delta; }
  // `[DONE]` carries nothing a caller can use, and overwriting `raw` with it
  // discarded the chunk before it — the one holding `finish_reason`, and so the
  // only evidence that an answer was cut off at max_tokens rather than finished.
  let last = acc.last;
  if (event.raw != DONE_SENTINEL) { last = event.raw; }
  let terminated = acc.terminated;
  if (event.kind == "done") { terminated = true; }
  let failed = acc.failed;
  if (event.kind == "error") { failed = true; }
  let out: StreamOutcome = { content: content, last: last, terminated: terminated, failed: failed };
  return out;
}

// Whether this event ends the read loop: the sentinel, or a failure.
function streamOutcomeEnds(event: StreamEvent): bool {
  if (event.kind == "error") { return true; }
  return event.kind == "done" && event.raw == DONE_SENTINEL;
}

function streamOutcomeResult(status: int, acc: StreamOutcome): Result {
  if (acc.failed) {
    return makeAiResult(status, false, acc.content, acc.last);
  }
  if (!acc.terminated) {
    // The partial text is still handed back — it is real output — but `ok`
    // must not claim it is the answer.
    return makeAiResult(status, false, acc.content,
      "stream ended without a terminating event (no [DONE] and no finish_reason); last chunk: " + acc.last);
  }
  return makeAiResult(status, true, acc.content, acc.last);
}

// Stream a completion, calling `onEvent` for each event as it arrives, and
// return the assembled reply once the stream ends.
//
// The returned result's `content` is every delta concatenated, so a caller that
// wants both live output and the whole answer needs only this one call. `raw`
// carries the last informative chunk, which is where a provider puts an error
// when it fails mid-stream and where it puts the finish reason when it does not.
//
// `ok` is true only when the provider actually ended the stream. A connection
// reset, a mid-stream error chunk, and a line longer than the runtime's 64KB
// limit all end the read the same way a clean finish does, and all three
// previously reported success over a truncated answer.
//
// An unroutable config fails the same way the buffered path does rather than
// guessing an endpoint.
export function streamConfiguredChat(cfg: ModelConfig, messages: Message[], onEvent: StreamHandler): Result {
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
    // events: drain it so the caller sees why. A connect, DNS or TLS failure
    // sends no body at all and reports status -1, so the body alone would leave
    // the caller with nothing; the sentence names the provider and the URL the
    // same way the buffered path does.
    let errBody = "";
    while (!s.done()) {
      let line = s.readLine();
      if (s.done()) { break; }
      errBody = errBody + line;
    }
    s.close();
    let named = cfg.provider;
    if (named == "") { named = "provider"; }
    let reason = jsonErrorText(errBody);
    if (reason == "" && errBody != "") { reason = errBody; }
    return makeAiResult(status, false, "", providerFailureText(makeProviderError(named, status, reason, errBody), url));
  }

  let acc = emptyStreamOutcome();
  while (!s.done()) {
    let line = s.readLine();
    if (s.done()) { break; }
    let event = streamEventFromLine(line);
    if (event.kind == "other") { continue; }
    acc = streamOutcomeStep(acc, event);
    onEvent(event);
    if (streamOutcomeEnds(event)) { break; }
  }
  s.close();
  return streamOutcomeResult(status, acc);
}

// Collect a stream without a handler, for a caller that wants streaming's
// time-to-first-byte on the wire but has nothing to do per token.
export function streamChatToString(cfg: ModelConfig, messages: Message[]): Result {
  let sink: StreamHandler = (event: StreamEvent) => {
  };
  return streamConfiguredChat(cfg, messages, sink);
}

// Replay a captured stream body through the parser, for tests and for reading a
// recorded session back. Splits on newlines and reports the same events a live
// stream would, in order.
export function streamEventsFromBody(body: string): StreamEvent[] {
  let out: StreamEvent[] = [];
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

// Replay a captured body into the Result the live path would return, through
// the same fold. A recorded session, a fixture, and a live socket therefore
// agree on whether the stream finished — which is the only way that judgement
// can be tested without a provider that dies on cue.
export function streamResultFromBody(status: int, body: string): Result {
  let acc = emptyStreamOutcome();
  let events = streamEventsFromBody(body);
  let i: int = 0;
  while (i < events.length) {
    acc = streamOutcomeStep(acc, events[i]);
    if (streamOutcomeEnds(events[i])) { break; }
    i = i + 1;
  }
  return streamOutcomeResult(status, acc);
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

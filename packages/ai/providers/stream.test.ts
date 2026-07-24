// Streaming event parsing, over hand-written server-sent-events lines. These
// bodies are the shape both OpenAI and Mistral send; nothing here touches the
// network.

import { streamEventFromLine, streamLinePayload, streamEventsFromBody, streamBodyText, buildStreamChatBody, openAIStreamEvent, mistralStreamEvent } from "./stream.ts";

const CHUNK_HI = "data: {\"id\":\"a\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}";
const CHUNK_ROLE = "data: {\"id\":\"a\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}";
const CHUNK_STOP = "data: {\"id\":\"a\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}";
const DONE = "data: [DONE]";

test("payload strips the data prefix and surrounding space", () => {
  expect(streamLinePayload("data: {\"a\":1}") == "{\"a\":1}");
  expect(streamLinePayload("data:{\"a\":1}") == "{\"a\":1}");
  expect(streamLinePayload("") == "");
  expect(streamLinePayload("   ") == "");
});

test("a comment or non-data field is not a payload", () => {
  // SSE allows `event:`, `id:`, `retry:` and `:comment` lines; none carry chunks.
  expect(streamLinePayload(": keep-alive") == "");
  expect(streamLinePayload("event: message") == "");
  expect(streamLinePayload("id: 42") == "");
});

test("a content chunk yields a delta event", () => {
  let e = streamEventFromLine(CHUNK_HI);
  expect(e.kind == "delta");
  expect(e.delta == "Hi");
  expect(e.finishReason == "");
});

test("the done sentinel yields a done event", () => {
  let e = streamEventFromLine(DONE);
  expect(e.kind == "done");
  expect(e.delta == "");
  expect(e.raw == "[DONE]");
});

test("a role-only chunk carries no text", () => {
  let e = streamEventFromLine(CHUNK_ROLE);
  expect(e.kind == "other");
  expect(e.delta == "");
});

test("a finish_reason chunk with no text ends the message", () => {
  let e = streamEventFromLine(CHUNK_STOP);
  expect(e.kind == "done");
  expect(e.finishReason == "stop");
});

test("a null finish_reason reads as absent, not as the text null", () => {
  let e = streamEventFromLine(CHUNK_HI);
  expect(e.finishReason == "");
});

test("blank separator lines are inert", () => {
  let e = streamEventFromLine("");
  expect(e.kind == "other");
  expect(e.delta == "");
});

test("a non-JSON payload is reported as an error, not silently dropped", () => {
  let e = streamEventFromLine("data: upstream exploded");
  expect(e.kind == "error");
  expect(e.raw == "upstream exploded");
});

test("escapes in a delta are decoded", () => {
  let line = "data: {\"choices\":[{\"delta\":{\"content\":\"a\\nb\\t\\\"c\\\"\"}}]}";
  let e = streamEventFromLine(line);
  expect(e.kind == "delta");
  expect(e.delta == "a\nb\t\"c\"");
});

test("a delta holding only whitespace is still a delta", () => {
  // Space and newline tokens carry real meaning in generated text; treating a
  // whitespace delta as empty would silently reflow the answer.
  let e = streamEventFromLine("data: {\"choices\":[{\"delta\":{\"content\":\" \"}}]}");
  expect(e.kind == "delta");
  expect(e.delta == " ");
});

test("a message.content in the same payload is not mistaken for a token", () => {
  // Anchoring on "delta" keeps a non-streaming echo from double-counting.
  let line = "data: {\"choices\":[{\"message\":{\"content\":\"WHOLE\"},\"delta\":{\"content\":\"tok\"}}]}";
  let e = streamEventFromLine(line);
  expect(e.delta == "tok");
});

test("a body replays as the events a live stream would report", () => {
  let body = CHUNK_ROLE + "\n\n" + CHUNK_HI + "\n\n" + CHUNK_STOP + "\n\n" + DONE + "\n";
  let events = streamEventsFromBody(body);
  // The role chunk and the blank separators are inert and dropped.
  expect(events.length == 3);
  expect(events[0].kind == "delta");
  expect(events[1].kind == "done");
  expect(events[2].kind == "done");
});

test("body text is every delta concatenated in order", () => {
  let a = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}";
  let b = "data: {\"choices\":[{\"delta\":{\"content\":\", \"}}]}";
  let c = "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}";
  let body = a + "\n" + b + "\n" + c + "\n" + DONE;
  expect(streamBodyText(body) == "Hello, world");
});

test("an empty body yields no events and no text", () => {
  expect(streamEventsFromBody("").length == 0);
  expect(streamBodyText("") == "");
});

test("a body of only separators yields nothing", () => {
  expect(streamEventsFromBody("\n\n\n").length == 0);
});

test("both provider entry points normalize identically", () => {
  let a = openAIStreamEvent(CHUNK_HI);
  let b = mistralStreamEvent(CHUNK_HI);
  expect(a.kind == b.kind);
  expect(a.delta == b.delta);
});

test("the request body sets stream", () => {
  let msgs: AiMessage[] = [];
  let body = buildStreamChatBody("m", msgs, 0.5, 64);
  expect(body.indexOf("\"stream\":true") >= 0);
  expect(body.indexOf("\"model\":\"m\"") >= 0);
  expect(body.indexOf("\"max_tokens\":64") >= 0);
});

test("a handler sees every delta in arrival order", () => {
  let seen = "";
  let count = 0;
  let body = "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\ndata: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n" + DONE;
  let events = streamEventsFromBody(body);
  let i: int = 0;
  while (i < events.length) {
    if (events[i].kind == "delta") {
      seen = seen + events[i].delta;
      count = count + 1;
    }
    i = i + 1;
  }
  expect(seen == "ab");
  expect(count == 2);
});

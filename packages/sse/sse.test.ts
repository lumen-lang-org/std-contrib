// The event stream format. Every case here is one a browser's EventSource
// judges the same way, and the round-trip tests read back with this package's
// own reader — which is why the browser check in the README matters more.
//
//   cd packages/sse && lumen test sse.test.ts

import { ServerEvent, EventRequest, eventHeaders, eventFrame, retryFrame, commentFrame, readEventRequest, readEvent } from "./sse.ts";

test("the headers say what a proxy must not do", () => {
  let h = eventHeaders();
  expect(h.indexOf("Content-Type: text/event-stream") >= 0);
  // A proxy that caches this serves one client's stream to another.
  expect(h.indexOf("Cache-Control: no-cache") >= 0);
  // nginx otherwise holds events until its buffer fills, and a live stream
  // arrives in lumps minutes late.
  expect(h.indexOf("X-Accel-Buffering: no") >= 0);
  expect(h.endsWith("\r\n\r\n"));
});

test("an event is data plus a blank line", () => {
  // Without the blank line the browser never delivers it, and the stream
  // looks perfectly correct in a log.
  expect(eventFrame({ id: "", name: "", data: "hello" }) == "data: hello\n\n");
});

test("a named event carries its name first", () => {
  expect(eventFrame({ id: "", name: "token", data: "Hel" }) == "event: token\ndata: Hel\n\n");
});

test("an id comes before the name", () => {
  expect(eventFrame({ id: "7", name: "token", data: "x" }) == "id: 7\nevent: token\ndata: x\n\n");
});

test("every line of the data gets its own prefix", () => {
  // A newline inside a value would otherwise end the event early and deliver
  // half of it.
  expect(eventFrame({ id: "", name: "", data: "one\ntwo" }) == "data: one\ndata: two\n\n");
});

test("retry and comments are their own frames", () => {
  expect(retryFrame(5000) == "retry: 5000\n\n");
  // A heartbeat: proxies and phone radios drop a connection that says nothing
  // for a minute, and a colon line costs nothing.
  expect(commentFrame("ping") == ": ping\n\n");
});

// --- reading ------------------------------------------------------------------------

test("an event is read back whole", () => {
  let got = readEvent("event: token\ndata: Hello\n\n");
  expect(got.complete);
  expect(got.name == "token");
  expect(got.data == "Hello");
  expect(got.consumed == "event: token\ndata: Hello\n\n".length);
});

test("multi-line data is rejoined with newlines", () => {
  let got = readEvent("data: one\ndata: two\n\n");
  expect(got.data == "one\ntwo");
});

test("half an event is not an error", () => {
  // Events arrive in pieces; a client keeps reading.
  expect(!readEvent("data: par").complete);
  expect(!readEvent("").complete);
});

test("two events in one buffer are read one at a time", () => {
  let wire = "data: one\n\ndata: two\n\n";
  let first = readEvent(wire);
  expect(first.data == "one");
  expect(readEvent(wire.slice(first.consumed, wire.length)).data == "two");
});

test("only one leading space is stripped", () => {
  // The space after the colon is framing. Taking more corrupts data that
  // begins with spaces.
  expect(readEvent("data:  indented\n\n").data == " indented");
  expect(readEvent("data:tight\n\n").data == "tight");
});

test("a CRLF stream reads the same as an LF one", () => {
  let got = readEvent("event: t\r\ndata: x\r\n\r\n");
  expect(got.complete);
  expect(got.name == "t");
  expect(got.data == "x");
});

test("a comment is consumed, not mistaken for data", () => {
  let got = readEvent(": heartbeat\n\n");
  expect(got.complete);
  expect(got.data == "");
  expect(got.name == "");
});

test("an id survives the round trip, which is what resumption needs", () => {
  let got = readEvent(eventFrame({ id: "42", name: "tick", data: "on" }));
  expect(got.id == "42");
  expect(got.name == "tick");
  expect(got.data == "on");
});

// --- the request ----------------------------------------------------------------------

test("a stream request is an ordinary GET", () => {
  let req = readEventRequest("GET /events HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n");
  expect(req.ok);
  expect(req.path == "/events");
  expect(req.lastEventId == "");
});

test("a reconnecting browser says where it got to", () => {
  // This is how a server resumes rather than repeats.
  let req = readEventRequest("GET /events HTTP/1.1\r\nLast-Event-ID: 42\r\n\r\n");
  expect(req.ok);
  expect(req.lastEventId == "42");
});

test("half a request waits, and a POST is refused by name", () => {
  expect(!readEventRequest("GET /ev").ok);
  expect(readEventRequest("GET /ev").error == "");
  expect(readEventRequest("POST / HTTP/1.1\r\n\r\n").error.indexOf("is a GET") >= 0);
});

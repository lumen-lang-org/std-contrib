// The reading loop, fed bytes instead of a socket.
//
// The frames below are built with `encodeFrame` and masked as a client masks
// them, because that is what a server actually receives — an unmasked stream
// would exercise a path no real client takes.
//
//   cd packages/websocket && lumen test session.test.ts

import { Frame, Assembly, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, OP_CONTINUATION, encodeFrame, encodeClose, newAssembly } from "./frame.ts";
import { Step, STEP_WAIT, STEP_MESSAGE, STEP_PONG, STEP_CLOSE, STEP_FAIL, drain } from "./session.ts";

// The RFC's own mask key. Built byte by byte because this language has no
// \x escape — a literal "\x37" is four characters, and encodeFrame quietly
// substitutes a zero key for one that is not four bytes long, so the test
// would pass while masking nothing.
function bytes(hex: string): string {
  let out = "";
  let i: int = 0;
  while (i < hex.length) {
    let hi = "0123456789abcdef".indexOf(hex.charAt(i));
    let lo = "0123456789abcdef".indexOf(hex.charAt(i + 1));
    out = out + String.fromCharCode(hi * 16 + lo);
    i = i + 2;
  }
  return out;
}

const MAX: int = 1000000;

// A frame as a client sends it: masked, since a server refuses one that is
// not.
function clientFrame(opcode: int, payload: string): string {
  return encodeFrame(opcode, payload, true, bytes("37fa213d"));
}

// The same, but not the last of its message. encodeFrame always sets FIN —
// there is no fragmenting encoder — so the bit is cleared here.
function fragment(opcode: int, payload: string): string {
  let whole = clientFrame(opcode, payload);
  return String.fromCharCode(whole.charCodeAt(0) - 128) + whole.slice(1, whole.length);
}

// --- one message at a time ------------------------------------------------------------

test("a whole text frame comes out as a message", () => {
  let wire = clientFrame(OP_TEXT, "Hello");
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_MESSAGE);
  expect(step.message == "Hello");
  expect(step.opcode == OP_TEXT);
  // Consumed: nothing is left for the next call.
  expect(step.buffer == "");
});

test("half a frame is not an error — it waits", () => {
  // A message spans reads. Treating a partial frame as a fault closes healthy
  // connections under load, which is the bug this case exists to prevent.
  let wire = clientFrame(OP_TEXT, "Hello");
  let step = drain(wire.slice(0, 4), newAssembly(), MAX, true);
  expect(step.what == STEP_WAIT);
  // And it gives the bytes back, so nothing is lost.
  expect(step.buffer.length == 4);
});

test("a partial frame completes once the rest arrives", () => {
  let wire = clientFrame(OP_TEXT, "Hello");
  let first = drain(wire.slice(0, 4), newAssembly(), MAX, true);
  let second = drain(first.buffer + wire.slice(4, wire.length), first.assembly, MAX, true);
  expect(second.what == STEP_MESSAGE);
  expect(second.message == "Hello");
});

test("binary keeps its opcode", () => {
  let wire = clientFrame(OP_BINARY, bytes("000102"));
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_MESSAGE);
  expect(step.opcode == OP_BINARY);
  expect(step.message.length == 3);
});

// --- several in one read --------------------------------------------------------------

test("two messages in one buffer come out one at a time", () => {
  // A single read can deliver several frames. Handling one and discarding the
  // buffer loses the second, and handling one per read stalls behind the
  // socket — so the caller loops and the rest is returned each time.
  let wire = clientFrame(OP_TEXT, "one") + clientFrame(OP_TEXT, "two");
  let first = drain(wire, newAssembly(), MAX, true);
  expect(first.what == STEP_MESSAGE);
  expect(first.message == "one");
  expect(first.buffer.length > 0);

  let second = drain(first.buffer, first.assembly, MAX, true);
  expect(second.what == STEP_MESSAGE);
  expect(second.message == "two");
  expect(second.buffer == "");

  let third = drain(second.buffer, second.assembly, MAX, true);
  expect(third.what == STEP_WAIT);
});

test("a message followed by half of the next one yields the first and keeps the rest", () => {
  let tail = clientFrame(OP_TEXT, "two");
  let wire = clientFrame(OP_TEXT, "one") + tail.slice(0, 3);
  let first = drain(wire, newAssembly(), MAX, true);
  expect(first.message == "one");
  let second = drain(first.buffer, first.assembly, MAX, true);
  expect(second.what == STEP_WAIT);
  expect(second.buffer.length == 3);
});

// --- fragmentation --------------------------------------------------------------------

test("a fragmented message is joined and delivered once", () => {
  let wire = fragment(OP_TEXT, "Hel")
    + fragment(OP_CONTINUATION, "lo ")
    + clientFrame(OP_CONTINUATION, "there");
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_MESSAGE);
  expect(step.message == "Hello there");
  expect(step.opcode == OP_TEXT);
});

test("fragments arriving in separate reads are still joined", () => {
  let head = fragment(OP_TEXT, "Hel");
  let tail = clientFrame(OP_CONTINUATION, "lo");
  let first = drain(head, newAssembly(), MAX, true);
  // Nothing to deliver yet, and the state must survive to the next call.
  expect(first.what == STEP_WAIT);
  let second = drain(tail, first.assembly, MAX, true);
  expect(second.what == STEP_MESSAGE);
  expect(second.message == "Hello");
});

test("a control frame between fragments does not corrupt the message", () => {
  // Ping is allowed to interleave. A server that lets it overwrite the
  // assembly delivers half a message and loses the rest.
  let wire = fragment(OP_TEXT, "Hel")
    + clientFrame(OP_PING, "beat")
    + clientFrame(OP_CONTINUATION, "lo");
  let first = drain(wire, newAssembly(), MAX, true);
  expect(first.what == STEP_PONG);
  expect(first.message == "beat");
  let second = drain(first.buffer, first.assembly, MAX, true);
  expect(second.what == STEP_MESSAGE);
  expect(second.message == "Hello");
});

test("a continuation with nothing to continue is a protocol error", () => {
  let wire = clientFrame(OP_CONTINUATION, "orphan");
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_FAIL);
  expect(step.error.length > 0);
});

test("a new message beginning before the last one finished is a protocol error", () => {
  let wire = fragment(OP_TEXT, "Hel") + clientFrame(OP_TEXT, "new");
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_FAIL);
});

// --- control frames -------------------------------------------------------------------

test("a ping asks for a pong carrying the same payload", () => {
  // The specification requires the payload back verbatim; a peer that checks
  // it drops a connection that echoes anything else.
  let wire = clientFrame(OP_PING, "beat");
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_PONG);
  expect(step.message == "beat");
});

test("a pong is consumed and asks for nothing", () => {
  let wire = clientFrame(OP_PONG, "beat") + clientFrame(OP_TEXT, "after");
  // It must not surface as a message, and it must not swallow what follows.
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_MESSAGE);
  expect(step.message == "after");
});

test("a lone pong leaves nothing to do", () => {
  let step = drain(clientFrame(OP_PONG, ""), newAssembly(), MAX, true);
  expect(step.what == STEP_WAIT);
});

test("a close frame reports the code the peer sent", () => {
  let wire = encodeClose(1001, "", true, bytes("37fa213d"));
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_CLOSE);
  expect(step.code == 1001);
});

test("a close with no code reads as 1005, not as zero", () => {
  // A bare close is legal. Echoing 0 back is not a valid code and some peers
  // treat it as a protocol violation.
  let step = drain(clientFrame(OP_CLOSE, ""), newAssembly(), MAX, true);
  expect(step.what == STEP_CLOSE);
  expect(step.code == 1005);
});

test("anything after a close is left alone", () => {
  let wire = encodeClose(1000, "", true, bytes("37fa213d")) + clientFrame(OP_TEXT, "late");
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_CLOSE);
  // The connection is finished; the trailing frame is not delivered.
  expect(step.buffer.length > 0);
});

// --- limits ---------------------------------------------------------------------------

test("a frame larger than the limit is refused rather than buffered", () => {
  let wire = clientFrame(OP_TEXT, "Hello");
  let step = drain(wire, newAssembly(), 2, true);
  expect(step.what == STEP_FAIL);
  expect(step.error.length > 0);
});

test("an empty buffer waits", () => {
  let step = drain("", newAssembly(), MAX, true);
  expect(step.what == STEP_WAIT);
  expect(step.buffer == "");
});

test("an unmasked frame from a client is refused", () => {
  // RFC 6455 §5.1: a server that gets one must fail the connection. Masking is
  // what stops a hostile page from steering the bytes an intermediary sees, so
  // accepting it is the hole the rule exists to close.
  let wire = encodeFrame(OP_TEXT, "Hello", false, "");
  let step = drain(wire, newAssembly(), MAX, true);
  expect(step.what == STEP_FAIL);
});

test("a masked frame from a server is refused", () => {
  // The other half of the same rule: a server must never mask, and a client
  // that tolerates it cannot tell a server from something replaying a client.
  let step = drain(clientFrame(OP_TEXT, "Hello"), newAssembly(), MAX, false);
  expect(step.what == STEP_FAIL);
});

test("a client reads an unmasked server frame", () => {
  let wire = encodeFrame(OP_TEXT, "Hello", false, "");
  let step = drain(wire, newAssembly(), MAX, false);
  expect(step.what == STEP_MESSAGE);
  expect(step.message == "Hello");
});

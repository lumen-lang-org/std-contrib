// The frame codec, against RFC 6455's own byte vectors.
//
// Section 5.7 publishes exact bytes for four frames. They are used here rather
// than values this code produced, because a codec compared against itself
// passes however wrong it is — a lesson this repository learned from a base64
// test that did exactly that.
//
//   cd packages/websocket && lumen test frame.test.ts

import { Frame, Assembly, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_CONTINUATION, CLOSE_NORMAL, encodeFrame, decodeFrame, applyMask, encodeClose, closeCodeOf, newAssembly, addFrame } from "./frame.ts";

// Bytes as hex, for comparing against the specification's tables.
function hex(s: string): string {
  const digits = "0123456789abcdef";
  let out = "";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charCodeAt(i);
    out = out + digits.charAt(c / 16) + digits.charAt(c % 16);
    i = i + 1;
  }
  return out;
}

function bytes(hexText: string): string {
  const digits = "0123456789abcdef";
  let out = "";
  let i: int = 0;
  while (i + 1 < hexText.length) {
    let hi = digits.indexOf(hexText.charAt(i));
    let lo = digits.indexOf(hexText.charAt(i + 1));
    out = out + String.fromCharCode(hi * 16 + lo);
    i = i + 2;
  }
  return out;
}

// --- RFC 6455 section 5.7 --------------------------------------------------------

test("an unmasked text frame is the bytes the RFC prints", () => {
  // A single-frame unmasked text message "Hello".
  expect(hex(encodeFrame(OP_TEXT, "Hello", false, "")) == "810548656c6c6f");
});

test("a masked text frame is the bytes the RFC prints", () => {
  // The same message masked with key 0x37fa213d.
  let key = bytes("37fa213d");
  expect(hex(encodeFrame(OP_TEXT, "Hello", true, key)) == "8185" + "37fa213d" + "7f9f4d5158");
});

test("a 256-byte payload uses the 16-bit length", () => {
  // 0x82 0x7E 0x0100, then the body.
  let body = "x".repeat(256);
  let frame = encodeFrame(OP_BINARY, body, false, "");
  expect(hex(frame.slice(0, 4)) == "827e0100");
  expect(frame.length == 4 + 256);
});

test("a 65536-byte payload uses the 64-bit length", () => {
  // 0x82 0x7F 0x0000000000010000, then the body.
  let body = "x".repeat(65536);
  let frame = encodeFrame(OP_BINARY, body, false, "");
  expect(hex(frame.slice(0, 10)) == "827f0000000000010000");
  expect(frame.length == 10 + 65536);
});

// --- masking ----------------------------------------------------------------------

test("the mask is its own inverse", () => {
  let key = bytes("37fa213d");
  let masked = applyMask("Hello", key);
  expect(hex(masked) == "7f9f4d5158");
  expect(applyMask(masked, key) == "Hello");
});

test("masking survives every byte value", () => {
  // XOR is written by hand here; a byte it gets wrong would corrupt payloads
  // silently rather than fail.
  let all = "";
  let i: int = 0;
  while (i < 256) { all = all + String.fromCharCode(i); i = i + 1; }
  let key = bytes("a13f0cd9");
  expect(applyMask(applyMask(all, key), key) == all);
});

// --- reading back ------------------------------------------------------------------

test("a frame is read back whole", () => {
  let wire = encodeFrame(OP_TEXT, "Hello", false, "");
  let got = decodeFrame(wire, 0);
  expect(got.complete);
  expect(got.fin);
  expect(got.opcode == OP_TEXT);
  expect(got.payload == "Hello");
  expect(got.consumed == wire.length);
});

test("a masked frame is unmasked on the way in", () => {
  let wire = encodeFrame(OP_TEXT, "Hello", true, bytes("37fa213d"));
  let got = decodeFrame(wire, 0);
  expect(got.complete);
  expect(got.payload == "Hello");
});

test("half a frame is not an error", () => {
  // A read returns whatever arrived. Treating a partial frame as a failure
  // would close a healthy connection on the first large message.
  let wire = encodeFrame(OP_TEXT, "Hello there", false, "");
  let half = decodeFrame(wire.slice(0, 5), 0);
  expect(!half.complete);
  expect(half.error == "");
  expect(half.consumed == 0);
  // Two bytes is not even a header.
  expect(!decodeFrame(wire.slice(0, 1), 0).complete);
});

test("two frames in one buffer are read one at a time", () => {
  let wire = encodeFrame(OP_TEXT, "one", false, "") + encodeFrame(OP_TEXT, "two", false, "");
  let first = decodeFrame(wire, 0);
  expect(first.payload == "one");
  let second = decodeFrame(wire.slice(first.consumed, wire.length), 0);
  expect(second.payload == "two");
});

test("the 16-bit and 64-bit lengths read back", () => {
  let big = encodeFrame(OP_BINARY, "y".repeat(300), false, "");
  expect(decodeFrame(big, 0).payload.length == 300);
  let huge = encodeFrame(OP_BINARY, "z".repeat(70000), false, "");
  expect(decodeFrame(huge, 0).payload.length == 70000);
});

// --- what is refused ----------------------------------------------------------------

test("a payload over the limit is refused rather than allocated", () => {
  let wire = encodeFrame(OP_BINARY, "x".repeat(500), false, "");
  let got = decodeFrame(wire, 100);
  expect(!got.complete);
  expect(got.error.indexOf("over the limit") >= 0);
});

test("an oversized control frame is a protocol error", () => {
  // The specification is explicit: at most 125 bytes, never fragmented.
  let wire = encodeFrame(OP_PING, "x".repeat(200), false, "");
  expect(decodeFrame(wire, 0).error.indexOf("125 bytes") >= 0);
});

test("a fragmented control frame is a protocol error", () => {
  // FIN cleared on a ping: build it by hand, since encodeFrame always sets FIN.
  let wire = bytes("0900");
  expect(decodeFrame(wire, 0).error.indexOf("never fragmented") >= 0);
});

// --- close ------------------------------------------------------------------------

test("a close frame carries its code big-endian", () => {
  let wire = encodeClose(CLOSE_NORMAL, "bye", false, "");
  let got = decodeFrame(wire, 0);
  expect(got.opcode == OP_CLOSE);
  expect(closeCodeOf(got.payload) == 1000);
  expect(got.payload.slice(2, got.payload.length) == "bye");
});

test("a close with no code reads as 1005, not as zero", () => {
  // 1005 is "no status received" in the specification; zero is not a code.
  expect(closeCodeOf("") == 1005);
});

// --- fragmentation ------------------------------------------------------------------

test("a fragmented message is assembled in order", () => {
  let a = newAssembly();
  let first: Frame = { complete: true, fin: false, opcode: OP_TEXT, payload: "Hel", consumed: 0, error: "" };
  let rest: Frame = { complete: true, fin: true, opcode: OP_CONTINUATION, payload: "lo", consumed: 0, error: "" };
  a = addFrame(a, first);
  expect(!a.ready);
  a = addFrame(a, rest);
  expect(a.ready);
  expect(a.message == "Hello");
  expect(a.opcode == OP_TEXT);
});

test("a control frame arriving mid-message is delivered at once", () => {
  // A ping may interleave with fragments. Buffering it would answer after the
  // message it interrupted, which is the opposite of what a heartbeat is for.
  let a = newAssembly();
  let first: Frame = { complete: true, fin: false, opcode: OP_TEXT, payload: "Hel", consumed: 0, error: "" };
  let ping: Frame = { complete: true, fin: true, opcode: OP_PING, payload: "hi", consumed: 0, error: "" };
  a = addFrame(a, first);
  let withPing = addFrame(a, ping);
  expect(withPing.ready);
  expect(withPing.opcode == OP_PING);
  // And the half-built message survives it.
  expect(withPing.pending == "Hel");
});

test("a continuation with nothing to continue is refused", () => {
  let a = newAssembly();
  let orphan: Frame = { complete: true, fin: true, opcode: OP_CONTINUATION, payload: "x", consumed: 0, error: "" };
  expect(addFrame(a, orphan).error.indexOf("nothing to continue") >= 0);
});

test("a second message before the first finished is refused", () => {
  let a = newAssembly();
  let first: Frame = { complete: true, fin: false, opcode: OP_TEXT, payload: "a", consumed: 0, error: "" };
  let second: Frame = { complete: true, fin: true, opcode: OP_TEXT, payload: "b", consumed: 0, error: "" };
  a = addFrame(a, first);
  expect(addFrame(a, second).error.indexOf("before the last one finished") >= 0);
});

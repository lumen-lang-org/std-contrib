// The wire format, byte for byte.
//
// Every expected string below was computed from the Protocol Buffers
// specification independently of this code — a codec compared against its own
// output passes however wrong it is, and a wrong varint does not fail loudly:
// the collector answers 200 and the span is silently absent.
//
//   cd packages/tracing && lumen test protobuf.test.ts

import { WIRE_VARINT, WIRE_FIXED64, WIRE_BYTES, varint, fieldTag, bytesField, varintField, fixed64Field, bytesFromHex } from "./protobuf.ts";

// Bytes as hex, so a failure prints something readable rather than control
// characters.
function hex(bytes: string): string {
  let out = "";
  let i: int = 0;
  while (i < bytes.length) {
    let b = bytes.charCodeAt(i);
    out = out + "0123456789abcdef".charAt(b / 16) + "0123456789abcdef".charAt(b % 16);
    i = i + 1;
  }
  return out;
}

// --- varints --------------------------------------------------------------------------

test("a small value is one byte", () => {
  expect(hex(varint(0)) == "00");
  expect(hex(varint(1)) == "01");
  // 127 is the largest that fits: the eighth bit is the continuation flag.
  expect(hex(varint(127)) == "7f");
});

test("the byte boundary is where varints go wrong", () => {
  // 128 is the first two-byte value. Off by one here and every field after it
  // in the message is misread.
  expect(hex(varint(128)) == "8001");
  expect(hex(varint(300)) == "ac02");
  expect(hex(varint(16384)) == "808001");
});

test("a large value keeps going, seven bits at a time", () => {
  expect(hex(varint(1000000000)) == "8094ebdc03");
  // 2^35 — past what an int holds, which is why these take an i64.
  expect(hex(varint(34359738368)) == "808080808001");
});

test("every byte but the last has its high bit set", () => {
  let out = varint(300);
  expect(out.charCodeAt(0) >= 128);
  expect(out.charCodeAt(1) < 128);
});

// --- field headers --------------------------------------------------------------------

test("a tag is the field number and the wire type in one varint", () => {
  expect(hex(fieldTag(1, WIRE_BYTES)) == "0a");
  expect(hex(fieldTag(15, WIRE_VARINT)) == "78");
});

test("field 16 is where the tag itself becomes two bytes", () => {
  // 16 << 3 is 128, so the tag varint crosses the boundary. A message with
  // fewer than sixteen fields never exercises this.
  expect(hex(fieldTag(16, WIRE_BYTES)) == "8201");
});

// --- fields ---------------------------------------------------------------------------

test("a length-delimited field is tag, length, then the bytes", () => {
  expect(hex(bytesField(1, "abc")) == "0a03616263");
});

test("an empty length-delimited field is still written", () => {
  // Not skipped: a present-but-empty string and an absent one differ, and
  // dropping it changes the message.
  expect(hex(bytesField(1, "")) == "0a00");
});

test("a varint field is tag then value", () => {
  expect(hex(varintField(3, 300)) == "18ac02");
});

test("a fixed64 is eight bytes little-endian, whatever the value", () => {
  expect(hex(fixed64Field(2, 1)) == "110100000000000000");
  expect(hex(fixed64Field(3, 1000000000)) == "1900ca9a3b00000000");
});

test("a nanosecond timestamp fills all eight bytes", () => {
  // What OTLP actually carries. Anything narrower than an i64 wraps here, and
  // a wrapped timestamp puts the span in 1970 where nobody looks for it.
  expect(hex(fixed64Field(1, 1700000000000000000)) == "0900002a36fe9c9717");
});

test("a fixed64 is eight bytes even for zero", () => {
  expect(fixed64Field(2, 0).length == 9);
  expect(hex(fixed64Field(2, 0)) == "110000000000000000");
});

// --- ids ------------------------------------------------------------------------------

test("hex becomes the bytes it stands for, not its own text", () => {
  // Sending the hex text instead gives a receiver an id of twice the width
  // that matches nothing — the whole reason this function exists.
  let out = bytesFromHex("4bf92f3577b34da6a3ce929d0e0e4736");
  expect(out.length == 16);
  expect(out.charCodeAt(0) == 75);
  expect(hex(out) == "4bf92f3577b34da6a3ce929d0e0e4736");
});

test("a span id is eight bytes", () => {
  expect(bytesFromHex("00f067aa0ba902b7").length == 8);
});

test("the high bit survives the round trip", () => {
  // A byte over 0x7f must stay one byte. Widening it here corrupts every id
  // with a high nibble above 7, which is half of them.
  expect(hex(bytesFromHex("ff00ab")) == "ff00ab");
});

test("uppercase hex reads the same as lowercase", () => {
  expect(hex(bytesFromHex("ABCDEF")) == "abcdef");
});

test("an odd trailing digit is dropped rather than guessed", () => {
  expect(hex(bytesFromHex("abc")) == "ab");
});

test("a non-hex character stops the conversion", () => {
  // Better a short id than a byte invented from a character that is not a
  // digit.
  expect(hex(bytesFromHex("abzz")) == "ab");
});

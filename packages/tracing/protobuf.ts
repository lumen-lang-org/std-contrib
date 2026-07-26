// Protocol Buffers wire format, enough of it to encode an OTLP trace.
//
// OTLP defines two encodings and lets a receiver implement either. Langfuse
// takes JSON; Phoenix answers `415 Unsupported content type: application/json`
// and takes only this one. No amount of header or attribute work reaches a
// receiver that will not parse the body, so the body has to be written both
// ways.
//
// Bytes are carried in a string, which in this language is a slice of bytes
// rather than a sequence of characters — `String.fromCharCode` writes one byte
// per code, masked to 0xFF, which is exactly a byte builder. Nothing here is
// text and none of it should be printed.

// --- the primitives ---------------------------------------------------------------

// Wire types. Only these four occur in an OTLP trace.
export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

// A base-128 varint, seven bits per byte, low group first, with the high bit
// set on every byte but the last.
export function varint(value: i64): string {
  if (value <= 0) { return String.fromCharCode(0); }
  let out = "";
  let n = value;
  while (n > 127) {
    // The low seven bits, with the continuation bit set.
    out = out + String.fromCharCode(128 + toInt(n % 128));
    n = n / 128;
  }
  return out + String.fromCharCode(toInt(n));
}

// The i64 -> int narrowing the byte writer needs.
//
// Through text, because the language has no cast between them and the
// arithmetic alternatives are worse: `as int` is a type error and `Number()`
// gives a float. Values reaching this are always below 256, so the round trip
// costs a few bytes and loses nothing.
function toInt(value: i64): int {
  return parseInt(`${value}`) ?? 0;
}

// A field header: the number and the wire type in one varint.
export function fieldTag(field: int, wire: int): string {
  return varint(field * 8 + wire);
}

// A length-delimited field: a string, a bytes value, or an embedded message.
// All three are the same on the wire, which is why one function serves.
export function bytesField(field: int, payload: string): string {
  return fieldTag(field, WIRE_BYTES) + varint(payload.length) + payload;
}

// A varint field.
export function varintField(field: int, value: i64): string {
  return fieldTag(field, WIRE_VARINT) + varint(value);
}

// A fixed 64-bit field, little-endian. OTLP carries timestamps this way, so
// they are eight bytes whatever their value.
export function fixed64Field(field: int, value: i64): string {
  let out = fieldTag(field, WIRE_FIXED64);
  let n = value;
  let i: int = 0;
  while (i < 8) {
    out = out + String.fromCharCode(byteOf(n));
    n = n / 256;
    i = i + 1;
  }
  return out;
}

// The low byte of an i64, as an int.
function byteOf(value: i64): int {
  let low = value % 256;
  if (low < 0) { low = low + 256; }
  return toInt(low);
}

// --- ids ----------------------------------------------------------------------------

// The bytes a hex string stands for. Trace and span ids are generated as hex
// and carried as hex in the JSON encoding; protobuf wants the raw bytes, and
// sending the hex text instead produces a receiver-side id of twice the width
// that matches nothing.
export function bytesFromHex(hex: string): string {
  let out = "";
  let i: int = 0;
  while (i + 1 < hex.length) {
    let hi = hexValue(hex.charAt(i));
    let lo = hexValue(hex.charAt(i + 1));
    if (hi < 0 || lo < 0) { return out; }
    out = out + String.fromCharCode(hi * 16 + lo);
    i = i + 2;
  }
  return out;
}

function hexValue(ch: string): int {
  let c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) { return c - 48; }
  if (c >= 97 && c <= 102) { return c - 87; }
  if (c >= 65 && c <= 70) { return c - 55; }
  return -1;
}

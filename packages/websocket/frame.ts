// WebSocket frames, RFC 6455 section 5.
//
// Pure: nothing here holds a socket, so every case is testable offline against
// the byte vectors the specification publishes. That matters more here than
// usual — a frame is a bit-packed header, and a wrong length prefix does not
// fail loudly, it desynchronises the stream and every frame after it is
// garbage.
//
// Bytes live in a string, which in this language is a slice of bytes;
// String.fromCharCode writes one byte per code. Nothing here is text.

//   0                   1                   2                   3
//  +-+-+-+-+-------+-+-------------+-------------------------------+
//  |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
//  |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
//  +-+-+-+-+-------+-+-------------+-------------------------------+
//  |               Masking-key, if MASK set to 1                   |
//  +---------------------------------------------------------------+

export const OP_CONTINUATION: int = 0;
export const OP_TEXT: int = 1;
export const OP_BINARY: int = 2;
export const OP_CLOSE: int = 8;
export const OP_PING: int = 9;
export const OP_PONG: int = 10;

// Close codes worth naming. 1000 is an ordinary goodbye; the rest are the ones
// this package sends.
export const CLOSE_NORMAL: int = 1000;
export const CLOSE_PROTOCOL_ERROR: int = 1002;
export const CLOSE_TOO_LARGE: int = 1009;

// A frame read off a stream.
//
// `complete` is false when the buffer holds only part of one, which is the
// ordinary case rather than an error: a read returns whatever arrived, and a
// frame spans reads. A caller keeps the buffer and reads more.
export type Frame = {
  complete: bool,
  fin: bool,
  opcode: int,
  payload: string,
  // How many bytes of the buffer this frame used. The caller drops them.
  consumed: int,
  // Set when the bytes cannot be a frame at all, which is a protocol error and
  // not something more reading will fix.
  error: string,
};

// --- writing ------------------------------------------------------------------------

// One frame. `mask` is required of a client and forbidden of a server, and
// getting that backwards is the classic failure: a browser closes the
// connection without a word, because an unmasked client frame is a protocol
// violation it must not tolerate.
export function encodeFrame(opcode: int, payload: string, mask: bool, maskKey: string): string {
  let first = 128 + opcode;
  let out = String.fromCharCode(first);
  let n = payload.length;

  let maskBit: int = 0;
  if (mask) { maskBit = 128; }

  if (n < 126) {
    out = out + String.fromCharCode(maskBit + n);
  } else if (n < 65536) {
    out = out + String.fromCharCode(maskBit + 126)
      + String.fromCharCode((n / 256) % 256) + String.fromCharCode(n % 256);
  } else {
    // 64-bit length. The top four bytes are zero: a payload that needed them
    // would be four gigabytes, and this reads whole frames into memory.
    out = out + String.fromCharCode(maskBit + 127)
      + String.fromCharCode(0) + String.fromCharCode(0)
      + String.fromCharCode(0) + String.fromCharCode(0)
      + String.fromCharCode((n / 16777216) % 256)
      + String.fromCharCode((n / 65536) % 256)
      + String.fromCharCode((n / 256) % 256)
      + String.fromCharCode(n % 256);
  }

  if (!mask) { return out + payload; }
  let key = maskKey;
  if (key.length != 4) { key = String.fromCharCode(0) + String.fromCharCode(0) + String.fromCharCode(0) + String.fromCharCode(0); }
  return out + key + applyMask(payload, key);
}

// The mask is its own inverse: the same XOR both encodes and decodes, which is
// why one function serves both directions.
export function applyMask(payload: string, key: string): string {
  if (key.length != 4) { return payload; }
  let out = "";
  let i: int = 0;
  while (i < payload.length) {
    let b = payload.charCodeAt(i);
    let k = key.charCodeAt(i % 4);
    out = out + String.fromCharCode(xorByte(b, k));
    i = i + 1;
  }
  return out;
}

// XOR of two bytes, without a bitwise operator on this type.
function xorByte(a: int, b: int): int {
  let out: int = 0;
  let bit: int = 1;
  let x = a;
  let y = b;
  let i: int = 0;
  while (i < 8) {
    let ax = x % 2;
    let by = y % 2;
    if (ax != by) { out = out + bit; }
    x = x / 2;
    y = y / 2;
    bit = bit * 2;
    i = i + 1;
  }
  return out;
}

// A close frame: a two-byte code, big-endian, then an optional reason.
export function encodeClose(code: int, reason: string, mask: bool, maskKey: string): string {
  let body = String.fromCharCode((code / 256) % 256) + String.fromCharCode(code % 256) + reason;
  return encodeFrame(OP_CLOSE, body, mask, maskKey);
}

// The code a close frame carries, or 1005 when it carries none — which the
// specification defines as "no status received" rather than an error.
export function closeCodeOf(payload: string): int {
  if (payload.length < 2) { return 1005; }
  return payload.charCodeAt(0) * 256 + payload.charCodeAt(1);
}

// --- reading ------------------------------------------------------------------------

// The frame at the front of a buffer.
//
// Returns `complete: false` when there is not enough yet. That is not a
// failure and must not be treated as one: a caller reads more and asks again.
export function decodeFrame(buffer: string, maxPayload: int): Frame {
  let partial: Frame = { complete: false, fin: false, opcode: 0, payload: "", consumed: 0, error: "" };
  if (buffer.length < 2) { return partial; }

  let b0 = buffer.charCodeAt(0);
  let b1 = buffer.charCodeAt(1);
  let fin = b0 >= 128;
  let opcode = b0 % 16;
  let masked = b1 >= 128;
  let len = b1 % 128;

  let at: int = 2;
  if (len == 126) {
    if (buffer.length < 4) { return partial; }
    len = buffer.charCodeAt(2) * 256 + buffer.charCodeAt(3);
    at = 4;
  } else if (len == 127) {
    if (buffer.length < 10) { return partial; }
    // The top four bytes are refused rather than read: a payload needing them
    // is four gigabytes, and this reads whole frames into memory. Saying so
    // beats an allocation that takes the process with it.
    if (buffer.charCodeAt(2) != 0 || buffer.charCodeAt(3) != 0
        || buffer.charCodeAt(4) != 0 || buffer.charCodeAt(5) != 0) {
      let vast: Frame = { complete: false, fin: false, opcode: 0, payload: "", consumed: 0,
        error: "a frame larger than 4 GB is refused" };
      return vast;
    }
    len = buffer.charCodeAt(6) * 16777216 + buffer.charCodeAt(7) * 65536
      + buffer.charCodeAt(8) * 256 + buffer.charCodeAt(9);
    at = 10;
  }

  if (maxPayload > 0 && len > maxPayload) {
    let big: Frame = { complete: false, fin: false, opcode: 0, payload: "", consumed: 0,
      error: "frame of " + `${len}` + " bytes is over the limit of " + `${maxPayload}` };
    return big;
  }

  // A control frame carries at most 125 bytes and is never fragmented. The
  // specification is explicit, and a peer sending otherwise is broken in a way
  // that will not improve.
  if (opcode >= 8) {
    if (len > 125) {
      let bad: Frame = { complete: false, fin: false, opcode: opcode, payload: "", consumed: 0,
        error: "a control frame carries at most 125 bytes" };
      return bad;
    }
    if (!fin) {
      let split: Frame = { complete: false, fin: false, opcode: opcode, payload: "", consumed: 0,
        error: "a control frame is never fragmented" };
      return split;
    }
  }

  let key = "";
  if (masked) {
    if (buffer.length < at + 4) { return partial; }
    key = buffer.slice(at, at + 4);
    at = at + 4;
  }

  if (buffer.length < at + len) { return partial; }
  let body = buffer.slice(at, at + len);
  if (masked) { body = applyMask(body, key); }

  let out: Frame = {
    complete: true, fin: fin, opcode: opcode, payload: body,
    consumed: at + len, error: "",
  };
  return out;
}

// --- messages -----------------------------------------------------------------------

// A message assembled from frames. A caller feeds frames in and takes messages
// out; fragmentation is this layer's business and not the reader's.
export type Assembly = {
  // The message, when one is complete.
  ready: bool,
  opcode: int,
  message: string,
  // Carried between calls: the fragments so far and what they started as.
  pending: string,
  pendingOpcode: int,
  error: string,
};

export function newAssembly(): Assembly {
  let a: Assembly = { ready: false, opcode: 0, message: "", pending: "", pendingOpcode: 0, error: "" };
  return a;
}

// Fold one frame into an assembly.
//
// A control frame passes straight through — it may arrive *between* the
// fragments of a message, which is the rule people forget, and buffering it
// would deliver a ping after the message it interrupted.
export function addFrame(state: Assembly, frame: Frame): Assembly {
  if (frame.opcode >= 8) {
    let control: Assembly = {
      ready: true, opcode: frame.opcode, message: frame.payload,
      pending: state.pending, pendingOpcode: state.pendingOpcode, error: "",
    };
    return control;
  }

  if (frame.opcode == OP_CONTINUATION) {
    if (state.pendingOpcode == 0) {
      let orphan: Assembly = {
        ready: false, opcode: 0, message: "", pending: "", pendingOpcode: 0,
        error: "a continuation frame with nothing to continue",
      };
      return orphan;
    }
    let joined = state.pending + frame.payload;
    if (!frame.fin) {
      let more: Assembly = { ready: false, opcode: 0, message: "", pending: joined, pendingOpcode: state.pendingOpcode, error: "" };
      return more;
    }
    let done: Assembly = { ready: true, opcode: state.pendingOpcode, message: joined, pending: "", pendingOpcode: 0, error: "" };
    return done;
  }

  if (state.pendingOpcode != 0) {
    let interleaved: Assembly = {
      ready: false, opcode: 0, message: "", pending: "", pendingOpcode: 0,
      error: "a new message began before the last one finished",
    };
    return interleaved;
  }

  if (frame.fin) {
    let whole: Assembly = { ready: true, opcode: frame.opcode, message: frame.payload, pending: "", pendingOpcode: 0, error: "" };
    return whole;
  }
  let started: Assembly = { ready: false, opcode: 0, message: "", pending: frame.payload, pendingOpcode: frame.opcode, error: "" };
  return started;
}

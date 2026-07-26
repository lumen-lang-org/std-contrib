// The reading loop, with the socket taken out of it.
//
// Every server here has the same inner loop: decode what the buffer holds,
// assemble frames into messages, answer pings, stop on close. Written inline
// it needs a live connection to exercise, so it was the one part of the
// package with no test — and it is the part where a protocol error hides.
//
// `drain` is that loop as a step function. It takes the bytes and the assembly
// state, returns what to do and what is left, and touches no socket. A caller
// keeps calling it until it says WAIT, then reads more.

import { Frame, Assembly, OP_CLOSE, OP_PING, OP_PONG, decodeFrame, addFrame, closeCodeOf } from "./frame.ts";

// Nothing more can be decoded — read from the socket and come back.
export const STEP_WAIT: int = 0;
// A complete message. `message` is it, `opcode` says text or binary.
export const STEP_MESSAGE: int = 1;
// A ping arrived. Answer with a pong carrying `message` verbatim: the
// specification requires the same payload back, and a peer checking it will
// drop a connection that echoes something else.
export const STEP_PONG: int = 2;
// The peer closed. `code` is what it sent, to be echoed.
export const STEP_CLOSE: int = 3;
// The peer broke the protocol. `error` says how; the connection is finished.
export const STEP_FAIL: int = 4;

export type Step = {
  what: int,
  opcode: int,
  message: string,
  code: int,
  error: string,
  // What the caller must carry into the next call.
  buffer: string,
  assembly: Assembly,
};

// One step. Returns at the first thing that needs the caller to act, so
// several frames in one buffer come out one at a time rather than as a batch
// the caller has to hold.
//
// `expectMask` says which side of the connection the caller is: a server sets
// it, because RFC 6455 requires every client frame to be masked and requires
// the connection to fail if one is not — masking is what stops a hostile page
// from steering the bytes a proxy sees. A client clears it, because a server
// must never mask.
export function drain(buffer: string, assembly: Assembly, max: int, expectMask: bool): Step {
  let rest = buffer;
  let state = assembly;

  while (true) {
    let frame = decodeFrame(rest, max);
    if (frame.error != "") { return fail(frame.error, rest, state); }
    // Half a frame is the ordinary case, not an error: a message spans reads.
    if (!frame.complete) { return waiting(rest, state); }
    if (frame.masked != expectMask) {
      if (expectMask) { return fail("a client frame must be masked", rest, state); }
      return fail("a server frame must not be masked", rest, state);
    }
    rest = rest.slice(frame.consumed, rest.length);

    state = addFrame(state, frame);
    if (state.error != "") { return fail(state.error, rest, state); }
    // A fragment that does not finish a message. Keep going — the next frame
    // may already be in the buffer.
    if (!state.ready) { continue; }

    if (state.opcode == OP_CLOSE) {
      let bye: Step = {
        what: STEP_CLOSE, opcode: OP_CLOSE, message: state.message,
        code: closeCodeOf(state.message), error: "", buffer: rest, assembly: state,
      };
      return bye;
    }
    if (state.opcode == OP_PING) {
      let pong: Step = {
        what: STEP_PONG, opcode: OP_PING, message: state.message,
        code: 0, error: "", buffer: rest, assembly: state,
      };
      return pong;
    }
    // A pong is the answer to a ping we sent. Nothing is owed for it.
    if (state.opcode == OP_PONG) { continue; }

    let out: Step = {
      what: STEP_MESSAGE, opcode: state.opcode, message: state.message,
      code: 0, error: "", buffer: rest, assembly: state,
    };
    return out;
  }
  // Unreachable: the loop above only leaves by returning. The checker does not
  // know that a `while (true)` never falls through.
  return waiting(rest, state);
}

function waiting(rest: string, state: Assembly): Step {
  let s: Step = { what: STEP_WAIT, opcode: 0, message: "", code: 0, error: "", buffer: rest, assembly: state };
  return s;
}

function fail(why: string, rest: string, state: Assembly): Step {
  let s: Step = { what: STEP_FAIL, opcode: 0, message: "", code: 0, error: why, buffer: rest, assembly: state };
  return s;
}

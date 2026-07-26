// A WebSocket client, over raw TCP.
//
//   let ws = connectWebSocket("127.0.0.1", 9001, "/chat");
//   if (ws.ok) {
//     sendText(ws, "hello");
//     let got = receive(ws);       // returns the connection with the message
//     ws = got.conn;
//   }
//
// Client frames are masked, always, with a fresh key per frame. That is not
// security — the key travels beside the payload — it exists so a proxy that
// half-understands HTTP cannot be tricked into treating a payload as a
// request. A server refuses an unmasked client frame, and rightly.
//
// No TLS: `net` has none, so `wss://` needs a terminating proxy in front.

import { Step, STEP_WAIT, STEP_MESSAGE, STEP_PONG, STEP_CLOSE, STEP_FAIL, drain } from "./session.ts";
import { Frame, Assembly, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, CLOSE_NORMAL, encodeFrame, decodeFrame, encodeClose, newAssembly, addFrame } from "./frame.ts";
import { Accepted, newKey, upgradeRequest, readAccept } from "./handshake.ts";

export type Connection = {
  socket: Socket,
  ok: bool,
  // Bytes read past the handshake, or past the last frame. A server may send
  // its first frame in the same packet as the 101, and dropping the remainder
  // loses it.
  buffer: string,
  open: bool,
  error: string,
};

// A message taken off a connection, with the connection it left behind.
//
// Returned as a pair because records are immutable: the buffer moves on and
// the open flag may change, and a caller threads the new connection into its
// next call — the same shape `Tracer` uses in the tracing package.
export type Exchange = {
  conn: Connection,
  received: Received,
};

// A message taken off a connection.
export type Received = {
  ok: bool,
  // "text", "binary" or "close".
  kind: string,
  message: string,
  error: string,
};

// Open one. The server's token is verified rather than assumed: a proxy that
// answered 101 without understanding the protocol would otherwise be sent
// frames it cannot read.
export function connectWebSocket(host: string, port: int, path: string): Connection {
  let socket = net.connect(host, port);
  let key = newKey();
  socket.write(upgradeRequest(host, port, path, key));

  let buffer = "";
  while (true) {
    let answer = readAccept(buffer, key);
    if (answer.error != "") {
      socket.close();
      let refused: Connection = { socket: socket, ok: false, buffer: "", open: false, error: answer.error };
      return refused;
    }
    if (answer.ok) {
      let out: Connection = {
        socket: socket, ok: true,
        buffer: buffer.slice(answer.consumed, buffer.length),
        open: true, error: "",
      };
      return out;
    }
    let chunk = socket.read();
    if (chunk == "") {
      socket.close();
      let dead: Connection = { socket: socket, ok: false, buffer: "", open: false,
        error: "the server closed during the handshake" };
      return dead;
    }
    buffer = buffer + chunk;
  }
  let never: Connection = { socket: socket, ok: false, buffer: "", open: false, error: "unreachable" };
  return never;
}

// A fresh mask per frame, as the RFC requires — a fixed key across a
// connection is the one thing masking is meant to prevent.
function maskKey(): string {
  let hex = crypto.randomBytes(4);
  let out = "";
  let i: int = 0;
  while (i + 1 < hex.length && out.length < 4) {
    out = out + String.fromCharCode(hexPair(hex.charAt(i), hex.charAt(i + 1)));
    i = i + 2;
  }
  while (out.length < 4) { out = out + String.fromCharCode(0); }
  return out;
}

function hexPair(hi: string, lo: string): int {
  return hexValue(hi) * 16 + hexValue(lo);
}

function hexValue(ch: string): int {
  let c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) { return c - 48; }
  if (c >= 97 && c <= 102) { return c - 87; }
  if (c >= 65 && c <= 70) { return c - 55; }
  return 0;
}

export function sendText(conn: Connection, message: string): void {
  if (!conn.open) { return; }
  conn.socket.write(encodeFrame(OP_TEXT, message, true, maskKey()));
}

export function sendBinaryFrame(conn: Connection, payload: string): void {
  if (!conn.open) { return; }
  conn.socket.write(encodeFrame(OP_BINARY, payload, true, maskKey()));
}

export function sendPing(conn: Connection, payload: string): void {
  if (!conn.open) { return; }
  conn.socket.write(encodeFrame(OP_PING, payload, true, maskKey()));
}

// Read one message, answering pings on the way.
//
// Blocks until a message arrives, the peer closes, or the connection breaks —
// a client with nothing else to do is the ordinary case, and a caller that
// needs otherwise wants a thread rather than a flag here.
export function receive(conn: Connection): Exchange {
  let assembly = newAssembly();
  let buffer = conn.buffer;
  while (true) {
    // Everything already buffered first: one read can carry several frames.
    // The framing itself is `drain`'s, in session.ts, so the client and the
    // server cannot drift apart on what a frame means — and so it can be
    // tested without a connection.
    while (true) {
      let step = drain(buffer, assembly, 8 * 1024 * 1024, false);
      buffer = step.buffer;
      assembly = step.assembly;

      if (step.what == STEP_WAIT) { break; }
      if (step.what == STEP_FAIL) {
        let broken: Received = { ok: false, kind: "", message: "", error: step.error };
        return exchange(withBuffer(conn, buffer, conn.open), broken);
      }
      if (step.what == STEP_PONG) {
        // Answered here. A heartbeat a caller has to remember is one that
        // eventually stops.
        conn.socket.write(encodeFrame(OP_PONG, step.message, true, maskKey()));
        continue;
      }
      if (step.what == STEP_CLOSE) {
        let closed: Received = { ok: true, kind: "close", message: step.message, error: "" };
        return exchange(withBuffer(conn, buffer, false), closed);
      }
      let kind = "text";
      if (step.opcode == OP_BINARY) { kind = "binary"; }
      let got: Received = { ok: true, kind: kind, message: step.message, error: "" };
      return exchange(withBuffer(conn, buffer, conn.open), got);
    }

    let chunk = conn.socket.read();
    if (chunk == "") {
      let hungUp: Received = { ok: false, kind: "", message: "", error: "the peer closed the connection" };
      return exchange(withBuffer(conn, buffer, false), hungUp);
    }
    buffer = buffer + chunk;
  }
  let never: Received = { ok: false, kind: "", message: "", error: "unreachable" };
  return exchange(conn, never);
}

function exchange(conn: Connection, received: Received): Exchange {
  let e: Exchange = { conn: conn, received: received };
  return e;
}

function withBuffer(conn: Connection, buffer: string, open: bool): Connection {
  let out: Connection = {
    socket: conn.socket, ok: conn.ok, buffer: buffer, open: open, error: conn.error,
  };
  return out;
}

// Close politely, then hang up. Waiting for an answering close from something
// that has stopped listening is how a client hangs on exit.
export function closeConnection(conn: Connection, code: int, reason: string): void {
  if (conn.open) {
    conn.socket.write(encodeClose(code, reason, true, maskKey()));
  }
  conn.socket.close();
}

// A WebSocket server, over raw TCP.
//
//   serveWebSocket(9001, (peer: Peer, message: string) => {
//     send(peer, "you said: " + message);
//   });
//
// One connection per handler call, held for its lifetime — which is what a
// WebSocket is and what makes it expensive here: the runtime's pool is sized
// for requests that end, and every open socket holds a worker. A dozen idle
// browser tabs can starve a server sized for four. That is a real limit and it
// is stated rather than discovered.
//
// No TLS: `net` has none, so `wss://` needs a terminating proxy in front.

import { Frame, Assembly, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, CLOSE_NORMAL, CLOSE_PROTOCOL_ERROR, CLOSE_TOO_LARGE, encodeFrame, decodeFrame, encodeClose, closeCodeOf, newAssembly, addFrame } from "./frame.ts";
import { Step, STEP_WAIT, STEP_MESSAGE, STEP_PONG, STEP_CLOSE, STEP_FAIL, drain } from "./session.ts";
import { Upgrade, readUpgrade, acceptResponse, refuseResponse } from "./handshake.ts";

// The largest message this will assemble. A peer that asks for more is closed
// with 1009 rather than allowed to decide how much memory this process uses.
const MAX_MESSAGE: int = 8 * 1024 * 1024;

// What a handler is given. `open` is false once either side has closed, so a
// handler that keeps one can stop writing into a dead connection.
export type Peer = {
  socket: Socket,
  path: string,
  open: bool,
};

// Send a text message. Server frames are never masked — masking one is a
// protocol violation and a browser drops the connection for it.
export function send(peer: Peer, message: string): void {
  if (!peer.open) { return; }
  peer.socket.write(encodeFrame(OP_TEXT, message, false, ""));
}

export function sendBinary(peer: Peer, payload: string): void {
  if (!peer.open) { return; }
  peer.socket.write(encodeFrame(OP_BINARY, payload, false, ""));
}

export function ping(peer: Peer, payload: string): void {
  if (!peer.open) { return; }
  peer.socket.write(encodeFrame(OP_PING, payload, false, ""));
}

// Close politely: send the frame, then hang up. A peer that never answers
// still gets disconnected — waiting for a close handshake from something that
// has stopped listening is how a server leaks connections.
export function closePeer(peer: Peer, code: int, reason: string): void {
  if (peer.open) {
    peer.socket.write(encodeClose(code, reason, false, ""));
  }
  peer.socket.close();
}

// Serve. `onMessage` is called for each complete text or binary message;
// pings are answered here, because a heartbeat a handler has to remember is a
// heartbeat that stops.
export function serveWebSocket(port: int, onMessage: (peer: Peer, message: string) => void): void {
  net.createServer(port, (socket: Socket) => {
    handleConnection(socket, onMessage);
  });
}

// One connection, start to finish.
export function handleConnection(socket: Socket, onMessage: (peer: Peer, message: string) => void): void {
  // The handshake first. A request spans reads like anything else, so this
  // accumulates until the headers are whole.
  let buffer = "";
  let upgraded: Upgrade = { ok: false, path: "", key: "", protocol: "", consumed: 0, error: "" };
  while (!upgraded.ok) {
    let chunk = socket.read();
    if (chunk == "") {
      // The peer went away mid-handshake. Nothing to say to it.
      socket.close();
      return;
    }
    buffer = buffer + chunk;
    upgraded = readUpgrade(buffer);
    if (upgraded.error != "") {
      // Whatever this is speaks HTTP, so it is answered in HTTP. A close
      // frame would be bytes it cannot read.
      socket.write(refuseResponse(upgraded.error));
      socket.close();
      return;
    }
    // A request that never ends is a request that never ends.
    if (buffer.length > 64 * 1024) {
      socket.write(refuseResponse("the request headers are too large"));
      socket.close();
      return;
    }
  }

  socket.write(acceptResponse(upgraded.key, upgraded.protocol));

  // Whatever followed the headers is already frames: a client may send its
  // first message immediately, and dropping the remainder loses it.
  buffer = buffer.slice(upgraded.consumed, buffer.length);

  let peer: Peer = { socket: socket, path: upgraded.path, open: true };
  let assembly = newAssembly();

  while (true) {
    // Everything decodable in the buffer, before reading again. A read can
    // deliver several frames at once, and handling one per read would stall
    // behind the socket.
    //
    // The decisions are `drain`'s, in session.ts, where they can be tested
    // without a connection. What is left here is only the writing.
    while (true) {
      let step = drain(buffer, assembly, MAX_MESSAGE, true);
      buffer = step.buffer;
      assembly = step.assembly;

      if (step.what == STEP_WAIT) { break; }
      if (step.what == STEP_FAIL) {
        closePeer(peer, CLOSE_PROTOCOL_ERROR, step.error);
        return;
      }
      if (step.what == STEP_CLOSE) {
        // Echo the code back and hang up: the specification asks for an
        // answering close, and a peer that gets none waits for a timeout.
        closePeer(peer, step.code, "");
        return;
      }
      if (step.what == STEP_PONG) {
        // Answered here rather than by the handler. A heartbeat somebody has
        // to remember to answer is a heartbeat that eventually stops.
        socket.write(encodeFrame(OP_PONG, step.message, false, ""));
        continue;
      }
      onMessage(peer, step.message);
    }

    let chunk = socket.read();
    if (chunk == "") {
      // The peer hung up without a close frame. Common, and not an error.
      socket.close();
      return;
    }
    buffer = buffer + chunk;
    if (buffer.length > MAX_MESSAGE + 65536) {
      closePeer(peer, CLOSE_TOO_LARGE, "message too large");
      return;
    }
  }
}

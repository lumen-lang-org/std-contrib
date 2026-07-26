// A socket.io server, over the websocket package.
//
//   serveSocketIO(9020, (client: Client, name: string, argsJson: string) => {
//     if (name == "hello") { emit(client, "greeting", "\"hi there\""); }
//   });
//
// The official browser client connects to this when told
// `transports: ["websocket"]`. It will not connect otherwise: its default is
// HTTP long-polling with an upgrade, and that transport is a stated non-goal.
//
// What a session is here: one WebSocket carrying Engine.IO packets, inside
// which Socket.IO packets carry named events. Three layers, and each one's
// framing is a separate file so a fault lands in exactly one of them.

import { Peer, send, closePeer } from "../websocket/server.ts";
import { Upgrade, readUpgrade, acceptResponse, refuseResponse } from "../websocket/handshake.ts";
import { Step, STEP_WAIT, STEP_MESSAGE, STEP_PONG, STEP_CLOSE, STEP_FAIL, drain } from "../websocket/session.ts";
import { Frame, Assembly, OP_CLOSE, OP_PING, OP_PONG, encodeFrame, decodeFrame, newAssembly, addFrame } from "../websocket/frame.ts";
import { EnginePacket, SocketPacket, EventCall, EIO_OPEN, EIO_CLOSE, EIO_PING, EIO_PONG, EIO_MESSAGE, SIO_CONNECT, SIO_DISCONNECT, SIO_EVENT, SIO_ACK, openPacket, readEnginePacket, messagePacket, eventPacket, ackPacket, connectPacket, readSocketPacket, readEvent, newSid } from "./protocol.ts";

// What the client is told to expect, and what this therefore must honour: a
// ping at least every 25s, and it may wait 20s for the pong.
const PING_INTERVAL: int = 25000;
const PING_TIMEOUT: int = 20000;
const MAX_PAYLOAD: int = 1000000;

// One connected client.
export type Client = {
  peer: Peer,
  sid: string,
  // Which namespace it joined. A client that never sent CONNECT is not yet in
  // one, and events from it are refused.
  nsp: string,
  connected: bool,
};

// Send an event. `argsJson` is a JSON fragment — the arguments after the
// name — because what a caller sends is its own shape and no record type here
// can declare it.
export function emit(client: Client, name: string, argsJson: string): void {
  send(client.peer, messagePacket(eventPacket(client.nsp, -1, name, argsJson)));
}

// Answer an event that asked to be acknowledged. The id must be the one that
// arrived; with any other, the client's callback never fires and nothing says
// why.
export function ack(client: Client, ackId: int, argsJson: string): void {
  if (ackId < 0) { return; }
  send(client.peer, messagePacket(ackPacket(client.nsp, ackId, argsJson)));
}

// The heartbeat. Engine.IO v4 has the *server* ping and the client pong, which
// is the reverse of v3 — a server that waits to be pinged is dropped after
// pingInterval + pingTimeout with nothing in any log.
export function pingClient(client: Client): void {
  send(client.peer, `${EIO_PING}`);
}

export function disconnect(client: Client): void {
  send(client.peer, messagePacket(`${SIO_DISCONNECT}`));
  closePeer(client.peer, 1000, "");
}

// Serve.
//
// The session loop is written here rather than on top of websocket's
// `serveWebSocket`, because a socket.io session has per-connection state — a
// sid, a namespace, whether CONNECT has happened — and that server's callback
// is per *message*, with nowhere to keep any of it. The state lives in local
// variables of a loop that owns the connection.
//
// That reason stands on its own. The sse package's similar-looking shape is
// not the same thing: it works around a backend rejection, now characterised
// in the comment on `serveEvents` — a closure cannot call a function value
// that arrived as a parameter. This one is a design choice about where state
// lives.
//
// The framing is still websocket's. Only the loop is here.
export function serveSocketIO(port: int, onEvent: (client: Client, name: string, argsJson: string) => void): void {
  net.createServer(port, (socket: Socket) => {
    runSession(socket, onEvent);
  });
}

function runSession(socket: Socket, onEvent: (client: Client, name: string, argsJson: string) => void): void {
  // The websocket handshake first.
  let buffer = "";
  let upgraded: Upgrade = { ok: false, path: "", key: "", protocol: "", consumed: 0, error: "" };
  while (!upgraded.ok) {
    let chunk = socket.read();
    if (chunk == "") { socket.close(); return; }
    buffer = buffer + chunk;
    upgraded = readUpgrade(buffer);
    if (upgraded.error != "") {
      socket.write(refuseResponse(upgraded.error));
      socket.close();
      return;
    }
  }
  socket.write(acceptResponse(upgraded.key, upgraded.protocol));
  buffer = buffer.slice(upgraded.consumed, buffer.length);

  let peer: Peer = { socket: socket, path: upgraded.path, open: true };
  let client = newClient(peer);
  // Engine.IO's opening packet must arrive before anything else; a client that
  // does not get it waits, then gives up without saying why.
  greet(peer, client.sid);

  let assembly = newAssembly();
  while (true) {
    // The framing decisions are `drain`'s, in the websocket package, where
    // they are tested without a connection. Only the session is here.
    while (true) {
      let step = drain(buffer, assembly, 1000000, true);
      buffer = step.buffer;
      assembly = step.assembly;

      if (step.what == STEP_WAIT) { break; }
      if (step.what == STEP_FAIL) { closePeer(peer, 1002, step.error); return; }
      if (step.what == STEP_CLOSE) { closePeer(peer, 1000, ""); return; }
      if (step.what == STEP_PONG) {
        socket.write(encodeFrame(OP_PONG, step.message, false, ""));
        continue;
      }

      client = handleMessage(client, step.message, onEvent);
      if (!client.connected && step.message.startsWith(`${EIO_CLOSE}`)) {
        socket.close();
        return;
      }
    }

    let chunk = socket.read();
    if (chunk == "") { socket.close(); return; }
    buffer = buffer + chunk;
  }
}

// What one incoming packet decides, with no socket involved.
//
// Separated from `handleMessage` so it can be tested: a Client holds a Peer
// which holds a Socket, and anything taking one needs a real connection. This
// takes the session's *values* and returns what to send and what the session
// becomes, which is the whole protocol decision and none of the I/O.
export type Decision = {
  // What to write back, "" for nothing. Already Engine.IO-framed.
  reply: string,
  nsp: string,
  connected: bool,
  // Set when the packet is an event the handler should see.
  eventName: string,
  eventArgs: string,
  // The ack id to answer with after the handler runs, -1 for none.
  ackId: int,
  // Set when the peer asked to end the session.
  closing: bool,
};

export function decide(sid: string, nsp: string, connected: bool, text: string): Decision {
  let nothing: Decision = { reply: "", nsp: nsp, connected: connected, eventName: "", eventArgs: "", ackId: -1, closing: false };

  let packet = readEnginePacket(text);
  if (!packet.ok) { return nothing; }

  // A client's pong answers our ping. Nothing to do but notice it arrived.
  if (packet.kind == EIO_PONG) { return nothing; }

  // v4 clients do not ping, but v3 ones do, and answering costs a byte.
  if (packet.kind == EIO_PING) {
    let pong: Decision = { reply: `${EIO_PONG}`, nsp: nsp, connected: connected, eventName: "", eventArgs: "", ackId: -1, closing: false };
    return pong;
  }

  if (packet.kind == EIO_CLOSE) {
    let bye: Decision = { reply: "", nsp: nsp, connected: false, eventName: "", eventArgs: "", ackId: -1, closing: true };
    return bye;
  }

  if (packet.kind != EIO_MESSAGE) { return nothing; }

  let sio = readSocketPacket(packet.body);
  if (!sio.ok) { return nothing; }

  if (sio.kind == SIO_CONNECT) {
    // Answering with the session id is what modern clients expect; one that
    // gets a bare `40` believes it belongs to no session and cannot reconnect
    // into it.
    let joined: Decision = {
      reply: messagePacket(connectPacket(sio.nsp, sid)),
      nsp: sio.nsp, connected: true, eventName: "", eventArgs: "", ackId: -1, closing: false,
    };
    return joined;
  }

  if (sio.kind == SIO_DISCONNECT) {
    let left: Decision = { reply: "", nsp: nsp, connected: false, eventName: "", eventArgs: "", ackId: -1, closing: false };
    return left;
  }

  if (sio.kind == SIO_EVENT) {
    // An event before CONNECT is a client that has not joined. There is
    // nowhere to reply to it, so it is dropped and the connection left alone.
    if (!connected) { return nothing; }
    let call = readEvent(sio.payload);
    if (!call.ok) { return nothing; }
    let fire: Decision = {
      reply: "", nsp: nsp, connected: true,
      eventName: call.name, eventArgs: call.argsJson, ackId: sio.ackId, closing: false,
    };
    return fire;
  }

  return nothing;
}

// The same decision, applied to a live client.
export function handleMessage(client: Client, text: string, onEvent: (client: Client, name: string, argsJson: string) => void): Client {
  let d = decide(client.sid, client.nsp, client.connected, text);
  if (d.reply != "") { send(client.peer, d.reply); }

  let next: Client = { peer: client.peer, sid: client.sid, nsp: d.nsp, connected: d.connected };
  if (d.eventName != "") {
    onEvent(next, d.eventName, d.eventArgs);
    // An event that asked for acknowledgement and got none leaves the
    // client's callback pending forever, so an empty ack is sent when the
    // handler did not.
    if (d.ackId >= 0) { ack(next, d.ackId, ""); }
  }
  return next;
}

// The opening packet a client must receive before anything else.
export function greet(peer: Peer, sid: string): void {
  send(peer, openPacket(sid, PING_INTERVAL, PING_TIMEOUT, MAX_PAYLOAD));
}

export function newClient(peer: Peer): Client {
  let c: Client = { peer: peer, sid: newSid(), nsp: "/", connected: false };
  return c;
}

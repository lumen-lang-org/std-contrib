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
// That reason stands on its own, unlike the reshuffling in the sse package,
// which works around a backend rejection nobody has reduced.
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
    while (true) {
      let frame = decodeFrame(buffer, 1000000);
      if (frame.error != "") { closePeer(peer, 1002, frame.error); return; }
      if (!frame.complete) { break; }
      buffer = buffer.slice(frame.consumed, buffer.length);

      assembly = addFrame(assembly, frame);
      if (assembly.error != "") { closePeer(peer, 1002, assembly.error); return; }
      if (!assembly.ready) { continue; }

      if (assembly.opcode == OP_CLOSE) { closePeer(peer, 1000, ""); return; }
      if (assembly.opcode == OP_PING) {
        socket.write(encodeFrame(OP_PONG, assembly.message, false, ""));
        continue;
      }
      if (assembly.opcode == OP_PONG) { continue; }

      client = handleMessage(client, assembly.message, onEvent);
      if (!client.connected && assembly.message.startsWith(`${EIO_CLOSE}`)) {
        socket.close();
        return;
      }
    }

    let chunk = socket.read();
    if (chunk == "") { socket.close(); return; }
    buffer = buffer + chunk;
  }
}

// A run of one client's session, driven by the websocket server's callback.
//
// State lives in the session table rather than in a closure: this language's
// records are immutable and its callbacks cannot hold one, so a connection's
// sid and namespace are looked up by peer path on each message. A single
// server hosting one namespace is the case this is built for.
export function handleMessage(client: Client, text: string, onEvent: (client: Client, name: string, argsJson: string) => void): Client {
  let packet = readEnginePacket(text);
  if (!packet.ok) { return client; }

  // A client's pong answers our ping. Nothing to do but notice it arrived.
  if (packet.kind == EIO_PONG) { return client; }

  // v4 clients do not ping, but v3 ones do, and answering costs a byte.
  if (packet.kind == EIO_PING) {
    send(client.peer, `${EIO_PONG}`);
    return client;
  }

  if (packet.kind == EIO_CLOSE) {
    let gone: Client = { peer: client.peer, sid: client.sid, nsp: client.nsp, connected: false };
    return gone;
  }

  if (packet.kind != EIO_MESSAGE) { return client; }

  let sio = readSocketPacket(packet.body);
  if (!sio.ok) { return client; }

  if (sio.kind == SIO_CONNECT) {
    // The client is joining a namespace. Answering with its session id is what
    // modern clients expect; one that gets a bare `40` believes it belongs to
    // no session and cannot reconnect into it.
    let joined: Client = { peer: client.peer, sid: client.sid, nsp: sio.nsp, connected: true };
    send(joined.peer, messagePacket(connectPacket(sio.nsp, joined.sid)));
    return joined;
  }

  if (sio.kind == SIO_DISCONNECT) {
    let left: Client = { peer: client.peer, sid: client.sid, nsp: client.nsp, connected: false };
    return left;
  }

  if (sio.kind == SIO_EVENT) {
    if (!client.connected) {
      // An event before CONNECT is a client that has not joined. Ignoring it
      // silently would look like a lost message; there is nowhere to reply to
      // it, so it is dropped and the connection left alone.
      return client;
    }
    let call = readEvent(sio.payload);
    if (!call.ok) { return client; }
    // The ack id travels with the event and must come back on the reply, so it
    // is carried on the client the handler is given.
    let asked: Client = { peer: client.peer, sid: client.sid, nsp: client.nsp, connected: true };
    onEvent(asked, call.name, call.argsJson);
    // An event that asked for an acknowledgement and got none leaves the
    // client's callback pending forever, so an empty ack is sent when the
    // handler did not.
    if (sio.ackId >= 0) { ack(asked, sio.ackId, ""); }
    return asked;
  }

  return client;
}

// The opening packet a client must receive before anything else.
export function greet(peer: Peer, sid: string): void {
  send(peer, openPacket(sid, PING_INTERVAL, PING_TIMEOUT, MAX_PAYLOAD));
}

export function newClient(peer: Peer): Client {
  let c: Client = { peer: peer, sid: newSid(), nsp: "/", connected: false };
  return c;
}

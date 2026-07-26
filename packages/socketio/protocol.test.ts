// The wire strings, against the ones socket.io's own protocol document prints.
//
// Every literal below is from that document rather than from this code. A
// codec compared to its own output passes however wrong it is.
//
//   cd packages/socketio && lumen test protocol.test.ts

import { EnginePacket, SocketPacket, EventCall, EIO_OPEN, EIO_PING, EIO_PONG, EIO_MESSAGE, SIO_CONNECT, SIO_EVENT, SIO_ACK, openPacket, readEnginePacket, messagePacket, encodePacket, eventPacket, ackPacket, connectPacket, readSocketPacket, readEvent, newSid } from "./protocol.ts";

// --- Engine.IO ------------------------------------------------------------------------

test("the open packet is type 0 and a JSON handshake", () => {
  let out = openPacket("lv_VI97HAXpY6yYWAAAC", 25000, 20000, 1000000);
  expect(out.startsWith("0{"));
  expect(out.indexOf("\"sid\":\"lv_VI97HAXpY6yYWAAAC\"") >= 0);
  // These are a contract: the client times out on interval + timeout, so a
  // server that sends values it does not honour dies every 45 seconds for no
  // visible reason.
  expect(out.indexOf("\"pingInterval\":25000") >= 0);
  expect(out.indexOf("\"pingTimeout\":20000") >= 0);
  // Already WebSocket: offering an upgrade to WebSocket is what a polling
  // server does.
  expect(out.indexOf("\"upgrades\":[]") >= 0);
});

test("ping and pong are a single digit each", () => {
  expect(readEnginePacket("2").kind == EIO_PING);
  expect(readEnginePacket("3").kind == EIO_PONG);
  expect(readEnginePacket("2").body == "");
});

test("a message is type 4 and everything after it", () => {
  let p = readEnginePacket("42[\"hello\"]");
  expect(p.ok);
  expect(p.kind == EIO_MESSAGE);
  expect(p.body == "2[\"hello\"]");
  expect(messagePacket("2[\"hello\"]") == "42[\"hello\"]");
});

test("something that is not a packet is refused rather than guessed", () => {
  expect(!readEnginePacket("").ok);
  expect(!readEnginePacket("x").ok);
});

// --- Socket.IO ------------------------------------------------------------------------

test("an event on the default namespace is 2 then a JSON array", () => {
  // The protocol document's own example.
  expect(eventPacket("/", -1, "hello", "\"world\"") == "2[\"hello\",\"world\"]");
});

test("a namespace comes before the payload and ends with a comma", () => {
  expect(eventPacket("/admin", -1, "project:delete", "123") == "2/admin,[\"project:delete\",123]");
});

test("an ack id follows the namespace", () => {
  expect(eventPacket("/admin", 456, "project:delete", "123") == "2/admin,456[\"project:delete\",123]");
  expect(ackPacket("/admin", 456, "true") == "3/admin,456[true]");
});

test("connect carries a sid, because a bare 40 leaves the client sessionless", () => {
  expect(connectPacket("/", "oSO0OpakMV_3jnilAAAA") == "0{\"sid\":\"oSO0OpakMV_3jnilAAAA\"}");
  expect(connectPacket("/admin", "x") == "0/admin,{\"sid\":\"x\"}");
});

// --- reading them back ------------------------------------------------------------------

test("a plain event reads back with no namespace and no ack", () => {
  let p = readSocketPacket("2[\"hello\",\"world\"]");
  expect(p.ok);
  expect(p.kind == SIO_EVENT);
  expect(p.nsp == "/");
  expect(p.ackId == -1);
  expect(p.payload == "[\"hello\",\"world\"]");
});

test("a namespace is not mistaken for an ack id", () => {
  // Both are optional and adjacent; a parser that guesses reads "/admin" as
  // an ack. The comma is what separates them.
  let p = readSocketPacket("2/admin,456[\"x\"]");
  expect(p.nsp == "/admin");
  expect(p.ackId == 456);
  expect(p.payload == "[\"x\"]");
});

test("an ack id without a namespace still reads", () => {
  let p = readSocketPacket("3456[\"done\"]");
  expect(p.kind == SIO_ACK);
  expect(p.nsp == "/");
  expect(p.ackId == 456);
});

test("a namespace with no payload is still a namespace", () => {
  // "40/admin" — a client joining a namespace and sending nothing.
  let p = readSocketPacket("0/admin");
  expect(p.ok);
  expect(p.kind == SIO_CONNECT);
  expect(p.nsp == "/admin");
  expect(p.payload == "");
});

test("everything this encodes, it reads back", () => {
  let wire = eventPacket("/room", 9, "msg", "{\"a\":1}");
  let p = readSocketPacket(wire);
  expect(p.nsp == "/room");
  expect(p.ackId == 9);
  let call = readEvent(p.payload);
  expect(call.ok);
  expect(call.name == "msg");
  expect(call.argsJson == "{\"a\":1}");
});

// --- event payloads ---------------------------------------------------------------------

test("the event name is the first string, the rest are arguments", () => {
  let call = readEvent("[\"hello\",\"world\",42]");
  expect(call.ok);
  expect(call.name == "hello");
  expect(call.argsJson == "\"world\",42");
});

test("an event with no arguments has a name and nothing else", () => {
  let call = readEvent("[\"ping\"]");
  expect(call.ok);
  expect(call.name == "ping");
  expect(call.argsJson == "");
});

test("a quote or a colon inside the name does not end it", () => {
  let call = readEvent("[\"project:delete\"]");
  expect(call.name == "project:delete");
  let escaped = readEvent("[\"say \\\"hi\\\"\",1]");
  expect(escaped.name == "say \"hi\"");
  expect(escaped.argsJson == "1");
});

test("a payload that is not an event array is refused", () => {
  expect(!readEvent("{\"sid\":\"x\"}").ok);
  expect(!readEvent("").ok);
  expect(!readEvent("[42]").ok);
});

test("session ids differ", () => {
  expect(newSid() != newSid());
});

// The session loop's decisions, without a connection.
//
// `handleMessage` cannot be tested directly — it takes a Client, which holds a
// Peer, which holds a real Socket. `decide` is the same logic over plain
// values, and these are the cases the browser exercised by hand:
//
//   cd packages/socketio && lumen test server.test.ts

import { Decision, decide } from "./server.ts";
import { EIO_PONG, SIO_CONNECT, SIO_EVENT } from "./protocol.ts";

const SID: string = "lv_VI97HAXpY6yYWAAAC";

// --- the heartbeat --------------------------------------------------------------------

test("a client's pong is noticed and answered with nothing", () => {
  let d = decide(SID, "/", true, "3");
  expect(d.reply == "");
  expect(d.connected);
  expect(d.eventName == "");
});

test("a v3 client's ping is answered with a pong", () => {
  // v4 clients do not ping — the server does — but v3 ones do, and a server
  // that ignores it is dropped by a client that predates the reversal.
  let d = decide(SID, "/", true, "2");
  expect(d.reply == "3");
  expect(d.connected);
});

test("engine.io close ends the session", () => {
  let d = decide(SID, "/", true, "1");
  expect(d.closing);
  expect(!d.connected);
});

// --- joining --------------------------------------------------------------------------

test("CONNECT is answered with the session id, not a bare 40", () => {
  let d = decide(SID, "/", false, "40");
  // A client that gets `40` with no sid treats the connection as belonging to
  // no session and cannot reconnect into it.
  expect(d.reply == "40{\"sid\":\"lv_VI97HAXpY6yYWAAAC\"}");
  expect(d.connected);
  expect(d.nsp == "/");
});

test("CONNECT to a namespace joins that namespace and echoes it back", () => {
  let d = decide(SID, "/", false, "40/admin,");
  expect(d.nsp == "/admin");
  expect(d.connected);
  expect(d.reply == "40/admin,{\"sid\":\"lv_VI97HAXpY6yYWAAAC\"}");
});

test("socket.io DISCONNECT leaves the namespace but does not close the transport", () => {
  let d = decide(SID, "/", true, "41");
  expect(!d.connected);
  // Engine.IO close sets `closing`; this does not — the socket stays up and
  // the client may CONNECT again.
  expect(!d.closing);
});

// --- events ---------------------------------------------------------------------------

test("an event reaches the handler with its name and arguments", () => {
  let d = decide(SID, "/", true, "42[\"hello\",\"world\"]");
  expect(d.eventName == "hello");
  expect(d.eventArgs == "\"world\"");
  expect(d.ackId == -1);
  expect(d.reply == "");
});

test("an event with several arguments keeps them as one JSON fragment", () => {
  let d = decide(SID, "/", true, "42[\"add\",1,2]");
  expect(d.eventName == "add");
  expect(d.eventArgs == "1,2");
});

test("an event with no arguments has an empty fragment", () => {
  let d = decide(SID, "/", true, "42[\"ping\"]");
  expect(d.eventName == "ping");
  expect(d.eventArgs == "");
});

test("an event that asked for an ack carries the id back", () => {
  let d = decide(SID, "/", true, "427[\"add\",1,2]");
  expect(d.eventName == "add");
  // The id must be the one that arrived. With any other, the client's callback
  // never fires and nothing says why.
  expect(d.ackId == 7);
});

test("an event before CONNECT is dropped", () => {
  // There is no namespace to answer in, so the packet is ignored and the
  // connection left alone rather than closed.
  let d = decide(SID, "/", false, "42[\"hello\",\"world\"]");
  expect(d.eventName == "");
  expect(!d.connected);
  expect(d.reply == "");
});

test("an event in a joined namespace stays in it", () => {
  let d = decide(SID, "/admin", true, "42/admin,[\"hello\"]");
  expect(d.eventName == "hello");
  expect(d.nsp == "/admin");
});

// --- what must not happen -------------------------------------------------------------

test("an empty message changes nothing", () => {
  let d = decide(SID, "/admin", true, "");
  expect(d.eventName == "");
  expect(d.nsp == "/admin");
  expect(d.connected);
  expect(!d.closing);
});

test("a packet whose first byte is not a digit changes nothing", () => {
  let d = decide(SID, "/", true, "xyz");
  expect(d.eventName == "");
  expect(d.reply == "");
});

test("a MESSAGE with an empty socket.io payload changes nothing", () => {
  let d = decide(SID, "/", true, "4");
  expect(d.eventName == "");
  expect(d.reply == "");
});

test("an EVENT whose payload is not a JSON array is dropped", () => {
  let d = decide(SID, "/", true, "42notjson");
  expect(d.eventName == "");
  expect(d.connected);
});

test("an ACK from the client is not mistaken for an event", () => {
  // Type 3 is the client acknowledging something we sent. Nothing to deliver.
  let d = decide(SID, "/", true, "437[]");
  expect(d.eventName == "");
  expect(d.reply == "");
});

test("upgrade and noop packets are ignored", () => {
  // 5 and 6 belong to the polling transport's upgrade dance, which is a stated
  // non-goal. They must not be read as messages.
  let up = decide(SID, "/", true, "5");
  expect(up.reply == "");
  expect(up.eventName == "");
  let noop = decide(SID, "/", true, "6");
  expect(noop.reply == "");
  expect(noop.eventName == "");
});

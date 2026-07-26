// The upgrade, against RFC 6455 section 1.3's worked example.
//
//   cd packages/websocket && lumen test handshake.test.ts

import { Upgrade, Accepted, acceptFor, readUpgrade, acceptResponse, refuseResponse, firstProtocol, newKey, upgradeRequest, readAccept } from "./handshake.ts";

// The request the RFC prints, with the key it prints.
function rfcRequest(): string {
  return "GET /chat HTTP/1.1\r\n"
    + "Host: server.example.com\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    + "Sec-WebSocket-Version: 13\r\n\r\n";
}

test("the accept token is the one the RFC prints", () => {
  // Section 1.3: key dGhlIHNhbXBsZSBub25jZQ== answers s3pPLMBiTxaQ9kYGzzhZRbK+xOo=.
  // A browser compares this exactly and closes the connection on any other
  // value, so it is checked against the specification rather than against
  // whatever this code produces.
  expect(acceptFor("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("the RFC's request is read", () => {
  let up = readUpgrade(rfcRequest());
  expect(up.ok);
  expect(up.path == "/chat");
  expect(up.key == "dGhlIHNhbXBsZSBub25jZQ==");
  expect(up.consumed == rfcRequest().length);
});

test("half a request is not a malformed one", () => {
  // Requests span reads. Refusing here would turn a slow link into a broken
  // client.
  let half = rfcRequest().slice(0, 40);
  let up = readUpgrade(half);
  expect(!up.ok);
  expect(up.error == "");
});

test("header names are matched however they are cased", () => {
  let odd = "GET / HTTP/1.1\r\nUPGRADE: WebSocket\r\nCONNECTION: Upgrade\r\n"
    + "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
  expect(readUpgrade(odd).ok);
});

test("Connection may list Upgrade among others", () => {
  // "keep-alive, Upgrade" is what several clients send, and an exact match
  // would refuse them.
  let listed = "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
  expect(readUpgrade(listed).ok);
});

test("what is refused, and why, in words", () => {
  let post = "POST / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
  expect(readUpgrade(post).error.indexOf("is a GET") >= 0);

  let plain = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
  expect(readUpgrade(plain).error.indexOf("not a websocket upgrade") >= 0);

  let noKey = "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n";
  expect(readUpgrade(noKey).error.indexOf("no Sec-WebSocket-Key") >= 0);

  // An old draft asks for a version this cannot speak; saying so beats
  // framing bytes it will not understand.
  let old = "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n\r\n";
  expect(readUpgrade(old).error.indexOf("version 13") >= 0);
});

test("frames sent straight after the request are left in the buffer", () => {
  // A client may send its first frame immediately. Consuming it with the
  // headers would lose the first message of every fast client.
  let withFrame = rfcRequest() + "EXTRA";
  let up = readUpgrade(withFrame);
  expect(up.ok);
  expect(up.consumed == withFrame.length - 5);
});

// --- the answer -------------------------------------------------------------------

test("the 101 carries the accept token and the required headers", () => {
  let out = acceptResponse("dGhlIHNhbXBsZSBub25jZQ==", "");
  expect(out.indexOf("HTTP/1.1 101 Switching Protocols") == 0);
  expect(out.indexOf("Upgrade: websocket") >= 0);
  expect(out.indexOf("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") >= 0);
  expect(out.endsWith("\r\n\r\n"));
});

test("a sub-protocol is echoed only when one was offered, and only one", () => {
  // Answering with a protocol the client never offered is a violation.
  expect(acceptResponse("k", "").indexOf("Sec-WebSocket-Protocol") < 0);
  let chosen = acceptResponse("k", "chat, superchat");
  expect(chosen.indexOf("Sec-WebSocket-Protocol: chat") >= 0);
  expect(firstProtocol("chat, superchat") == "chat");
  expect(firstProtocol("solo") == "solo");
});

test("a refusal is plain HTTP, because the peer is speaking HTTP", () => {
  let out = refuseResponse("no Sec-WebSocket-Key");
  expect(out.indexOf("400 Bad Request") >= 0);
  expect(out.indexOf("Content-Length:") >= 0);
  expect(out.indexOf("no Sec-WebSocket-Key") >= 0);
});

// --- the client's half --------------------------------------------------------------

test("a key is 16 random bytes in base64, and differs each time", () => {
  // 16 bytes base64 is 24 characters ending in one pad. crypto.randomBytes
  // hands back hex despite its name, and base64 of that text would be 44
  // characters decoding to 32 bytes — which the RFC says is wrong and a
  // strict server may refuse.
  let a = newKey();
  let b = newKey();
  expect(a.length == 24);
  expect(a.endsWith("="));
  expect(crypto.base64Decode(a).length == 16);
  expect(a != b);
});

test("the request a client sends carries what a server checks for", () => {
  let out = upgradeRequest("localhost", 9001, "/chat", "dGhlIHNhbXBsZSBub25jZQ==");
  let back = readUpgrade(out);
  expect(back.ok);
  expect(back.path == "/chat");
  expect(out.indexOf("Sec-WebSocket-Version: 13") >= 0);
});

test("a client verifies the token rather than trusting the 101", () => {
  // A proxy answering 101 without understanding the protocol would otherwise
  // be talked to in frames it cannot read.
  let key = "dGhlIHNhbXBsZSBub25jZQ==";
  let good = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
    + "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
  expect(readAccept(good, key).ok);

  let wrong = "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: nonsense=\r\n\r\n";
  expect(readAccept(wrong, key).error.indexOf("does not answer our key") >= 0);

  let refused = "HTTP/1.1 404 Not Found\r\n\r\n";
  expect(readAccept(refused, key).error.indexOf("404") >= 0);

  // Still arriving is not a refusal.
  expect(readAccept("HTTP/1.1 101 Switch", key).error == "");
});

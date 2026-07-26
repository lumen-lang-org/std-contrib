// The upgrade, RFC 6455 section 4.
//
// A WebSocket begins as an ordinary HTTP request that asks to stop being one.
// The server answers with 101 and a token proving it understood; a browser
// that receives anything else closes the connection without explanation, so
// every value here is exact rather than approximately right.

// The constant is from the RFC. It is not a secret and not a salt — it exists
// so a server cannot answer the handshake by echoing, which would let a
// cache or a proxy that knows nothing of WebSocket appear to succeed.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type Upgrade = {
  ok: bool,
  // The path asked for, so one server can host several endpoints.
  path: string,
  key: string,
  // What sub-protocol the client offered, "" when none.
  protocol: string,
  // How much of the buffer the request used — anything after it is the first
  // frames, which a client is allowed to send immediately.
  consumed: int,
  error: string,
};

// The token that answers a key. base64 of the SHA-1 digest — of the *digest*,
// not of its hex spelling, which is the mistake that costs an afternoon
// because both are plausible-looking strings of the wrong length.
export function acceptFor(key: string): string {
  return crypto.base64Encode(crypto.sha1Bytes(key + WS_GUID));
}

// Read an upgrade request out of whatever has arrived.
//
// Returns ok=false with no error while the headers are still incomplete: a
// request spans reads like anything else, and treating a partial one as
// malformed would refuse every client on a slow link.
export function readUpgrade(buffer: string): Upgrade {
  let waiting: Upgrade = { ok: false, path: "", key: "", protocol: "", consumed: 0, error: "" };
  let end = buffer.indexOf("\r\n\r\n");
  if (end < 0) { return waiting; }

  let head = buffer.slice(0, end);
  let lines = head.split("\r\n");
  if (lines.length < 1) { return waiting; }

  // GET /path HTTP/1.1
  let parts = lines[0].split(" ");
  if (parts.length < 3 || parts[0] != "GET") {
    let notGet: Upgrade = { ok: false, path: "", key: "", protocol: "", consumed: 0,
      error: "an upgrade is a GET, not " + parts[0] };
    return notGet;
  }

  let key = "";
  let upgrade = "";
  let connection = "";
  let version = "";
  let protocol = "";
  let i: int = 1;
  while (i < lines.length) {
    let at = lines[i].indexOf(":");
    if (at > 0) {
      // Header names are case-insensitive and clients disagree about which
      // case they use, so they are compared lowered.
      let name = lines[i].slice(0, at).trim().toLowerCase();
      let value = lines[i].slice(at + 1, lines[i].length).trim();
      if (name == "sec-websocket-key") { key = value; }
      else if (name == "upgrade") { upgrade = value.toLowerCase(); }
      else if (name == "connection") { connection = value.toLowerCase(); }
      else if (name == "sec-websocket-version") { version = value; }
      else if (name == "sec-websocket-protocol") { protocol = value; }
    }
    i = i + 1;
  }

  if (upgrade != "websocket") {
    let notWs: Upgrade = { ok: false, path: parts[1], key: "", protocol: "", consumed: 0,
      error: "not a websocket upgrade" };
    return notWs;
  }
  // Connection may be "Upgrade" or a list containing it — "keep-alive, Upgrade"
  // is what several clients send.
  if (connection.indexOf("upgrade") < 0) {
    let noConn: Upgrade = { ok: false, path: parts[1], key: "", protocol: "", consumed: 0,
      error: "the Connection header does not ask to upgrade" };
    return noConn;
  }
  if (key == "") {
    let noKey: Upgrade = { ok: false, path: parts[1], key: "", protocol: "", consumed: 0,
      error: "no Sec-WebSocket-Key" };
    return noKey;
  }
  // 13 is the only version this protocol has. An older draft asked for
  // something this cannot speak, and saying so beats framing garbage at it.
  if (version != "13") {
    let oldVersion: Upgrade = { ok: false, path: parts[1], key: "", protocol: "", consumed: 0,
      error: "this speaks websocket version 13, not \"" + version + "\"" };
    return oldVersion;
  }

  let out: Upgrade = {
    ok: true, path: parts[1], key: key, protocol: protocol,
    consumed: end + 4, error: "",
  };
  return out;
}

// The 101 that accepts an upgrade.
export function acceptResponse(key: string, protocol: string): string {
  let out = "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + "Sec-WebSocket-Accept: " + acceptFor(key) + "\r\n";
  // Echoed only when one was asked for, and only ever one: answering with a
  // protocol the client did not offer is a violation.
  if (protocol != "") { out = out + "Sec-WebSocket-Protocol: " + firstProtocol(protocol) + "\r\n"; }
  return out + "\r\n";
}

// The first of a comma-separated offer.
export function firstProtocol(offered: string): string {
  let at = offered.indexOf(",");
  if (at < 0) { return offered.trim(); }
  return offered.slice(0, at).trim();
}

// The refusal. A plain HTTP response, because whatever sent this is speaking
// HTTP and will not understand a close frame.
export function refuseResponse(why: string): string {
  let body = "This endpoint speaks WebSocket: " + why;
  return "HTTP/1.1 400 Bad Request\r\n"
    + "Content-Type: text/plain\r\n"
    + "Content-Length: " + `${body.length}` + "\r\n"
    + "Connection: close\r\n\r\n" + body;
}

// --- the client's half ----------------------------------------------------------

// A key is 16 random bytes, base64 — 24 characters. Random per connection, so
// a proxy cannot replay one server's answer at another.
//
// `crypto.randomBytes(16)` hands back 32 *hex characters*, not 16 bytes,
// which the name does not suggest. Base64 of that text is 44 characters and
// decodes to 32 bytes, and the RFC says the decoded key is 16 — a strict
// server is entitled to refuse it. So the hex is converted back to the bytes
// it stands for.
export function newKey(): string {
  return crypto.base64Encode(bytesFromHex(crypto.randomBytes(16)));
}

// The bytes a hex string stands for.
function bytesFromHex(hex: string): string {
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

export function upgradeRequest(host: string, port: int, path: string, key: string): string {
  return "GET " + path + " HTTP/1.1\r\n"
    + "Host: " + host + ":" + `${port}` + "\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + "Sec-WebSocket-Key: " + key + "\r\n"
    + "Sec-WebSocket-Version: 13\r\n\r\n";
}

export type Accepted = {
  ok: bool,
  consumed: int,
  error: string,
};

// Check a server's answer. The Accept token is verified rather than assumed:
// a proxy that returned 101 without understanding the protocol would
// otherwise be talked to in frames it cannot read.
export function readAccept(buffer: string, key: string): Accepted {
  let waiting: Accepted = { ok: false, consumed: 0, error: "" };
  let end = buffer.indexOf("\r\n\r\n");
  if (end < 0) { return waiting; }

  let head = buffer.slice(0, end);
  let lines = head.split("\r\n");
  if (lines[0].indexOf("101") < 0) {
    let refused: Accepted = { ok: false, consumed: 0, error: "the server answered " + lines[0] };
    return refused;
  }

  let accept = "";
  let i: int = 1;
  while (i < lines.length) {
    let at = lines[i].indexOf(":");
    if (at > 0 && lines[i].slice(0, at).trim().toLowerCase() == "sec-websocket-accept") {
      accept = lines[i].slice(at + 1, lines[i].length).trim();
    }
    i = i + 1;
  }
  if (accept != acceptFor(key)) {
    let wrong: Accepted = { ok: false, consumed: 0,
      error: "the server's Sec-WebSocket-Accept does not answer our key" };
    return wrong;
  }
  let out: Accepted = { ok: true, consumed: end + 4, error: "" };
  return out;
}

// The socket.io wire protocol: two layers, both text, one inside the other.
//
//   "42[\"hello\",\"world\"]"
//    ││ └─ Socket.IO EVENT payload, a JSON array: name then arguments
//    │└─── Socket.IO packet type 2 = EVENT
//    └──── Engine.IO packet type 4 = MESSAGE
//
// Engine.IO is the transport: it opens a session, keeps it alive with a
// heartbeat, and carries opaque messages. Socket.IO is what those messages
// mean: named events, namespaces and acknowledgements.
//
// Only the WebSocket transport is targeted. Engine.IO's default is HTTP
// long-polling with an upgrade dance, and implementing that is a large amount
// of work for a fallback nothing here needs — a client is told
// `transports: ["websocket"]`. That is a stated non-goal, not an omission.

// --- Engine.IO -----------------------------------------------------------------------

export const EIO_OPEN: int = 0;
export const EIO_CLOSE: int = 1;
export const EIO_PING: int = 2;
export const EIO_PONG: int = 3;
export const EIO_MESSAGE: int = 4;
export const EIO_UPGRADE: int = 5;
export const EIO_NOOP: int = 6;

// --- Socket.IO -----------------------------------------------------------------------

export const SIO_CONNECT: int = 0;
export const SIO_DISCONNECT: int = 1;
export const SIO_EVENT: int = 2;
export const SIO_ACK: int = 3;
export const SIO_CONNECT_ERROR: int = 4;

// The handshake a client receives the moment the transport opens.
//
// `pingInterval` and `pingTimeout` are a contract, not advice: the client
// starts a timer from them, and a server that then fails to ping within
// interval + timeout is dropped. Sending values you do not honour is how a
// connection dies every 45 seconds for no visible reason.
//
// `upgrades` is empty because this is already WebSocket — offering an upgrade
// from WebSocket to WebSocket is what a polling server does.
export function openPacket(sid: string, pingInterval: int, pingTimeout: int, maxPayload: int): string {
  return `${EIO_OPEN}` + "{\"sid\":" + JSON.stringify(sid)
    + ",\"upgrades\":[]"
    + ",\"pingInterval\":" + `${pingInterval}`
    + ",\"pingTimeout\":" + `${pingTimeout}`
    + ",\"maxPayload\":" + `${maxPayload}` + "}";
}

// One Engine.IO packet as it arrives.
export type EnginePacket = {
  ok: bool,
  kind: int,
  // Everything after the single type digit. For a MESSAGE this is a Socket.IO
  // packet; for a PING it is empty.
  body: string,
};

export function readEnginePacket(text: string): EnginePacket {
  let empty: EnginePacket = { ok: false, kind: -1, body: "" };
  if (text.length == 0) { return empty; }
  let kind = digitAt(text, 0);
  if (kind < 0) { return empty; }
  let out: EnginePacket = { ok: true, kind: kind, body: text.slice(1, text.length) };
  return out;
}

// A message carrying a Socket.IO packet.
export function messagePacket(payload: string): string {
  return `${EIO_MESSAGE}` + payload;
}

// --- Socket.IO packets ----------------------------------------------------------------

// `<type>[<nsp>,][<ackId>][json]`
//
// The namespace — socket.io calls it `nsp`, and so does this, because
// `namespace` is a reserved word here — is present only when it is not "/",
// and is terminated by a comma. That detail matters: a namespace and an ack id
// are both optional and adjacent, so a parser that guesses reads "/admin" as
// an ack id.
export type SocketPacket = {
  ok: bool,
  kind: int,
  nsp: string,
  // -1 when the packet carries no acknowledgement id.
  ackId: int,
  // The JSON array or object that followed, verbatim.
  payload: string,
  error: string,
};

export function encodePacket(kind: int, nsp: string, ackId: int, payload: string): string {
  let out = `${kind}`;
  if (nsp != "" && nsp != "/") { out = out + nsp + ","; }
  if (ackId >= 0) { out = out + `${ackId}`; }
  return out + payload;
}

// An event: a name and its arguments, as a JSON array.
export function eventPacket(nsp: string, ackId: int, name: string, argsJson: string): string {
  let payload = "[" + JSON.stringify(name);
  if (argsJson != "") { payload = payload + "," + argsJson; }
  payload = payload + "]";
  return encodePacket(SIO_EVENT, nsp, ackId, payload);
}

// The reply to an event that asked for one. The id must be the id that was
// sent, or the client's callback never fires and nothing says why.
export function ackPacket(nsp: string, ackId: int, argsJson: string): string {
  let payload = "[";
  if (argsJson != "") { payload = payload + argsJson; }
  payload = payload + "]";
  return encodePacket(SIO_ACK, nsp, ackId, payload);
}

// The server's answer to a client's CONNECT. Carrying a session id here is
// what modern clients expect; one that gets a bare `40` treats the connection
// as belonging to no session and cannot reconnect into it.
export function connectPacket(nsp: string, sid: string): string {
  return encodePacket(SIO_CONNECT, nsp, -1, "{\"sid\":" + JSON.stringify(sid) + "}");
}

export function readSocketPacket(text: string): SocketPacket {
  let bad: SocketPacket = { ok: false, kind: -1, nsp: "/", ackId: -1, payload: "", error: "empty packet" };
  if (text.length == 0) { return bad; }

  let kind = digitAt(text, 0);
  if (kind < 0) {
    let notType: SocketPacket = { ok: false, kind: -1, nsp: "/", ackId: -1, payload: "",
      error: "\"" + text.slice(0, 1) + "\" is not a packet type" };
    return notType;
  }

  let at: int = 1;
  let nsp = "/";
  // A namespace starts with / and runs to a comma. Without the comma test, a
  // payload beginning with a slash would be swallowed.
  if (at < text.length && text.charAt(at) == "/") {
    let comma = text.indexOf(",", at);
    if (comma < 0) {
      // "40/admin" with no comma and no payload is still a namespace.
      nsp = text.slice(at, text.length);
      let bare: SocketPacket = { ok: true, kind: kind, nsp: nsp, ackId: -1, payload: "", error: "" };
      return bare;
    }
    nsp = text.slice(at, comma);
    at = comma + 1;
  }

  // Then digits, if any, are the acknowledgement id.
  let ackId: int = -1;
  let digits = "";
  while (at < text.length && digitAt(text, at) >= 0) {
    digits = digits + text.charAt(at);
    at = at + 1;
  }
  if (digits != "") { ackId = parseInt(digits) ?? -1; }

  let out: SocketPacket = {
    ok: true, kind: kind, nsp: nsp, ackId: ackId,
    payload: text.slice(at, text.length), error: "",
  };
  return out;
}

// --- reading an event -------------------------------------------------------------

// The name an EVENT payload carries, and the rest of its arguments.
//
// Read by scanning rather than parsing: the arguments are whatever the caller
// sent and no record type can declare them, which is the same reason the
// agents package scans provider replies.
export type EventCall = {
  ok: bool,
  name: string,
  // Everything after the name, still a JSON fragment, without the brackets.
  argsJson: string,
};

export function readEvent(payload: string): EventCall {
  let bad: EventCall = { ok: false, name: "", argsJson: "" };
  let body = payload.trim();
  if (!body.startsWith("[")) { return bad; }
  let inner = body.slice(1, body.length - 1).trim();
  if (!inner.startsWith("\"")) { return bad; }

  // The name is the first string; find its closing quote, honouring escapes.
  let i: int = 1;
  let name = "";
  while (i < inner.length) {
    let ch = inner.charAt(i);
    if (ch == "\\" && i + 1 < inner.length) {
      let next = inner.charAt(i + 1);
      if (next == "n") { name = name + "\n"; } else { name = name + next; }
      i = i + 2;
      continue;
    }
    if (ch == "\"") { break; }
    name = name + ch;
    i = i + 1;
  }

  let rest = inner.slice(i + 1, inner.length).trim();
  if (rest.startsWith(",")) { rest = rest.slice(1, rest.length).trim(); }
  let out: EventCall = { ok: true, name: name, argsJson: rest };
  return out;
}

// A session id. Socket.io's own are base64-ish and opaque; what matters is
// that they are unguessable, because a client presents one to resume.
export function newSid(): string {
  return crypto.randomUUID();
}

function digitAt(text: string, at: int): int {
  let c = text.charCodeAt(at);
  if (c >= 48 && c <= 57) { return c - 48; }
  return -1;
}

// Server-sent events: one-way push over an ordinary HTTP response that never
// ends.
//
//   serveEvents(9010, (stream: EventStream) => {
//     pushEvent(stream, "token", "Hel");
//     pushEvent(stream, "token", "lo");
//     pushEvent(stream, "done", "");
//   });
//
// Simpler than a WebSocket and enough for most of what a WebSocket gets used
// for: streaming an answer as it is written, or telling a page something
// changed. The browser reconnects on its own, which is the part people
// underestimate — a dropped WebSocket needs code to recover and a dropped
// EventSource does not.
//
// What it cannot do is carry anything upstream. The page talks back with an
// ordinary request, which it can already do.
//
// The format is text and the whole specification fits in a paragraph: lines of
// `field: value`, an empty line ends an event, and a line starting with `:` is
// a comment. Everything below is that, plus the mistakes it is easy to make.

// A connection that has been given the SSE headers and is ready for events.
export type EventStream = {
  socket: Socket,
  path: string,
  open: bool,
};

// --- writing ------------------------------------------------------------------------

// The response head. `no-cache` is not decoration: a proxy that caches this
// serves one client's stream to another, and `X-Accel-Buffering` turns off
// nginx's buffering, which otherwise holds events until the buffer fills and
// makes a live stream arrive in lumps minutes late.
export function eventHeaders(): string {
  return "HTTP/1.1 200 OK\r\n"
    + "Content-Type: text/event-stream\r\n"
    + "Cache-Control: no-cache\r\n"
    + "Connection: keep-alive\r\n"
    + "X-Accel-Buffering: no\r\n"
    + "Access-Control-Allow-Origin: *\r\n"
    + "\r\n";
}

// One event to send.
//
// Three bare strings positionally, which at the documented call site read as
// `("7", "done", "complete")` — nothing says which is which. Swapping id and
// name emits a perfectly well-formed frame that no listener fires on, and the
// browser then reconnects with `Last-Event-ID: done`, so server-side resume
// keyed on numeric ids silently restarts from the beginning. The read side
// already has ServerEvent; this is its counterpart.
export type Event = {
  // "" for an event a client cannot resume from.
  id: string,
  // "" for an unnamed event, which a browser delivers to `onmessage`.
  name: string,
  data: string,
};

// One event, framed.
//
// Every line of the data gets its own `data:` prefix — a newline inside a
// value would otherwise end the event early and deliver half of it. The
// browser rejoins them with newlines, so the round trip is exact.
export function eventFrame(event: Event): string {
  let id = event.id;
  let name = event.name;
  let data = event.data;
  let out = "";
  if (id != "") { out = out + "id: " + id + "\n"; }
  if (name != "") { out = out + "event: " + name + "\n"; }
  let lines = data.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    out = out + "data: " + lines[i] + "\n";
    i = i + 1;
  }
  // The blank line is the frame. Without it the event is never delivered, and
  // a stream that looks correct in a log sits in the browser unread.
  return out + "\n";
}

// How long a browser waits before reconnecting, in milliseconds. Sent as its
// own event because it applies to the connection rather than to any message.
export function retryFrame(ms: int): string {
  return "retry: " + `${ms}` + "\n\n";
}

// A comment. Used as a heartbeat: a proxy or a phone radio will drop a
// connection that says nothing for a minute or two, and a colon line costs
// nothing and is ignored by every client.
export function commentFrame(text: string): string {
  return ": " + text + "\n\n";
}

export function pushEvent(stream: EventStream, name: string, data: string): void {
  if (!stream.open) { return; }
  stream.socket.write(eventFrame({ id: "", name: name, data: data }));
}

// With an id, so a browser that reconnects sends `Last-Event-ID` and a server
// can resume rather than repeat.
export function pushEventWithId(stream: EventStream, event: Event): void {
  if (!stream.open) { return; }
  stream.socket.write(eventFrame(event));
}

export function pushComment(stream: EventStream, text: string): void {
  if (!stream.open) { return; }
  stream.socket.write(commentFrame(text));
}

export function closeStream(stream: EventStream): void {
  stream.socket.close();
}

// --- the request --------------------------------------------------------------------

export type EventRequest = {
  ok: bool,
  path: string,
  // What the browser last saw, when it is reconnecting. Empty on a first
  // connection.
  lastEventId: string,
  error: string,
};

// Read the request that opens a stream. An ordinary GET — the only header
// worth reading is Last-Event-ID, which is how resumption works.
export function readEventRequest(buffer: string): EventRequest {
  let waiting: EventRequest = { ok: false, path: "", lastEventId: "", error: "" };
  let end = buffer.indexOf("\r\n\r\n");
  if (end < 0) { return waiting; }

  let lines = buffer.slice(0, end).split("\r\n");
  let parts = lines[0].split(" ");
  if (parts.length < 3 || parts[0] != "GET") {
    let notGet: EventRequest = { ok: false, path: "", lastEventId: "",
      error: "an event stream is a GET, not " + parts[0] };
    return notGet;
  }

  let lastId = "";
  let i: int = 1;
  while (i < lines.length) {
    let at = lines[i].indexOf(":");
    if (at > 0 && lines[i].slice(0, at).trim().toLowerCase() == "last-event-id") {
      lastId = lines[i].slice(at + 1, lines[i].length).trim();
    }
    i = i + 1;
  }

  let out: EventRequest = { ok: true, path: parts[1], lastEventId: lastId, error: "" };
  return out;
}

// Serve. The handler is given a stream that already has its headers, and the
// connection closes when the handler returns.
//
// The body is a top-level function rather than the closure it wants to be.
// Writing it inline made the native backend reject the generated code — it
// says so itself, "likely a Lumen compiler bug; please report it" — at the
// line calling `onStream`.
//
// The trigger is this: a closure cannot CALL a function value that reached
// the enclosing scope as a parameter. It may capture one and pass it along —
// which is exactly what the call below does — and it may call a lambda
// defined as a literal in scope. Copying the parameter into a local first
// does not help; the local is rejected the same way.
//
//   function passes(g: () => string): void {
//     taker((): string => { return g(); });   // 'g' not accessible from inner function
//   }
//
// So `handleStream` is a top-level function taking `onStream` as its own
// parameter, where calling it is a direct call and not a capture. Every
// server in these packages has the same shape for the same reason.
export function serveEvents(port: int, onStream: (stream: EventStream) => void): void {
  net.createServer(port, (socket: Socket) => {
    handleStream(socket, onStream);
  });
}

function handleStream(socket: Socket, onStream: (stream: EventStream) => void): void {
    let buffer = "";
    let request: EventRequest = { ok: false, path: "", lastEventId: "", error: "" };
    while (!request.ok) {
      let chunk = socket.read();
      if (chunk == "") { socket.close(); return; }
      buffer = buffer + chunk;
      request = readEventRequest(buffer);
      if (request.error != "") {
        socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        socket.close();
        return;
      }
    }

    socket.write(eventHeaders());
    let stream: EventStream = { socket: socket, path: request.path, open: true };
    onStream(stream);
    socket.close();
}

// --- reading a stream ----------------------------------------------------------------

// One event as a client sees it.
export type ServerEvent = {
  complete: bool,
  id: string,
  name: string,
  data: string,
  // How much of the buffer it used.
  consumed: int,
};

// The event at the front of a buffer, if there is a whole one.
//
// Incomplete is the ordinary case rather than an error: events arrive in
// pieces and a client keeps reading. A comment is consumed and reported as an
// event with no name and no data, so a caller can tell "nothing yet" from
// "a heartbeat went by".
export function readEvent(buffer: string): ServerEvent {
  let waiting: ServerEvent = { complete: false, id: "", name: "", data: "", consumed: 0 };

  // An event ends at a blank line, which is \n\n — or \r\n\r\n from a server
  // that writes CRLF. Both occur.
  let end = buffer.indexOf("\n\n");
  let width: int = 2;
  let crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0 && (end < 0 || crlf < end)) { end = crlf; width = 4; }
  if (end < 0) { return waiting; }

  let block = buffer.slice(0, end);
  let lines = block.split("\n");
  let id = "";
  let name = "";
  let data = "";
  let dataLines: int = 0;

  let i: int = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (line.endsWith("\r")) { line = line.slice(0, line.length - 1); }
    if (line.startsWith(":")) { i = i + 1; continue; }

    let at = line.indexOf(":");
    if (at < 0) { i = i + 1; continue; }
    let field = line.slice(0, at);
    let value = line.slice(at + 1, line.length);
    // One leading space is part of the framing, not of the value. Stripping
    // more would corrupt data that begins with spaces.
    if (value.startsWith(" ")) { value = value.slice(1, value.length); }

    if (field == "id") { id = value; }
    else if (field == "event") { name = value; }
    else if (field == "data") {
      if (dataLines > 0) { data = data + "\n"; }
      data = data + value;
      dataLines = dataLines + 1;
    }
    i = i + 1;
  }

  let out: ServerEvent = { complete: true, id: id, name: name, data: data, consumed: end + width };
  return out;
}

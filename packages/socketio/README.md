# socketio

A socket.io server the **official browser client** connects to.

```ts
serveSocketIO(9020, (client: Client, name: string, argsJson: string) => {
  if (name == "hello") { emit(client, "greeting", "\"hi from lumen\""); }
});
```

socket.io 4.7.5, straight from their CDN, against exactly that:

```
io loaded: function
client: connect id=1cdcc84d-4945-44db-bc04-ce80f5533942
client: greeting:hi from lumen
client: sum:42
connected: True
```

Their client, unmodified. It completed the Engine.IO handshake, accepted the
sid, sent CONNECT, emitted and received events, and stayed connected.

## What it speaks

Two layers, both text, one inside the other:

```
"42[\"hello\",\"world\"]"
 ││ └─ Socket.IO EVENT payload: name then arguments
 │└─── Socket.IO type 2 = EVENT
 └──── Engine.IO type 4 = MESSAGE
```

Engine.IO opens the session and keeps it alive; Socket.IO says what the
messages mean. Every wire string in `protocol.test.ts` is from socket.io's own
protocol document — 18 tests — rather than from this code.

## WebSocket transport only

The client must be told `transports: ["websocket"]`. Its default is HTTP
long-polling followed by an upgrade, and that transport is a **stated
non-goal**: a great deal of work for a fallback nothing here needs. A client
left on the default will not connect, and that is the expected behaviour rather
than a bug to file.

Also not implemented: binary attachments, and rooms.

## The details that decide whether a client stays

**`pingInterval` and `pingTimeout` are a contract.** The client starts a timer
from the values in the opening packet, so a server that sends numbers it does
not honour is dropped after interval + timeout with nothing in any log.

**Engine.IO v4 has the *server* ping and the client pong.** This is reversed
from v3, and a server that waits to be pinged simply dies.

**CONNECT is answered with a sid.** A client that receives a bare `40` believes
it belongs to no session and cannot reconnect into one.

**A namespace and an ack id are adjacent and both optional.** `2/admin,456[…]`
— the comma is what separates them, and a parser that guesses reads `/admin`
as an ack id. That one has its own test.

**An event that asked for acknowledgement always gets one.** If the handler
sends nothing, an empty ack goes anyway: otherwise the client's callback stays
pending forever with nothing to show why.

## Why the session loop lives here

A socket.io session has per-connection state — a sid, a namespace, whether
CONNECT has happened — and the websocket package's server calls back per
*message*, with nowhere to keep any of it. So the loop that owns a connection
is written here, over websocket's framing rather than its server.

## Testing

```sh
cd packages/socketio
lumen test protocol.test.ts    # 18, socket.io's own wire strings

lumen run sio-demo.ts &
python3 siocheck.py            # the real client, from a page serving their CDN bundle
```

`siocheck.py` needs a page serving socket.io's browser bundle on another port;
the script says which. Two harness traps cost time here and are worth knowing:
a page with a Content-Security-Policy blocks the connection, and `about:blank`
has an opaque origin that Chromium refuses to dial from.

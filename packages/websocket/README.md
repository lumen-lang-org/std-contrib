# websocket

RFC 6455 over raw TCP: frames, the handshake, and a server. A real browser
connects to it, exchanges messages and closes cleanly.

```ts
import { Peer, serveWebSocket, send } from "./server.ts";

serveWebSocket(9001, (peer: Peer, message: string) => {
  send(peer, "echo:" + message);
});
```

```
browser: open
browser: recv(10):echo:hello
browser: recv(5005):echo:xxxxxxxxx…
browser: close:1000 clean=true
```

## What is checked, and against what

Nothing here is validated against itself. A codec compared to its own output
passes however wrong it is — this repository learned that from a base64 test
that did exactly that.

| layer | judged by |
|---|---|
| frames | RFC 6455 §5.7's published bytes — 20 tests |
| handshake | RFC 6455 §1.3's worked example — 13 tests |
| server, wire | an independent Python client with its own framing |
| server, real world | Chromium, via `browsercheck.py` |

The RFC prints exact bytes for four frames and this asserts all four:
`810548656c6c6f` for an unmasked "Hello", `8185 37fa213d 7f9f4d5158` masked,
and both extended-length headers. Section 1.3's key
`dGhlIHNhbXBsZSBub25jZQ==` must answer `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`; a
browser compares that exactly and closes the connection on anything else.

## The decisions worth knowing

**Client frames are masked and server frames must not be.** Getting it
backwards is the classic failure and it is silent — a browser simply
disconnects. Masking is XOR written by hand, since this language has no
bitwise operator on the byte type, so it is tested across all 256 values: a
byte it got wrong would corrupt payloads rather than fail.

**A partial frame is not an error.** A read returns whatever arrived and a
frame spans reads. Treating that as failure would close a healthy connection
on the first large message.

**Everything decodable is drained before reading again.** One read can carry
several frames, and handling one per read stalls behind the socket.

**Pings are answered here, not by the handler.** A heartbeat somebody has to
remember to answer is a heartbeat that eventually stops.

**Control frames pass through fragment assembly untouched.** A ping may arrive
between the fragments of a message; buffering it would answer after the
message it interrupted.

**A close is echoed with its code.** A peer that gets no answering close waits
for a timeout instead of hanging up.

## Limits, stated rather than discovered

**One worker per open connection.** The runtime's pool is sized for requests
that end — `max(4, cpus × 2)` — and a WebSocket does not end. A dozen idle
browser tabs can starve a server. This needs measuring before anything calls
it production-ready.

**No TLS.** `net` has none, so `wss://` needs a terminating proxy in front.

**8 MB per message**, and a frame claiming more than 4 GB is refused rather
than allocated. A peer does not get to decide how much memory this process
uses.

## Two bugs this found

Both were beneath this package, and both were found by running it rather than
reading it:

- **`socket.read()` treated a short read as end-of-stream.** It used
  `readSliceShort`, which loops until its buffer is full. A 150-byte request
  into a 64 KB buffer looked like a closed peer, and every write after a read
  was silently dropped. Fixed in the compiler runtime (`readVec`, one read).
- **`crypto.randomBytes(16)` returns 32 hex characters, not 16 bytes**, so
  base64 of it is a 44-character key decoding to 32 bytes where the RFC says
  16. Converted at the call site, with the surprise noted there.

## Testing

```sh
cd packages/websocket
lumen test frame.test.ts        # 20, the RFC's own bytes
lumen test handshake.test.ts    # 13, the RFC's own exchange

lumen run echo-server.ts &      # then, against a real browser:
python3 browsercheck.py
```

`browsercheck.py` carries two harness lessons in its comments, because both
cost real time: `about:blank` has an opaque origin and Chromium refuses to
dial from it, and a page serving a Content-Security-Policy blocks `connect-src`
to another port. Every "the browser failed" before those were understood was
the harness, not the server — the browser had never opened a connection.

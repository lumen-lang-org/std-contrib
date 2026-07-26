# sse

Server-sent events: one-way push over an HTTP response that never ends.

```ts
serveEvents(9010, (stream: EventStream) => {
  pushEvent(stream, "token", "Hel");
  pushEvent(stream, "token", "lo ");
  pushEventWithId(stream, "7", "done", "complete");
});
```

A real browser's `EventSource`, subscribed to exactly that:

```
browser: token|"Hel"|id=
browser: note|"line one\nline two"|id=
browser: done|"complete"|id=7
browser: error → reconnect → token|"Hel"|id=7
```

## Why this rather than a WebSocket

Simpler, and enough for most of what a WebSocket gets used for: streaming an
answer as it is written, or telling a page something changed.

**The browser reconnects on its own**, which is the part people underestimate.
The trace above shows it: the stream ended, `EventSource` reconnected without
being asked, and sent `Last-Event-ID: 7` so the server could resume rather than
repeat. A dropped WebSocket needs code to recover; this needs none.

What it cannot do is carry anything upstream — the page talks back with an
ordinary request, which it can already do. If you need the *browser* pushing
into an open channel, you want the websocket package.

## The mistakes this format invites

**The blank line is the frame.** Without it the event is never delivered, and
the stream looks perfectly correct in a log.

**Every line of the data needs its own `data:` prefix.** A newline inside a
value ends the event early and delivers half of it. The browser rejoins them,
so `"line one\nline two"` arrives exact — that round trip is asserted here and
confirmed above.

**Only one leading space is framing.** Stripping more corrupts data that begins
with spaces.

**`Cache-Control: no-cache` is not decoration** — a proxy that caches this
serves one client's stream to another. `X-Accel-Buffering: no` turns off
nginx's buffering, which otherwise holds events until its buffer fills and
makes a live stream arrive in lumps minutes late.

**A comment is a heartbeat.** A proxy or a phone radio drops a connection that
says nothing for a minute or two; `: ping` costs nothing and every client
ignores it.

## A compiler limit worth knowing

`serveEvents` puts its body in a top-level function rather than the closure it
wants to be. A captured parameter can be *passed along* from an inner function
but not *called* from one, so the callback is threaded through as an argument.
The websocket package has the same shape for the same reason.

## Testing

```sh
cd packages/sse
lumen test sse.test.ts     # 17

lumen run events-demo.ts &
curl -sN http://127.0.0.1:9010/events    # the raw frames
python3 /tmp/ssecheck.py                 # a real browser's EventSource
```

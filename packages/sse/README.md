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

## A workaround for an unreduced compiler bug

`serveEvents` puts its body in a top-level function rather than the closure it
wants to be, because writing it inline makes the native backend reject the
generated code — it reports "likely a Lumen compiler bug; please report it".

**The trigger is not understood.** A closure that captures and calls a
parameter compiles fine, and so does one doing it inside `net.createServer`'s
callback. Both were tried after the fact, and both disprove the tidy
explanation this file used to carry. Something narrower is at fault and nobody
has reduced it.

This is recorded as an open bug rather than a design decision, because a
plausible-sounding rationale for a workaround is worse than no rationale: it
stops the next person looking.

## Testing

```sh
cd packages/sse
lumen test sse.test.ts     # 17

lumen run events-demo.ts &
curl -sN http://127.0.0.1:9010/events    # the raw frames
python3 /tmp/ssecheck.py                 # a real browser's EventSource
```

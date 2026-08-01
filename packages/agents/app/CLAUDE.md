# The agent console

A LumenJS + Lit front end for the `agents` package. `npm run dev` serves it
and proxies `/api` and `/preview` to the Lumen API on 8100.

The app is its own server, which is the fact most of this file hangs off.
There is no build config to read and no nginx in front: the proxy rules are
Connect middleware in `server/api-proxy.ts`, the pages are `pages/`, and the
one image the Dockerfile builds is what runs on a laptop and on nuraly.io
alike. `npm run build` produces `.lumenjs/`; `npm start` serves it.

## No emoji in the interface

Every mark in this UI is an `<nr-icon>`. Never an emoji.

An emoji is a font, not an asset: it draws as a coloured cartoon on one
machine, as flat monochrome on the next, and as an empty box on a machine
whose font lacks the codepoint — which is what a folder glyph did here, and it
reads as a broken image rather than as a picture of a folder. It also cannot
take a colour, a size or a stroke weight from the design, so it is the one
element on the page that ignores the theme.

```html
<!-- no -->
<button>🗂</button>
<!-- yes -->
<button><nr-icon name="folder" size="small"></nr-icon></button>
```

**Check the name exists before using it.** `nr-icon` draws the *name* when it
has no glyph for it, so a wrong name is a word sitting where an icon should
be — `function` printed across a node title for a whole afternoon. The set
lives at `nuraly-ui/src/components/icon/icon-paths.ts`; grep it. Names that
sound obvious and are absent: `sidebar` (it is `panel-left`), `close` (it is
`x`), `agent`, `function`, `pencil`, `folder-open`.

There is an e2e test that fails when any `nr-icon` on screen resolved to no
`<svg>`. Keep it passing rather than checking by eye.

## Everything else is a LumenUI component

`nr-input`, `nr-select`, `nr-checkbox`, `nr-textarea`, `nr-button`,
`nr-overlay` — not raw `<input>` or `<select>`. Two consequences worth
knowing:

- **Read a value off the element, not the event detail.** `nr-input`,
  `nr-select` and `nr-textarea` describe their payloads differently; `.value`
  is what all three agree on.
- **Import bundles carefully.** Each `<component>/bundle.js` inlines its own
  copy of what it depends on, so importing two that share a dependency throws
  `define(...) has already been used` — while the module graph is loading,
  which blanks the whole console rather than one component. `ui.ts` holds the
  one working combination; read the note there before adding to it. Before
  adding a bundle, grep the ones already imported for the tag you want:
  `nr-code-editor` is used here and imported nowhere, because the canvas
  bundle already carries it.
- **A component may know a language without dressing it.** `nr-code-editor`
  highlights markdown, and its own stylesheet colours javascript, json and css
  only — so every markdown token came out black. The spans are in its shadow
  root, out of reach of a rule here, so `settings.ts` hands that root a
  stylesheet of its own in `updated()`. Custom properties cross a shadow
  boundary, so the colours still come from the console's palette.

## The live feed is progressive, never load-bearing

Under the LumenJS server the console is pushed what it used to poll for:
conversations, the running round's steps, artifact versions. `src/live.ts` is
the bus; `server/sockets.ts` is the server half.

The rule for anything added to it: **the poll stays, and it is skipped rather
than cancelled.**

```ts
// no — the feature now only works where a socket does
live.on("threads", (f) => { this.threads = f.threads; });
clearInterval(this.ticker);
// yes
live.on("threads", (f) => { this.threads = f.threads; });
setInterval(() => { if (live.fresh()) return; void this.refresh(); }, 10000);
```

The server half is nudged, not only timed. `server/api-proxy.ts` sees every
write the console makes, so it calls `noteWrite()` (`server/nudge.ts`) when the
engine accepts one, and the socket's thread poller asks again immediately —
which is what makes a conversation created in one browser appear in another's
sidebar in tens of milliseconds rather than up to a poll period. Two rules
about that signal, both load-bearing:

- **It carries nothing.** No id, no body, no identity. Each socket answers a
  nudge by asking the engine with its own browser's credentials and pushing
  only what changed, so a write by one owner cannot reach another owner's
  sidebar. Give the signal a payload and the fan-out becomes exactly that.
- **It is an accelerator, never a mechanism** — the same rule as above, one
  layer down. A write from a second console, a script, or the engine's own
  bookkeeping never passes through this process, and only the timer finds it.
  So the timer stays at its own cadence and is never lengthened to pay for the
  nudge.

Every server this app has now serves the socket, so the rule is easier to
forget than it was: until phase 5 there was a second server with no socket at
all, and a region that leaned on the feed simply did not work under `npm run
dev:vite`. That reminder is gone; the reason for the rule is not. A feed stops
for a tab that went to sleep, a container that was restarted, a network that
dropped — `live.fresh()` answers false in all three, and the timer underneath
is what makes those a hesitation rather than a stuck screen.

`e2e/live.spec.ts` asserts both halves and skips itself when the server it is
pointed at serves no socket. That skip is now a signal rather than a mode: it
means `CONSOLE_URL` is pointed at something that is not this console.

## Tests drive the UI, not the API

An e2e test types into the composer and reads what appears. The API is for
*arranging* rows a scenario needs and for *asserting* what was really stored —
never for performing the action under test. A test that posts to `/api` and
then checks the database has verified the API, which the API's own tests
already do, and has said nothing about the thing a person touches.

Four mechanical notes that cost real time to learn:

- The chat composer is a `contenteditable` div, not a `textarea`.
- Playwright pierces open shadow roots for CSS, so `#c-name input` reaches
  inside a LumenUI field. But `toBeEmpty()` reads *light-DOM* children, so it
  answers "empty" for any component that renders into a shadow root however
  much is on screen. Assert on text, not on emptiness.
- **Arrive through `open(page)`, never `page.goto("/")`.** The page is
  server-rendered, so the console's markup paints seconds before the module
  that gives it behaviour, and a click in that window is dropped rather than
  queued. `expect(shell(page)).toBeVisible()` used to mean "it works" because
  the element did not exist until its module ran; it does not mean that any
  more. `open()` waits for the custom element to be defined and past its first
  render — the thing a person is waiting for.
- **`count()` does not retry.** A picker filled by a fetch answers 0 to a
  `locator.count()` a moment before it is right. Assert with
  `expect(locator).toHaveCount(n)`, which waits, rather than sampling and
  comparing.

## What the suite needs before it can pass

- **A console it can bind.** The webServer takes port 5173; a machine already
  running one there needs `AGENTS_CONSOLE_PORT=5273 npx playwright test`
  (`e2e/deployment.ts`). Without it `webServer` times out after sixty seconds
  and never says why.
- **An engine whose `AGENTS_PREVIEW_HOST` matches the suite's.** It is the
  same variable and the same shape — a host, optionally with a port. Set it
  for the run, not just for the engine, or the preview specs assert against
  the console's own markup.
- **The script images built:** `agents-runtime:1` and `agents-web:1`, from
  `../runtime.Dockerfile` and `../runtime-web.Dockerfile`. Missing, `run_script`
  answers "docker could not create the environment" for every call, the double
  falls through to its generic reply, and six specs report a chat message that
  never arrived rather than an image that is not there.

## Office documents are converted, not re-implemented

A `.docx` and a `.pptx` in the artifact panel are drawn from a PDF, converted
server-side by LibreOffice (`../office-render.ts`, `../office-render.Dockerfile`)
and rendered here by pdf.js. `src/office-view.ts` asks `/artifacts/:slot/pdf`
and falls back to docx-preview / pptx-preview when that fails.

Three things worth knowing before touching it:

- **The fallback is silent and must stay working.** The converter needs docker
  and `agents-office-render:1`; a laptop without them still opens documents, a
  little wrong rather than not at all. Test both paths — stopping docker is
  how you reach the second one.
- **A `.xlsx` is never converted**, converter or not. A workbook is for
  scrolling and reading cells at their own size; paginating one into PDF
  sheets is a worse answer than the table, however much better the
  typography. SheetJS stays its only renderer.
- **A canvas cannot be cloned or reflowed.** `cloneNode` on one copies the
  element and not a pixel, so the thumbnail rail renders its own small pass
  rather than scaling a big one — and a page drawn at one width does not
  narrow with its column, which is why `.pdf-page canvas` carries
  `max-width: 100%` and why widening the panel triggers a real re-render.

Build the image once: `docker build -f ../office-render.Dockerfile -t
agents-office-render:1 ..` (~790MB). Conversions are cached per
`artifact:version` forever — a version is immutable, so the cache never
invalidates — which is why ~2s of cold start per document is affordable.

## Fixtures may not cost more than they prove

A credential can never be read back, by design. A fixture that overwrites one
cannot restore it — this suite once replaced a real provider key with
`e2e-not-a-real-key` on every run. Write a key only where none exists.

The same rule one step out: **a fixture that borrows must repair, not only
restore.** A `finally` that hands something back does not run when the run is
killed, and shared state left borrowed poisons every run afterwards — the
screenshot spec's `scriptImageId` left every other script test in the browser
image, where `pip install` refuses. `ownScriptImage()` puts it back at the
start of a run rather than trusting the end of the last one.

`ownDoubleAddress()` is the same shape, and shows why the repair has to be a
real one rather than a re-`PUT`. One spec moves `m-double` to a dead port to
prove a round that never reaches a provider stores nothing, then moves it
back — and a run killed between the two leaves it there. Writing the address
again does not fix it: the API refuses to re-address a model while a key is
stored for the host it is leaving, so the repair has to clear the key, move,
and set it again. Without that, every spec that drives the double answered
"the provider refused the stream: -1" from a console that was working
perfectly, and the file that broke it could not un-break itself.

## The console never learns how it is deployed

One environment variable, `AUTH`, chooses between three deployments, and
`pages/_middleware.ts` is the only file that reads it:

| `AUTH`    | who signs you in     | what the engine is told      |
|-----------|----------------------|------------------------------|
| `none`    | nobody               | no `X-USER` — the community box |
| `builtin` | this app, own users  | the session, as `X-USER`     |
| `proxy`   | the gateway in front | the inbound `X-USER`, untouched |

The rule that keeps this from spreading: **nothing under `src/` may branch on
the mode.** `src/api.ts` asks `/whoami` and follows a 401 to `/auth/login`; the
rail navigates to `/logout`. Those three paths are the whole contract, and each
mode's job is to make them true — `builtin` answers `/whoami` from its session
and aliases `/logout` onto the framework's route in the middleware, rather than
teaching the rail a second path. If a deployment question seems to need a
change in `src/`, it belongs in the middleware instead.

Two consequences when working in here:

- **`builtin` keeps users in this app's own database** (`data/`, gitignored),
  never the engine's. The engine is another process behind `AGENTS_API` and
  names its store with `AGENTS_PG_*`/`AGENTS_DB_FILE`, so the two cannot
  collide by accident — keep it that way.
- **`proxy` trusts a header, so it refuses to start on a public bind.** That
  check is the whole of the mode's security. `AUTH_PROXY_ALLOW_PUBLIC_BIND=1`
  exists for a firewalled host with a public NIC and is named to be
  embarrassing in a diff; reach for `AGENTS_CONSOLE_BIND` first.

`e2e/auth.spec.ts` covers the `builtin` half and skips itself on any console
that is not in that mode — so it passes, proving nothing, against `npm run
dev`. Point it at one that is:

```
AUTH=builtin AUTH_SESSION_SECRET=... npx lumenjs dev --port 5174
CONSOLE_URL=http://127.0.0.1:5174 npx playwright test e2e/auth.spec.ts
```

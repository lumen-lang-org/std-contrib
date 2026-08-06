# Tasks: Discover articles, and asking about one

Opening a story from the Discover feed, reading what the crawl holds on it,
and asking about it in a box that becomes a real conversation.

Three constraints shape every task below, and they are not preferences:

1. **The index is operator-only.** `/search`, `/retrieve` and `/doc/<hash>` are
   all `operator: true` in `app/server/search-proxy.ts`. Discover is public, so
   a guest's browser cannot fetch an article body — it has to be written by the
   digest pass and stored, like everything else on that page.
2. **Context is seeded server-side.** A turn whose text opens with the
   retrieval sentence is stored as `CHUNK_ROLE` and never shown in a
   transcript. A client that could post one could steer a model invisibly, so
   the article context is built in the engine from the story ROW, never from a
   request body.
3. **An applied migration's SQL never changes.** New columns are an ALTER at a
   new version. 98.2 is already applied on prod.

## M1: A story gets a body

- [x] Give `DiscoverRow` `body`, `image` and `readMinutes`.
- [x] Migration 98.3: three `ALTER TABLE discover_stories ADD COLUMN`.
- [x] Leave `image` empty and unused — the column exists now so the layout
      does not move when the crawler starts extracting `og:image`.
- [x] Make story ids content-derived (`feed:<hash of headline>`) instead of
      `feed:<rank>`. A slot-numbered id means a link points at position 3
      rather than at a story, and every refresh silently repoints it.
- [x] Add `bodyFor(story, hits)` — passages from `retrieveWeb`, kept only where
      the passage url is one of the story's own sources, grouped by host.
- [x] Fall back to the digest's own snippets when retrieval returns nothing, so
      a story always has something to open.
- [x] Count words for `readMinutes`.
- [x] `refreshFeed` writes the three new fields.

## M2: The article route

- [x] `GET /discover/story/:id` in the engine — the row plus its feed's topic.
      Public: `GUEST_GETS` already holds `/api/discover` and `claims()` matches
      by prefix, so no middleware change.
- [x] Answer a missing story with "rolled off the feed" rather than a bare 404 —
      feeds replace their rows, so an article URL outlives its row by design.
- [x] `pages/discover/[id].ts` so a cold link works, mounting the console the
      way `pages/c/[id].ts` does.
- [x] `openArticleAt` property on the console, matching `openSettingsAt`.
- [x] `openArticle` / `closeArticle` with `pushState`, and popstate handling —
      Back must leave the article, which is what everybody tries first.

## M3: Reading it

- [x] `src/discover-article.ts`: headline, `ago(fetchedAt) · fetched` meta,
      the digest summary as a standfirst, body, sources.
- [x] Photo slot at the top, collapsed while `image` is empty.
- [x] Each source titled by host with a **Read on <host> →** link out. What is
      shown is what the crawl holds, not a republished article.
- [x] Cards on the feed become clickable, to `/discover/<id>`.

## M4: The ask box

- [x] `src/article-ask.ts` — a textarea and a send button, and nothing else.
      Not the console's composer: that carries the model picker, attachments,
      skills and tool state, none of which belongs on an article.
- [x] The zone above it grows on send: working indicator, then the reply
      through the existing `markdown.ts`.
- [x] A second question pushes the first pair up. It is a compact transcript,
      not a one-shot answer box — which is what makes "the same context" true
      for turn three as well as turn two.
- [x] **Open in the console →** at the foot once a thread exists.

## M5: The conversation is real

- [x] `POST /threads/from-story` — under `/threads`, not `/discover`, because
      `GUEST_THREADS` is the one path a guest may write to and a POST under
      `/api/discover` would 403 for exactly the anonymous reader this is for.
- [x] Declared before the `/:id` routes in the controller. The router refuses
      at startup a table whose literal is written after the parameter.
- [x] Opens a thread owned by the caller, `guest:`-tagged identities included.
- [x] Titles it from the headline via `nameThread`, which also means
      `titleThread` never pays for a naming completion on these.
- [x] Appends ONE turn built from the story row + body, opening with the web
      retrieval sentence so `isRetrievedContext` files it as `CHUNK_ROLE`.
- [x] Everything after is the ordinary thread: `say()`, the sidebar, `/c/<id>`,
      steps, artifacts. No change to the conversation machinery.

## M6: Proving it

- [x] `npm run check:templates` before every build — a backtick in a css or
      html comment breaks the build and has done four times.
- [x] `set -o pipefail` on any build whose output is piped. A failed build has
      deployed before.
- [x] e2e: open the feed, click a card, read the article, ask twice, follow
      **Open in the console**, and assert the thread is at `/c/<id>` with the
      context turn NOT in the transcript.
- [x] Verify as a guest as well as signed in: article 200, ask 200, and every
      write to `/api/discover` still 403.
- [x] Drive the deployed page headless after deploying. A 200 is not
      verification.

## Deferred, and why

- **Photos.** Blocked on the crawler storing `og:image`; the column lands now
  so nothing shifts later.
- **Per-source retrieval.** The index has no url filter, so the body is
  retrieved on the headline and filtered by url here. A url or domain filter
  upstream would make this exact rather than approximate.

## What was learned building it

**`createRenderRoot() { return this }` on a page route produces TWO consoles.**
This is the one that broke Discover on production, and `pages/index.ts` had it
written down before I started. @lit-labs/ssr renders every LitElement into a
declarative shadow root whatever that method says, so the server's
`<agent-console>` arrives inside `<template shadowrootmode>`, the browser
adopts it, and Lit renders a second one beside the host. The adopted one is
hidden and holds the route's properties; the visible one has none of them.

Every symptom follows from that and every one of them misled me:

* `discover-page` and `discover-article` measured 0x0 — the hidden console.
* The chat home drew instead — the visible console, which never got `view`.
* `document.querySelector("agent-console").view` answered `"discover"` — the
  hidden one, so the probe reported success while the screen was wrong.
* Reverting the composer changed nothing, because the composer was never it.

`pages/settings/[[tab]].ts` had the same override, which is the real reason a
cold `/settings` link has always been blank — not the export style, and not the
optional-parameter form. All three routes keep their shadow root now.

**`export default` on a page does not register with the client router.** A
default-exported route server-renders correctly — 200, real markup, right
bytes — and then hydrates to a blank screen or the router's own 404 the moment
the bundle runs. Named exports (`export class PageDiscover`) work.
`pages/settings/[[tab]].ts` had been default-exported since it was written, so
a pasted `/settings` link has been answering 404 the whole time; nobody saw it
because Settings is opened by pushState from inside the console and never
loaded cold. Changed to a named export here as well, and it is STILL blank —
so the optional-parameter form (`[[tab]]`) is a second, separate defect. That
one is not fixed; splitting it into `index.ts` + `[tab].ts` the way
`pages/discover/` now is would do it.

**A status code is not verification, and neither is a probe.** Every broken
state answered 200, and the DOM probe answered "correct" from a hidden element
while the visible page was wrong. A screenshot was the only check that failed
when the page failed.

**Do not build a working tree two sessions are editing.** A concurrent session
was writing `src/tasks.ts` and `console.ts` throughout; one build died on a
half-written file, and the images shipped that session's in-flight state to
joule.sh alongside mine.

**Two model-output surfaces need one pipeline.** Reading `reply.text` raw
printed `[FOLLOWUPS]{...}[/FOLLOWUPS]` as prose at the foot of every answer —
the composer strips it and shows chips. `splitFollowups` was already exported;
the second surface simply was not calling it.

**Check the icon name.** `arrow-left` is not in the set, and `nr-icon` prints
the name it cannot draw, so the back button read "arrow-left Discover" on a
phone. It is `chevron-left`.

## Still open

- **Pictures.** The console side is done and proxied; the index carries an
  `image` for about 2 pages in 40, and none of the 18 current stories drew a
  source that has one. The lever is upstream extraction coverage, not here.
- **The ask box is not the console's composer.** It is a textarea that calls
  the same API and now the same reply parser. Attachments, the model picker,
  skills and slash commands are the composer's and are not here.
- **`pages/settings/[[tab]].ts`** — see above.

## Shipped since

**Discover server-renders.** `pages/discover/index.ts` and `[id].ts` each read
the engine in a `loader()` and hand the answer to the console as `seedFeeds` /
`seedArticle`; `discover-page` and `discover-article` take it in `willUpdate`,
which runs on the server where `connectedCallback` does not. Measured: the
HTML for `/discover` went from 33KB with no story in it to 214KB with the
headlines in it, and an article's standfirst and provenance now arrive in the
first byte rather than a round trip later.

**Every standalone screen has a route.** `/tasks`, `/artifacts`, `/knowledge`,
`/discover`, `/discover/<id>`. The rail rows push their addresses, so Back
works and a link says where it points. `/starts` is written and served by the
container but 404s at the edge — an allowlist in front of the app that nobody
here can see.

**Settings is an overlay again, deliberately.** It briefly had a route and a
view of its own; that made Back mean two different things depending on how you
arrived, and Settings has no content worth linking to. `pages/settings/` is
deleted. The scrim behind it blurs now, which is what says "the app is still
there" rather than "this is a darker screen".

**The rail toggle works above 1024px.** It only ever flipped the phone drawer,
so on every desktop the one control in the header did nothing at all.

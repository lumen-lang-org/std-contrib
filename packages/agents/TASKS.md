# Sandboxed plugin renderers — plan and tasks

The decision (option B): a card plugin's renderer is **source in the
community repo** (github.com/joule-sh/plugins), installed from a CDN url,
**snapshotted by the engine at install**, and executed by the console inside a
**sandboxed iframe** that has no cookies, no storage, no network and no reach
into the page. The console never compiles a plugin in and never fetches the
CDN itself.

## Architecture

```
joule-sh/plugins (community repo)
  plugins/<id>/manifest.json     cards + cases + "renderer": "./renderer.js"
  plugins/<id>/renderer.js       ES module: export default [{marker, render}]
  index.json

install (operator, one POST)
  POST /card-plugins/from-source {"sourceUrl": <cdn manifest url>}
  engine fetches manifest, resolves ./renderer.js against it, fetches THAT,
  stores: rows + rendererUrl (provenance) + rendererSource (the snapshot)

serve (engine)
  GET /card-plugins                    rows, guest-readable (config, no secrets)
  GET /card-plugins/:id/renderer      text/javascript, from the snapshot

run (console)
  boot: fetch /card-plugins, fetch each enabled plugin's renderer source
  host:  <iframe sandbox="allow-scripts" src="/plugin-host"> — null origin,
         own CSP (default-src 'none'; script-src blob: 'unsafe-inline'),
         blob-imports the module, answers {marker, content, evidence} → html
  guard: the returned html is SANITIZED in the console before insertion
         (no scripts, no on*, https-only urls), then swapped in for the
         [MARKER]{...}[/MARKER] block
  fallback: renderer missing/slow/broken → the model's line stays visible text
```

Why the snapshot rather than console-side SRI: integrity by construction (the
code that runs is the code installed, not what the URL serves today), a CDN
outage cannot take cards down, and no CSP widening — the console loads
renderers from its own origin. The CDN url is recorded as provenance.

Why the render pass is separate: `renderWithCards` is a synchronous string
pipeline and the sandbox answers over postMessage. `renderPluginCards(raw,
evidence): Promise<string>` resolves plugin blocks BEFORE the sync pipeline
runs, at the call sites in chat-session. Built-in cards (currency, text) are
untouched.

## Tasks

### Engine
- [x] `card_plugins.renderer_url` (migration 97.3) — provenance
- [x] `card_plugins.renderer_source` (migration 97.4) — the snapshot
- [x] fix CardPluginRow construction sites for the two new fields
- [x] `from-source`: resolve `renderer` relative to the manifest url, fetch,
      refuse an install whose renderer cannot be fetched, store both fields
- [x] `GET /card-plugins/:id/renderer` → `text/javascript` from the snapshot
- [x] compile, migrate, restart; reinstall linear-cards from the repo manifest

### Console
- [x] `server/plugin-host.ts` (middleware, not a page — a page rides the shell): the sandbox document, served with its own CSP
      (`default-src 'none'; script-src blob: 'unsafe-inline'`), loaded as
      `<iframe sandbox="allow-scripts">` — null origin, parent CSP does not
      apply. postMessage protocol: `{id, marker, content, evidence}` in,
      `{id, html}` out, with a load handshake and a per-render timeout.
- [x] `src/plugin-cards.ts`: host lifecycle; `loadPluginRenderers()` at boot;
      `renderPluginCards(raw, evidence)` — find plugin-owned markers, render
      through the host, sanitize, replace; unknown/failed marker stays text.
- [x] the sanitizer: DOMParser walk — drop script/iframe/object/embed/meta/
      link/style elements, drop `on*` and `srcdoc` attributes, urls must be
      https: (href/src), `target=_blank` gains `rel=noopener noreferrer`.
- [x] chat-session: await the plugin pass at the two render sites (reply
      landing, transcript reload).
- [ ] keep the built-in Linear renderers as fallback until the repo is public
      and the CDN serves it; then delete them from cards.ts.

### Repo (joule-sh/plugins)
- [x] restructure to `plugins/linear-cards/{manifest.json,renderer.js}`
- [x] move the two Linear renderers into `renderer.js` (plain JS, no imports —
      the sandbox has no module graph beyond the one file)
- [x] manifest gains `"renderer": "./renderer.js"`; README documents the
      sandbox contract: pure function of (content, evidence) → html string,
      no fetch, no DOM outside the string, budget ~50ms per render
- [x] index.json points at both files

### Verification
- [ ] e2e `plugin.spec.ts`: serve manifest+renderer from a local double,
      install through `from-source`, converse, assert the sandboxed card drew
      and that a hostile renderer (script tag, onclick, javascript: href) is
      stripped by the sanitizer — that assertion IS the security test.
- [ ] linear.spec: unchanged and green — the cycle card now drawn through the
      sandbox; issues card once list_issues args are right.
- [ ] deploy both consoles, screenshot the drawn card from prod.

## Open questions (not blocking)
- repo is PRIVATE → jsDelivr 404s. Public is the owner's call; everything
  above works against any https manifest url meanwhile.
- `list_issues` "Invalid input" on guessed args — separate bug, next in line.
- marker collision policy when two plugins claim one marker: first installed
  wins, second install refused with the name — to implement with the loader.

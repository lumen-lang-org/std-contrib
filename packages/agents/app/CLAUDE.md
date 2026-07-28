# The agent console

A Vite + Lit front end for the `agents` package. `npm run dev` serves it and
proxies `/api` and `/preview` to the Lumen API on 8100.

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

## Tests drive the UI, not the API

An e2e test types into the composer and reads what appears. The API is for
*arranging* rows a scenario needs and for *asserting* what was really stored —
never for performing the action under test. A test that posts to `/api` and
then checks the database has verified the API, which the API's own tests
already do, and has said nothing about the thing a person touches.

Two mechanical notes that cost real time to learn:

- The chat composer is a `contenteditable` div, not a `textarea`.
- Playwright pierces open shadow roots for CSS, so `#c-name input` reaches
  inside a LumenUI field. But `toBeEmpty()` reads *light-DOM* children, so it
  answers "empty" for any component that renders into a shadow root however
  much is on screen. Assert on text, not on emptiness.

## Fixtures may not cost more than they prove

A credential can never be read back, by design. A fixture that overwrites one
cannot restore it — this suite once replaced a real provider key with
`e2e-not-a-real-key` on every run. Write a key only where none exists.

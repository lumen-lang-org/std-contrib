# Showing an edit the way a reviewer reads one

What exists today: the card says `Edited /index.html +1 -1` and opens into two
bounded blocks, the old text and the new. Honest, but flat — no line numbers,
no surrounding file, no colour, and cut at 1,500 bytes a side. What this
specifies: the view a code reviewer expects — the file itself, numbered, with
the changed lines marked in the gutter and everything around them for context.

Nothing here exists yet. This is the design and the order to build it in.

## The insight that makes it cheap

An edit never needs its own diff storage, because **both sides already exist
whole**. `edit_artifact` turns version N-1 into version N, and
`artifact_versions` is append-only: the two complete bodies sit in the log
forever, addressable as `/threads/:id/artifacts/:slot/versions/:n`. The diff
is derived at view time from the two versions — never stored, never capped,
never stale, and it works retroactively for every edit ever made.

That generalises past `edit_artifact`, and the design should embrace it: a
`write_artifact` that rewrote a file, and a `run_script` whose reconcile
appended a version, produce exactly the same pair of whole bodies. One diff
view serves all three doors. The edit chip is merely the deepest link into it.

## What the step row needs to learn

The chip's row stores `{path, added, removed, old, new}`. To deep-link it
needs the address of the pair: `{slot, version}` — version N, with N-1 implied.
That is written when the step closes (the version number is in the edit's own
result), two ints on a row that already exists. The `old`/`new` excerpts stay:
they are what the card shows inline without a fetch, and what survives if the
versions are ever rotated away.

## The view

Clicking the chip opens the artifact rail on a **diff mode** of the panel that
already shows versions as pills:

```
/index.html   v1 -> v2                                    [unified | split]

  38   38   <nav>
  39   39     <a href=/index.html>Home</a>
  40      -   <h1>Kaffa</h1>
       40 +   <h1>Kaffa Roasters</h1>
  41   41   <script src=js/app.js></script>
```

- **Line-level first.** A hand-written line LCS (the two bodies are already
  split on `\n` everywhere else in this codebase) — no diff dependency. Within
  a changed run, a second pass marks the common prefix/suffix of each line
  pair so the changed *words* carry the stronger colour. Myers-quality
  minimality is not a goal; stable, readable output is.
- **Collapsed context.** Unchanged runs longer than ~20 lines fold to
  `... 214 unchanged lines ...` with a click to open, so a one-line edit in a
  4,000-line file reads as one screen, not a scroll.
- **Syntax colour** comes from the highlighter the console already ships
  (`nr-code-editor`'s highlight.js, already in the canvas bundle), applied per
  side before the gutter marks go on. A kind with no grammar renders plain.
- **Any adjacent pair.** The version pills grow a "compare" affordance:
  v3 -> v4 is the same component the chip deep-links to for its own pair. An
  image kind refuses politely — "binary versions are compared by looking at
  them" — and offers the two previews side by side instead.
- The two bodies arrive by the existing version route; the panel diffs in the
  client. No new API surface beyond the two ints on the step row.

## Where it does not go

Not into model context. The model already gets the edit echo (changed lines
plus two of context) in the tool result; a rendered diff is for the person.
And not into `nr-chatbot`'s message stream as markup — the card's chip stays
compact, and the rail is where a file-sized view belongs; a diff pasted into
the transcript would be re-rendered on every message append.

## Failure table

| what goes wrong | what happens |
|---|---|
| version N-1 was rotated away | the chip's stored old/new excerpts render, flagged "history incomplete" |
| the two bodies are identical | said plainly — "these versions do not differ" — never an empty pane |
| a version is half a megabyte | context folding caps the DOM; the diff itself is linear in lines |
| the kind is image | two previews side by side, no textual diff |
| the step row predates the slot/version fields | the chip renders as today; the deep link is absent, not broken |
| the artifact was deleted | the pane says so and shows the excerpts, same as rotation |

## Build order

1. The line-LCS and fold logic as a pure module in `app/src`, unit-tested on
   strings alone — no component, no fetch.
2. The diff pane in `artifact-panel.ts`, driven by two version numbers, with
   the pills' compare affordance.
3. The two ints on the edit step row (written at `endStep`, read by the chip),
   and the chip's deep link into the pane.
4. Word-level emphasis inside changed runs.
5. The `run_script` and `write_artifact` chips learn the same link — one
   sentence each, since the pane already exists.

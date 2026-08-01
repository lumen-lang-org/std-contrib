# The Kimi design system, read from the live page

What kimi.com actually ships, measured off the DOM on 2026-07-29 (1440×900,
light theme): computed styles, stylesheet rules, keyframes, and the SVGs
themselves — not a guess from screenshots. Focus: shapes, placement, icons,
animation.

## The one idea

Almost everything is **ink on paper**: black at some opacity over white or
near-white. Color is reserved for *meaning* — one blue (`#1783ff`) for
selection and links, and a small accent set (red/green/orange/yellow/purple)
for states. Nothing decorative is colored. Depth comes from radius and a
whisper of shadow, not from borders; separators barely exist
(`rgba(0,0,0,0.13)`).

## Tokens

The palette is opacity-stepped black, four levels each for text and fills,
and every token ships `-hover` / `-active` siblings that are computed darkenings
of the base — state changes are token lookups, never ad-hoc colors:

| role | value |
|---|---|
| Text primary | `rgba(0,0,0,0.9)` |
| Text secondary | `rgba(0,0,0,0.6)` |
| Text tertiary | `rgba(0,0,0,0.45)` |
| Text quaternary (placeholders) | `rgba(0,0,0,0.3)` |
| Fill F1…F4 (hover washes → scrims) | black at 3%, 5%, 15%, 25% |
| Separator S1 | black at 13% |
| Page ground (`--Bg-GroundPC`) | `#fbfaf9` — warm, not gray |
| Card / popover | `#fff` |
| Secondary surface | `#f5f5f5` |
| Accent (`--Colors-KMBlue`) | `#1783ff` |

Our reading of this table lives in **`head.html`**, as `:root` custom
properties. It used to live in `index.html`; phase 5 of MIGRATION-LUMENJS.md
deleted that file with the rest of Vite, and LumenJS inlines `head.html`
verbatim into the document head instead. The location matters more than it
looks: `:root` is a document-level selector and every element in this console
renders into a shadow root, so a token sheet moved into a layout or a
component would define variables nothing can see. If a colour comes out wrong
everywhere at once, this is the file.

Type ramp is a fixed scale with names, each size paired to its line-height
(never free-floating): UI runs T1 18/26, T2 16/24, B1 15/22, B2 14/20,
C1 12/18, C2 10/14; markdown content gets its own parallel ramp (H1 22/36 …
body 16/26). Font is simply `-apple-system` — the system stack, no webfont
for UI text.

## Shapes

Radius is large and tiered by component class, not by size:

- **24px** — the composer card (the hero surface).
- **16px** — popovers/menus.
- **12px** — the workhorse: sidebar nav items, list rows, buttons. The most
  common radius on the page (19 of ~55 rounded elements).
- **20px / full** — pills: suggestion chips, tags, the circular send button.
- **8–10px** — small controls nested inside a 12px parent; 4px only for tiny
  tags (the `Beta` badge, kbd hints).

Rules that fall out of the measurements:

- **Borders are rare.** The composer card is the only bordered surface on the
  home screen: `1px solid rgba(0,0,0,0.17)` plus a soft double shadow
  (`0 4px 12px rgba(0,0,0,0.03), 0 5px 16px -4px rgba(0,0,0,0.07)`).
  Everything else separates by background delta alone.
- **Popovers float on shadow only**: `0 4px 16px rgba(0,0,0,0.10)`, radius
  16px, white, no border.
- **Buttons have no chrome at rest.** A sidebar nav item is a transparent
  40px-tall, 12px-radius row; hover paints Fill-F1 behind it. Shape appears
  on interaction, not before.
- The send button is a **36px circle** (radius 22px on a 36px box), black
  when armed, `rgba(0,0,0,0.15)` with white glyph when disabled — the
  strongest ink on the page is the primary action.

## Placement

Two-column shell: a **240px sidebar** on the ground color, and a content pane
that reads as a white sheet with the ground showing as a gutter around it
(the sheet has its own rounded top corners, `24px 24px 0 0`).

Sidebar, top to bottom, is a strict hierarchy:

1. Brand mark (28px black rounded square) left, collapse toggle right.
2. **New Chat** — the only outlined-feeling row, full-width, with its
   keyboard shortcut (`Ctrl K`) right-aligned in kbd tags.
3. Nav list: 40px rows, icon 24px + 8px gap + label, 224px wide inside 8px
   side padding. Sections collapse behind a "Collapse ⌄" row.
4. `Chats` group label in tertiary text, then history.
5. Pinned to the bottom: promo card, then account row.

Content pane centers a single **768px column** (composer, chips, explore bar
all share this width). Vertical rhythm on the home screen: logo, ~40px,
composer, ~24px, one row of suggestion chips. The composer is placed at
roughly the upper third — the page's center of gravity, not its geometric
center.

Inside the composer card (min-height 130px): the editor area (16/24 text,
placeholder in quaternary ink) on top; a 36px **action strip** on the bottom
edge — attach (`+`) far left, model selector + send far right. Meaning:
content in the middle, configuration pushed to the card's edges,
primary action in the bottom-right corner. The model selector is
label-only ("Instant **High**" with the effort in tertiary ink) — a control
disguised as text until hovered.

Menus place a check mark on the *right* edge for the selected item, titles
in primary ink with a one-line description in tertiary underneath, and a
separator only between groups, never between items.

## Icons

One drawn system, consistently applied:

- **24×24 viewBox, stroke-drawn at `stroke-width: 1.8`** (occasionally 1.7),
  round caps, mostly `fill="none"` — a thin-outline set in the Lucide/Feather
  genre but custom (some glyphs mix a filled `fill-rule` shape with strokes).
- Icons inherit ink: they are stroked in `currentColor` and sit in a fixed
  `icon-wrapper` span, so text color changes (hover, selection) restyle the
  icon for free.
- A second, legacy grid exists — `viewBox 0 0 1024 1024` **filled** glyphs
  (iconfont-style) rendered at 16–18px or `1em` — used for small utility
  marks: chevrons, external-link arrows, trailing decorations. New-style
  icons carry meaning; the 1024-grid ones are furniture.
- Sizing discipline: 24px in nav and composer, 16–18px for trailing/inline
  marks. No third size on the page.
- Every list row leads with its icon; chips repeat the same glyph at the same
  stroke so the suggestion pill and the sidebar row for "Slides" are visibly
  the same feature.

## Animation

Fast, opacity-and-transform, one shared easing vocabulary:

- **Two speeds.** Interaction feedback is `0.15s` (background-color, color,
  box-shadow on rows/buttons — `cubic-bezier(0.23, 1, 0.32, 1)`, an
  aggressive ease-out); structural moves are `0.3s ease-in-out` (sidebar
  transform, width/margin collapse, gap changes). Nothing meaningful is
  slower than 0.5s.
- **Enter = fade + small move.** Popovers and cards come in with
  `opacity 0→1` plus either `scale(0.8→1)` or `translateY(20px→0)`,
  0.15–0.3s. Exits reuse the same pair with ease-in. No bounces, no springs.
- **The sidebar collapses by transform**, `transform 0.3s ease-in-out`, while
  dependent widths/margins animate on the same clock so the content column
  re-centers in step.
- **Loading is rotation or dot-phasing.** Buttons get a spinning stroke
  (`km-button-loading-rotate`, 360° linear); the branded loader is five dots
  phase-shifted through an opacity wave (`core-spiral-loading-dot-p0…p4`,
  each dot's peak offset ~13% of the cycle) — a ripple, not a blink.
  Streaming text placeholders use a background-position `shimmer`.
- **Attention is a pulse**: `scale(1→0.8→1)` with opacity `1→0.62→1` on
  resource-card dots — small amplitude, symmetric.
- State changes on the send button animate **background-color only**
  (`0.15s cubic-bezier(0.4,0,0.2,1)`) — the shape never moves; ink arrives.

## What to steal for our console

1. Opacity-stepped ink instead of a gray ramp — text and fills as
   `rgba(0,0,0,x)` keeps every overlay legible on any surface, and gives
   hover/active as computed steps of the same token.
2. Radius tiers: 24 hero / 16 popover / 12 controls / pill chips — and
   borders only on the composer-class surface; everything else separates by
   background alone.
3. One stroke icon system, 24px at 1.8 stroke, inheriting `currentColor`
   from its row — which is exactly what `nr-icon` already does; the lesson
   is the *two-size* discipline (24 leading, 16 trailing) and repeating the
   same glyph wherever the same feature appears.
4. The two-speed animation rule: 0.15s ease-out for feedback, 0.3s
   ease-in-out for layout, fade+4–20px move for entrances — and never
   animate a shape when ink alone can say it.

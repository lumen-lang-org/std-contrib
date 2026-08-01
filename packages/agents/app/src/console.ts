// The shell: sidebar | header + chat | workspace. Each region is its own
// element in its own file; this one only wires them together. The chat area
// is LumenUI's <nr-chatbot>, driven through its properties and events —
// nothing here reaches into it.

import { LitElement, css, html, nothing } from "lit";
import { BRAND, WORDMARK } from "./brand.js";
import { customElement, property, state } from "lit/decorators.js";
import "./ui.js";
import "./sidebar.js";
import "./artifact-panel.js";
import "./settings.js";
import "./knowledge.js";
import "./canvas.js";
import "./login-overlay.js";
import "./model-picker.js";
import {
  AgentFull, ArtifactListing, Me, ModelChoice, ModelRow, ThreadListing, TurnArtifactRef, WireRef,
  SIGNED_OUT, SkillRow, TemplateRow, artifactsByTurn, featuredSkills, listAgents, listArtifacts,
  listModels, listThreads, modelChoices, previewUrl, listTemplateFiles, offerThread, remixThread, replayableThreads, startFromTemplate, transcript, templatePdf, templatesOfKind, whoami,
} from "./api.js";
import { ChatSession } from "./chat-session.js";
import * as live from "./live.js";


/* The conversation the address names, or "". One function, because the shape
   of the URL is the sort of thing that otherwise gets half-changed: this used
   to be `?c=<id>` on the root, and only moved to a path once the gateway had
   a location for it (locations/agents.conf). */
function currentId(): string {
  const m = /^\/c\/([^/?#]+)/.exec(location.pathname);
  return m === null ? "" : decodeURIComponent(m[1]);
}

/* What the route page's loader read, whichever shape it read it in.
 *
 * `GET /threads/:id` used to answer a bare array of turns and now answers
 * `{modelChoiceId, messages}` — a conversation's current model choice is a
 * fact about the thread and an array has nowhere to put one. The loader in
 * pages/c/[id].ts hands its body through verbatim as `seedTurns`, so this
 * element is the last place that can tell the two apart, and it has to: an
 * object reaching `apply` unrecognised is `turns.map is not a function` thrown
 * inside a server render, which answers a 500 for a conversation that opens
 * perfectly well on the client a moment later.
 *
 * Both shapes rather than the new one alone, because the seed also arrives
 * from an older cached page and from `pages/index.ts`, which hands `[]`. */
function seedOf(seed: unknown): { turns: unknown[]; modelChoiceId: string } {
  if (Array.isArray(seed)) { return { turns: seed, modelChoiceId: "" }; }
  const held = seed as { messages?: unknown; modelChoiceId?: unknown } | null;
  const messages = held?.messages;
  if (!Array.isArray(messages)) { return { turns: [], modelChoiceId: "" }; }
  return {
    turns: messages,
    modelChoiceId: typeof held?.modelChoiceId === "string" ? held.modelChoiceId : "",
  };
}

/* A capability's face in the row. The engine knows skills by name; the row
   shows a verb and a glyph, and this is the one place that mapping lives.
   A skill with no entry here still appears, under its own name — the row is
   generated from the operator's featured list, not from this table. */
const CAPS: Record<string, { label: string; icon: string; kind: string }> = {
  "make-doc": { label: "Docs", icon: "file-text", kind: "doc" },
  "make-sheet": { label: "Sheets", icon: "table", kind: "sheet" },
  "make-deck": { label: "Slides", icon: "image", kind: "deck" },
  // No templates ship for a site yet, so this chip pins the skill and shows no
  // "Start from" row — which is the honest state, not a gap: a site's starting
  // point is a sentence about what it is for, and the composer is right there.
  "make-site": { label: "Site", icon: "globe", kind: "site" },
};
const capLabel = (name: string) => CAPS[name]?.label ?? name;
// The fallback for a skill this table does not know, and it has to be a name
// the icon set actually has. `book-open` was not one: nr-icon draws the NAME
// when it has no glyph for it, so every unmapped skill rendered the literal
// word "book-open" where its icon belongs — in the capability row and in the
// composer's + menu, which is exactly where a new skill first appears.
// `tool` is in the set (checked against icon-paths.js, 150 names) and is the
// honest generic: a skill is a thing the agent can use.
const capIcon = (name: string) => CAPS[name]?.icon ?? "tool";
const capKind = (name: string) => CAPS[name]?.kind ?? "";

/* Take the heavy click ring off LumenUI's controls.
 *
 * Its buttons draw `outline: 0.25rem solid #7c3aed` on focus — a 4px violet
 * square. On the composer's `+` that lands as a box bigger than the button:
 * clicking it opens the menu, focus returns to the button when the menu
 * closes, `:focus-visible` matches that programmatic return, and the ring
 * stays. It is the loudest mark on the page and it is telling the person who
 * just clicked where they clicked.
 *
 * Removed on the LumenUI components rather than softened, which is a real
 * trade and is recorded here rather than left to be discovered. `:focus-visible`
 * is how a keyboard user knows where they are, and these components no longer
 * say. What made softening insufficient: the ring is not only drawn on a
 * genuine tab — closing the `+` menu returns focus to the button
 * programmatically, `:focus-visible` matches that, and a 2px ring sat there
 * after every use of the menu just as the 4px one had.
 *
 * The console's OWN controls keep theirs — sidebar.ts and settings.ts still
 * carry `:focus-visible { outline: 2px solid var(--focus) }`, and this sheet is
 * only handed to component shadow roots — so tabbing through the shell is still
 * followable. If the whole interface should lose it, that is those two rules,
 * and it should be a decision rather than a side effect of this one.
 *
 * Handed to each component's shadow root because that is where the rule lives
 * — a stylesheet out here cannot reach inside one. The walk is deep for the
 * same reason: nr-button appears inside nr-chatbot, inside artifact-panel,
 * inside settings, each behind its own root. `dressed` latches per root so a
 * re-render does not keep stacking sheets. */
const FOCUS_RING = `
  :host(:focus), :host(:focus-visible), :host(:focus-within),
  button:focus, button:focus-visible, button:focus-within,
  a:focus, a:focus-visible,
  [tabindex]:focus, [tabindex]:focus-visible,
  input:focus, input:focus-visible,
  select:focus, select:focus-visible,
  textarea:focus, textarea:focus-visible {
    outline: none !important;
    box-shadow: none !important;
  }
  /* The other half of the mark, and the easier one to miss: as well as the
     outline, these controls repaint their 1px border violet on focus
     (#7c3aed, hardcoded in the component — no custom property to set). At
     rest the composer's plus is a near-white rgb(239,243,244); focused it went
     violet and stayed that way after the menu closed. Held at the console's
     own --border instead, which inherits across the shadow boundary the way
     every custom property does, so it follows the theme rather than pinning a
     second grey. */
  button:focus, button:focus-visible, button:focus-within,
  input:focus, input:focus-visible,
  select:focus, select:focus-visible,
  textarea:focus, textarea:focus-visible {
    border-color: var(--border, #eff3f4) !important;
  }
`;

/* The conversation's gutters, and the composer's plus.
 *
 * Measured off the live component at 430px, which is where these numbers come
 * from rather than taste:
 *
 *   .messages        padding 8px 4px   → a reply starts at x=4, and the user
 *                                        bubble ends 4px off the right edge
 *   .input-box       padding 8px 0     → the composer sits on the very bottom
 *   .input-container padding-left 20px, padding-right 8px — not symmetric
 *
 * Kimi holds ~20px on both sides of a turn and floats the composer off the
 * bottom. Text touching the edge of a phone screen is the single loudest
 * difference between the two, and it is four pixels.
 *
 * The plus is the other half. It is an nr-button, and its inner <button>
 * carries `color: rgb(83,100,113)` — a slate blue-grey hardcoded in the
 * component, no custom property behind it — plus a 1px rgb(239,243,244)
 * border. That colour is in neither palette; it is simply what the component
 * ships. Held at --fg so it matches the header icons and the body text, the
 * way every icon in the chrome now does.
 *
 * Kept OUT of FOCUS_RING and applied only inside nr-chatbot, because that
 * sheet is handed to every component root on the page: `button { border: 0 }`
 * there would also flatten the filled buttons in settings and the sidebar,
 * where the border is load-bearing. */
const CHAT_SKIN = `
  /* Empty on purpose, and kept as the seam.

     Everything this held — the composer's 16px gutters, the pill's inner 12,
     the action row's reserved height — moved into the component's own static
     styles (chatbot.style.ts). An adopted sheet exists only AFTER hydration,
     so each of those rules was false for exactly one frame: the composer
     painted at the component's padding and then jumped to the app's, and on a
     centred home screen the wordmark rode up and back down with it. That was
     the load bounce, and it was never the capability chips.

     Anything added back here inherits that flaw. A rule that changes the SIZE
     of a box belongs in the component; this is for what can honestly arrive
     late. */
`;

const CHAT_BUTTON = `
  button { border-color: transparent !important;
           color: var(--fg, rgba(0,0,0,.9)) !important; }
  button:hover { border-color: transparent !important;
                 background: var(--bg-sunken, rgba(0,0,0,.045)) !important; }
`;

/* Dress the chat component and only the chat component. Same `dressed` latch
   as softenFocusRings, under a second flag so the two passes do not cancel
   each other out on a root that both visit. */
function dressChat(root: ParentNode) {
  // As Element: the generated type for <nr-chatbot> does not declare
  // shadowRoot, though every element has one open here.
  const chat = root.querySelector("nr-chatbot") as Element | null;
  if (chat === null || chat.shadowRoot === null) { return; }
  adopt(chat.shadowRoot, CHAT_SKIN, "skinned");
  for (const el of chat.shadowRoot.querySelectorAll("nr-button")) {
    if (el.shadowRoot !== null) { adopt(el.shadowRoot, CHAT_BUTTON, "skinned"); }
  }
}

function adopt(sr: ShadowRoot, text: string, flag: string) {
  const marked = sr as ShadowRoot & Record<string, unknown>;
  if (marked[flag] === true) { return; }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, sheet];
  marked[flag] = true;
}

function softenFocusRings(root: ParentNode) {
  for (const el of root.querySelectorAll("*")) {
    const sr = (el as Element).shadowRoot as (ShadowRoot & { dressed?: boolean }) | null;
    if (sr === null) continue;
    if (sr.dressed !== true) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(FOCUS_RING);
      sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, sheet];
      sr.dressed = true;
    }
    softenFocusRings(sr);
  }
}

@customElement("agent-console")
export class AgentConsole extends LitElement {
  static styles = css`
    /* The composer's tokens are in head.html on :root, not here. nr-chatbot
       is not a child of this shadow root, so a rule for the tag matches
       nothing — silently — and even :host did not carry them down in
       practice. head.html is where the palette already lives. */
    :host { display: flex; height: 100%; }
    console-sidebar { width: 264px; flex: none; }
    /* The scrim behind a layer that covers. Two of them — the nav drawer and
       the files sheet — and each is what dismisses its own layer: a tap
       anywhere else. Hidden above the breakpoint, where neither layer covers
       anything and a dimmed page would be dimming nothing. */
    .scrim { display: none; background: rgba(0,0,0,.28); }
    .center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    /* No rule under the header. Measured against Kimi at the same width: it
       draws no divider anywhere on the page — header, turns, composer are all
       separated by space alone. A hairline here is the only horizontal line
       on a phone screen and it reads as chrome around the conversation
       rather than as structure. The sticky background is what keeps the bar
       legible over scrolled content; the border was never doing that job. */
    header { display: flex; align-items: center; gap: 10px; padding: 10px 18px;
             background: var(--bg);
             /* Pinned. The chat pane is the thing meant to scroll, but on a
                phone the document itself can scroll when content overflows,
                and the bar carrying the drawer toggle and the conversation
                title is the one thing that must not leave with it. sticky
                rather than fixed, so it costs nothing when the document is
                not the scroller. */
             position: sticky; top: 0; z-index: 40; }
    /* 500, not 600. The title is the name of the thing you are already looking
       at, so it wants to be legible rather than announced — Kimi sets its own
       at the body weight. At 600 it was the heaviest mark on a phone screen
       and pulled the eye away from the conversation under it. */
    .title { font: 500 17px var(--display); overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; flex: 1; }
    .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px;
            border: 1px solid var(--border); border-radius: 999px; padding: 3px 11px;
            color: var(--muted); background: var(--bg-card); }
    .chip .bolt { color: var(--accent); }
    select { background: var(--bg-card); border: 1px solid var(--border); color: inherit;
             border-radius: 8px; padding: 4px 8px; font: inherit; }
    /* An icon, not a button that contains one.
     *
     * Two things were wrong and they compound. The outline made each glyph a
     * box, so the header read as a toolbar; and the glyph itself was --muted,
     * which is rgba(0,0,0,.45) and renders 140,140,140 on white. Sampled
     * against Kimi at the same width, its header and composer icons are
     * 25,25,25 — the SAME ink as body text — and it spends grey only on the
     * per-message actions under a reply, where secondary is the point.
     *
     * So: no border, and full-strength ink. --muted is still right for text
     * that is genuinely subordinate (.run-row, .card-meta, .cap); it was never
     * right for the only control in the corner of the screen. Hover moves to a
     * background wash, which is the affordance the border was standing in for.
     */
    /* 20px glyph in 8px of padding — a 36px tap target. These are the only
       controls in the header and were drawn at 6px/16px, which on a phone is
       under the 44px Apple and 48px Material both ask for and read as
       decoration next to the 54px wordmark. */
    /* 18px glyphs, not 20. The library's scale is 14, 20, 24 — a 43% jump
       from small to medium — and this row had to pick one: at 14 it matched
       the nav rail and read as nothing, at 20 it was the largest icon on the
       page and top-heavy. 18 sits above the rail without shouting, and it is
       reachable at all because nr-icon now takes --nuraly-icon-size over
       whichever step is named. Setting a width here would do nothing: the svg
       is sized inside the component's shadow root. */
    .icon { background: none; border: 0; color: var(--fg);
            border-radius: 8px; padding: 8px; cursor: pointer; font: inherit;
            --nuraly-icon-size: 18px; line-height: 1;
            display: inline-grid; place-items: center;
            transition: background-color .15s cubic-bezier(.23,1,.32,1); }
    .icon:hover { background: var(--bg-sunken); }
    .icon[aria-pressed="true"] { background: var(--bg-sunken); }
    main { flex: 1; min-height: 0; }
    /* The cards live in this element's own DOM, below the chat — never inside
       the component's messages. Its artifact mode re-extracts fences from the
       displayed text and matches them to rows by position, which is exactly
       the text-order mapping the refs exist to replace. */
    /* What the run is doing. Sits above the artifact cards: those are what a
       round produced, this is what it is doing to produce them. */
    .run { border: 1px solid var(--border); border-radius: 10px;
           background: var(--bg-card); margin: 0 16px 8px; overflow: hidden; }
    .run-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
                border-bottom: 1px solid var(--border); font-weight: 500; }
    .run-row { display: flex; align-items: center; gap: 8px; padding: 8px 14px;
               color: var(--muted); font-size: 13px; }
    .run-row + .run-row { border-top: 1px solid var(--border); }
    .run-row.on { color: var(--fg); }
    .run-name { font-family: var(--mono); color: var(--fg); white-space: nowrap; }
    .run-args { flex: 1; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; font-family: var(--mono); font-size: 12.5px; }
    .run-ms { font-variant-numeric: tabular-nums; white-space: nowrap; }

    /* --- narrow ---------------------------------------------------------
       Kimi measured at three widths: the rail stays 240 and the content
       column is what gives — 734px at 1440, 333px at 420. So the column is
       fluid and the rail is a constant, which only works while there is room
       for both. Below that the rail stops being a column and becomes a thing
       you summon: off-canvas, over the content, dismissed by touching it.

       1024 rather than a phone width, because the second rail (artifacts,
       workspace) is 320px and a chat pane squeezed between two fixed columns
       is unusable long before the viewport is a phone. */
    @media (max-width: 1024px) {
      console-sidebar {
        position: fixed; inset: 0 auto 0 0; z-index: 60;
        transform: translateX(-100%);
        transition: transform .22s cubic-bezier(.23,1,.32,1);
      }
      /* The shadow belongs to the OPEN drawer, not to the element.
         translateX(-100%) moves the box off screen but a 32px blur still
         paints from where its right edge now is — which is x=0 — so a closed
         drawer smeared a grey gradient down the left of every phone screen.
         It reads as a rendering fault rather than as depth, and it was on
         every screenshot of this console. Painted only while open. */
      :host([nav]) console-sidebar {
        transform: none;
        box-shadow: 0 0 32px -8px rgba(0,0,0,.28);
      }
      :host([nav]) .scrim.nav {
        display: block; position: fixed; inset: 0; z-index: 55;
      }
      /* The drawer toggle only exists where the drawer does. */
      .icon.nav { display: inline-grid; }
      /* The second rail stops sharing the width and becomes a sheet, in the
         same frame settings uses: 80vh centred, 12px of side margin, 14px
         corners — measured off nr-overlay at 390x844 rather than guessed, so
         the two layers land in exactly the same rectangle.

         It used to be a full-bleed 100vw column, on the argument that a
         document is what you came to look at so it should have the screen.
         That reasoning was about the document and forgot the reader: with no
         scrim and no edge, an opaque white column IS the page, so there is
         nothing to say a conversation is still underneath it or that touching
         anything will bring it back. Settings answers that with a dimmed
         backdrop, and the panel had no reason to answer it differently. */
      artifact-panel {
        position: fixed; inset: 10vh 12px; z-index: 50;
        /* width AND height, both auto, because the panel sets each to a fixed
           value for the docked column it normally is — and a height of 100%
           on a fixed box resolves against the viewport, not against the inset,
           so the sheet ran 10vh past the bottom of the screen with its lower
           corners somewhere below the fold. */
        width: auto; height: auto; border-radius: 14px;
        /* The radius is only real if the content is clipped to it, and the
           panel's own children (header, list, the preview iframe) all paint
           to its edges. */
        overflow: hidden; border-left: 0;
        box-shadow: 0 18px 48px -12px rgba(0,0,0,.35);
      }
      .scrim.files { display: block; position: fixed; inset: 0; z-index: 45; }
    }
    @media (min-width: 1025px) { .icon.nav { display: none; } }

    /* --- phone -----------------------------------------------------------
       One column, and the second rail takes the whole screen: at this width a
       420px panel beside nothing is just a narrower page with a gap. */
    @media (max-width: 640px) {
      header { padding: 8px 12px; gap: 6px; }
      /* The home group centres on a phone rather than hanging from a fixed
         16vh. That padding is measured against a desktop window, where it puts
         the wordmark at the eye's starting point; on a tall narrow screen it
         pins everything to the top third and leaves half the display empty
         below the composer — which is what a first load looks like on a phone.
         Centring keeps the same relationship between wordmark and composer at
         any height. */
      nr-chatbot::part(chatbot-boxed-area),
      nr-chatbot .chatbot-boxed-area {
        justify-content: center !important;
        padding-top: 0 !important;
      }
      /* The composer's side space on a phone, measured off Kimi at 390px: its
         field sits at x=19, so ~19px of screen each side. Ours ran to x=8,
         close enough to the edge that the field's own 24px corner had nothing
         to be rounded against.

         Applied to main — the element this component actually owns — and not
         to the composer. The padding that positions it lives on .input-box
         inside nr-chatbot's shadow root, and nothing written here reaches
         that: not a tag selector (nr-chatbot is not a child of this root),
         not ::part (the component exposes none), not a token (a rule with a
         plain shorthand already wins on that element). Insetting the column
         moves the transcript with it, which is what Kimi does anyway. */
      main { padding-left: 11px; padding-right: 11px; }
      .title { font-size: 15px; }
      /* The model chip is the first thing to go: it names a choice you make
         rarely, and the picker beside it still says which agent is answering. */
      .chip { display: none; }
      /* No width rule for the panel here any more. It used to be pinned to
         100vw at both breakpoints; the sheet above sizes from its own inset,
         and a width would fight it and win. */
      .cards { padding: 8px 12px 12px; }
      .card { max-width: 100%; }
    }

    /* The capability row, Kimi's: borderless, one line, scrolls sideways.
       Verbs rather than buttons — an outlined pill each would read as a
       toolbar, and a second line would push the composer off a phone. */
    /* In the empty state the composer sizes to its content and the group —
       wordmark, composer, capabilities — centres together. Without this
       nr-chatbot keeps flex:1, eats the column, and the row lands at the
       bottom edge of the window with the composer stranded in the middle. */
    /* Upper third, not dead centre. Centring measured out with the composer's
       top edge at 57% of the viewport — on a tall screen the page reads as a
       title floating in blank space with the input below the fold line of the
       eye. The 16vh that puts the block where it belongs is the CHATBOT's own
       (chatbot.style.ts, scoped to :has(.empty-state)); this rule's whole job
       is to stop centring on top of it. No padding here — there was, briefly,
       and the two 16vh stacked into a block at 44%. Phones keep the centre:
       16vh of a short viewport is nothing, and a centred block is the only
       layout that survives the keyboard. */
    /* Centred until there is something below worth the room: pinning a
       capability opens the Start-from cards, and a centred block would push
       them off the bottom — so cards on screen is the one state that
       top-aligns the home. The chatbot no longer places this block at all
       (chatbot.style.ts handed it over); these two rules are the whole
       policy. */
    /* A little above centre, not on it: optical centre sits higher than
       geometric centre, and the block is top-heavy (a 54px wordmark over a
       composer), so dead centre reads as slightly low. The padding does the
       biasing rather than a transform, so nothing overlaps when the window is
       short enough that the block fills it. */
    main.empty { display: flex; flex-direction: column; justify-content: center;
                 padding-bottom: 14vh; }
    /* With thumbnails the card row is ~200px tall, so the block only needs
       to move up enough to clear it — 6vh put the wordmark against the header
       with a screen of blank beneath. Centred-but-biased: still centre, just
       with the cards' height taken out of the calculation. */
    main.empty.has-starts { justify-content: center; padding-top: 0;
                            padding-bottom: 0; }
    main.empty nr-chatbot { flex: 0 0 auto; height: auto; }
    /* A ::part(boxed-area) rule sat here zeroing the chatbot's padding. It
       never applied — nr-chatbot exposes no parts — which is the only reason
       the home block ever sat at 16vh at all. Removed rather than kept as a
       plausible-looking rule that a reader would edit and see nothing move. */

    /* The row's height is held whether or not the chips have arrived.
       featuredSkills is a fetch, so the row renders empty on first paint and
       fills a moment later — and because the whole empty block is centred, a
       row that grows from 0 to 49px pushed the wordmark and composer up by
       half that as you watched. Reserving the space costs one rule and makes
       the load invisible. The number is the pill's own height and has to stay
       that: it was 49 while 35 was written here, and because a flex row
       stretches its children the pills silently took the wrong figure as
       their size rather than exposing it as a gap. Measured, not assumed. */
    /* Starting points: somebody else's conversations, offered. Cards rather
       than rows because each is a thing you choose, and the only action on one
       is Remix — see startsPage for why there is no way to open the source. */
    .starts-page { padding: 28px 24px; max-width: 900px; margin: 0 auto;
                   overflow-y: auto; }
    .starts-page h2 { font-size: 20px; font-weight: 650; margin: 0 0 6px; }
    .starts-intro { color: var(--muted); margin: 0 0 20px; max-width: 60ch; }
    .offer-grid { display: grid; gap: 12px;
                  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
    .offer { display: flex; flex-direction: column; gap: 6px; padding: 14px;
             border: 1px solid var(--border); border-radius: 12px;
             background: var(--bg-card); }
    .offer-name { font-size: 14px; font-weight: 600; line-height: 1.35;
                  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3;
                  -webkit-box-orient: vertical; }
    .offer-meta { font-size: 12px; color: var(--muted); }
    .offer-remix { margin-top: 6px; align-self: flex-start; font: inherit;
                   font-size: 13px; padding: 6px 16px; cursor: pointer;
                   border: 1px solid var(--border); border-radius: 999px;
                   background: var(--bg-card); color: var(--fg); }
    .offer-acts { display: flex; gap: 8px; margin-top: 6px; }
    .offer-open { font: inherit; font-size: 13px; padding: 6px 16px; cursor: pointer;
                  border: 0; border-radius: 999px; background: var(--accent);
                  color: var(--accent-fg); }
    .offer-open:hover { background: var(--accent-hover); }
    /* The banner that stands where the composer would be. */
    .borrowed { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
                max-width: 768px; margin: 0 auto 14px; padding: 12px 16px;
                border: 1px solid var(--border); border-radius: 12px;
                background: var(--bg-rail); color: var(--muted); font-size: 13.5px; }
    .offer-remix:hover { background: var(--bg-user); border-color: var(--muted); }
    .caps { min-height: 32px; box-sizing: content-box; }
    /* align-items, and it is not cosmetic. A flex row stretches its children
       to its own height by default, and this row reserves height it may not
       have filled yet — so every pill grew to the reserved 49px and looked
       heavily padded when its own box is 32. Changing the padding does
       nothing while this holds; the pill is not the size of its content.
       Centring frees the pill to be its own height, and the reserve becomes
       what it was meant to be: space held, not size imposed. */
    .caps { display: flex; align-items: center; gap: 4px; padding: 14px 18px 0;
            max-width: 768px; margin: 0 auto; overflow-x: auto;
            scrollbar-width: none; }
    .caps::-webkit-scrollbar { display: none; }
    /* Outlined pills, the way Kimi draws this row today. These shipped
       borderless on the argument that they are verbs, not buttons — but the
       row sits alone on a blank page under the composer, and without an
       outline the verbs read as a stray line of text. Kimi came to the same
       conclusion: their capability row is bordered pills now. */
    .cap { display: inline-flex; align-items: center; gap: 6px; flex: none;
           padding: 5px 11px; border: 1px solid var(--border); border-radius: 999px;
           cursor: pointer; background: var(--bg-card); font: inherit;
           font-size: 13.5px; color: var(--fg); white-space: nowrap; }
    .cap:hover { background: var(--bg-user); border-color: var(--muted); }
    .cap.on { background: var(--bg-user); color: var(--fg); font-weight: 600; }
    /* Starting points for the pinned capability. Cards, because each is a
       thing you would recognise by name — Kimi's "Featured cases". */
    .starts-head { max-width: 768px; margin: 18px auto 8px; padding: 0 18px;
                   font-size: 13px; color: var(--muted); }
    /* Contained scrolling: the row is wider than a phone by design, and
       without a max-width tied to the viewport it made the PAGE scroll
       sideways — the whole console slid, header and all. overscroll-behavior
       keeps a swipe that reaches the end of the cards from becoming a page
       gesture. */
    .starts { overscroll-behavior-x: contain; max-width: min(768px, 100%); }
    .starts { display: flex; gap: 10px; padding: 0 18px; max-width: 768px;
              margin: 0 auto; overflow-x: auto; scrollbar-width: none; }
    .starts::-webkit-scrollbar { display: none; }
    /* The first page of the template's own document, cropped to a card-sized
       peek. The proof beats the label: "Status report" is a claim, the actual
       headings and the table are what a person recognises. A card whose PDF
       has not arrived (or cannot — no converter on this deployment) simply
       keeps the quiet placeholder ground; the words were always enough. */
    .start-thumb { display: block; height: 118px; margin-bottom: 8px;
                   border: 1px solid var(--border); border-radius: 8px;
                   overflow: hidden; background: var(--bg-card); }
    .start-thumb canvas { display: block; width: 100%; height: auto; }
    /* The iframe is laid out at 900px and scaled to the card, so the page
       inside is the desktop one rather than a 208px reflow of it. The wrapper
       clips; pointer-events go nowhere, because a thumbnail is a picture. */
    .site-thumb { width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
    .site-thumb iframe {
      width: 900px; height: 510px; border: 0;
      transform: scale(0.231); transform-origin: top left;
    }
    .start { flex: none; width: 210px; text-align: left; cursor: pointer;
             display: flex; flex-direction: column; gap: 3px; padding: 12px 14px;
             border: 1px solid var(--border); border-radius: 14px;
             background: var(--bg-card); font: inherit; }
    .start:hover { border-color: var(--accent); }
    .start-name { font-weight: 600; font-size: 13.5px; color: var(--fg); }
    .start-why { font-size: 12px; color: var(--muted); line-height: 1.35;
                 display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                 overflow: hidden; }

    .cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 18px 12px;
             border-top: 1px solid var(--border); background: var(--bg); }
    .card { display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
            border: 1px solid var(--border); border-radius: 12px; padding: 6px 12px;
            background: var(--bg-card); color: var(--fg); cursor: pointer;
            font: inherit; text-align: left; max-width: 260px;
            transition: border-color .15s cubic-bezier(.23,1,.32,1),
                        box-shadow .15s cubic-bezier(.23,1,.32,1); }
    .card:hover { border-color: var(--accent); box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .card .card-name { font-size: 13px; font-weight: 600; max-width: 100%;
                       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card .card-meta { font: 11.5px var(--mono); color: var(--muted); }
    nr-chatbot {
      height: 100%;
      /* The Claude reading: the user's turn is a warm block, the model's is
         plain text on the page. */
      --nuraly-color-user-bubble-bg: var(--bg-user);
      --nuraly-color-user-bubble-fg: var(--fg);
      --nuraly-color-bot-bubble-bg: transparent;
      --nuraly-color-bot-bubble-fg: var(--fg);
      --nuraly-color-divider: var(--border);
      --nuraly-color-error-bg: #FDF0EC;
      --nuraly-color-error-border: var(--accent);
      --nuraly-color-error-fg: #8A2E12;
    }
  `;

  // AgentFull, not AgentRow: GET /agents has always answered the full view —
  // the prompt and the config resolved — and this only ever declared the
  // narrower half of what it was handed. The menu's last line needs
  // `config.modelId` to name the agent's own model.
  @state() private agents: AgentFull[] = [];
  @state() private agentId = "";
  @state() private threads: ThreadListing[] = [];
  @state() private threadId = "";
  // The transcript lives in the session, which is what nr-chatbot reads. Only
  // the typing flag is mirrored here, because the header and the composer's
  // placeholder are drawn on this side.
  @state() private busy = false;

  /* The composer's model menu, and what it is set to.
   *
   * The list is the operator's, in their rank order, straight from the engine
   * — the same posture as the capability row above. Empty is a real and
   * ordinary answer: a deployment with one model has no decision to offer and
   * gets no picker rather than a menu of one.
   *
   * `choiceId` is "" for the agent's own model, which is what every
   * conversation written before this feature means and what needs no backfill.
   * It is per-composer, not per-thread: what it shows is what the NEXT send
   * will carry. Opening an existing conversation sets it to what that
   * conversation last ran on; starting a new one deliberately keeps it, since
   * the person who just chose Thinking meant the next thing they ask. */
  @state() private choices: ModelChoice[] = [];
  @state() private choiceId = "";
  /* Read for exactly one line of the menu — "Agent default (…)" — because an
   * agent resolves to a config and a config to a model, and only the model
   * row carries a label a person would recognise. Never fetched at all when
   * there is no menu to draw. */
  @state() private models: ModelRow[] = [];

  // One session for the pane. It is the controller nr-chatbot was missing:
  // without one, Enter did nothing at all.
  private session = new ChatSession({
    agentId: () => this.agentId,
    // Read at the moment a question is accepted, not when it is sent: the
    // choice travels with the message, and a queued question keeps whatever
    // the picker was showing when it was typed.
    modelChoiceId: () => this.choiceId,
    // The one place a conversation's id arrives without anyone having opened
    // it: the first message of a new thread creates it server-side and this is
    // how the console learns which one it got. It has to route too, or the
    // conversation you just started is the one you cannot link to or reload
    // back into.
    onThreadOpened: (id) => { this.threadId = id; this.route(id); },
    onTurnDone: () => { void this.refreshThreads(); void this.refreshRefs(); },
  });
  // What the conversation saved, from two sources that must agree before a
  // card is drawn: the refs each message carries (slot@version, from the say
  // reply or the transcript), and the by-turn join, which only answers for
  // versions a round actually stored. A ref the join does not answer for is a
  // claim, not a save, and is not rendered. Neither source is the reply text:
  // mapping cards by text order was breakable by one forged line.
  @state() private turnRefs: TurnArtifactRef[] = [];
  // Which rail is open, if either. One at a time and not two booleans: both
  // are 320px against a chat pane that is already the narrowest thing here,
  // and the files a conversation works from and the results it produced are
  // read one after the other, not side by side.
  /* One rail now. It carries artifacts and the conversation's workspace
     files in a single navigable tree; "artifacts" stays the internal name
     (and the button's title) because four e2e specs and the artifact deep
     links address it by that word. */
  @state() private rail: "" | "artifacts" = "";
  @state() private settings = false;
  @state() private view: "chat" | "knowledge" | "canvas" | "starts" = "chat";
  /* What other people have offered, loaded when the page opens. */
  @state() private offers: ThreadListing[] = [];
  /* False while reading a conversation somebody else offered. The engine
     decides this — the console never sees an owner tag — and it is what
     swaps the composer for a Remix banner. */
  @state() private mine = true;
  // Who the front door says is calling. Null where nothing authenticates, which
  // is the community edition and is not the same as holding no roles.
  @state() private me: Me | null = null;
  // Raised by `call` on the first 401 of a page. The console keeps whatever it
  // had drawn behind the overlay: signing back in should return you to the
  // conversation you were reading, not to an empty shell.
  @state() private signedOut = false;
  /* Reflected, because the drawer and its scrim are styled from the host —
     a boolean in a template cannot reach the sidebar element's own transform. */
  @property({ type: Boolean, reflect: true }) nav = false;
  /* Set by pages/c/[id].ts. Empty on `/`, where index.ts renders the same
     element with nothing to say about which conversation is open. */
  @property({ attribute: false }) conversation = "";
  /* What the route page's loader already read, on the server, as this caller.
     Applied once through the same join `session.open` uses, so the first paint
     and the reload cannot disagree. Empty on `/` and on any load the loader
     could not answer. */
  @property({ attribute: false }) seedTurns: unknown = [];
  @property({ attribute: false }) seedPast: unknown = { steps: [], thoughts: [] };

  /* The capability row. Public featured skills, in rank order, straight from
     the engine — promoting a skill to the row is an operator edit, never a
     console deploy. */
  @state() private capabilities: SkillRow[] = [];
  /* The skill this round runs under, pinned by a chip and shown in the
     composer. Empty is the normal case: the model still chooses from its
     briefing, which is how a document gets written when nobody pressed
     anything. */
  @state() private pinned = "";
  /* Starting points for the pinned capability, shown as cards under the
     composer once one is picked. */
  @state() private starts: TemplateRow[] = [];

  /* Seeding happens here and not in connectedCallback, and that is the whole
     reason the conversation can be server-rendered at all.
     @lit-labs/ssr's renderer skips connectedCallback by default — it is opt-in
     behind `litSsrCallConnectedCallback`, because a connect hook on the server
     starts pollers and subscriptions nobody will ever stop — but it DOES call
     willUpdate before rendering (lit-element-renderer.js). So anything the
     first paint needs has to be derived from properties here, not fetched in a
     lifecycle hook that only the browser runs.
     Once, guarded: willUpdate runs on every property change, and re-applying a
     transcript would throw away whatever the conversation has become since. */
  private seeded = false;
  willUpdate(): void {
    if (this.seeded) { return; }
    const seed = seedOf(this.seedTurns);
    if (seed.turns.length === 0) { return; }
    this.seeded = true;
    const id = this.conversation !== "" ? this.conversation : currentId();
    if (id === "") { return; }
    this.threadId = id;
    // The conversation's own choice, from the first frame. The picker is drawn
    // on the server too, and a composer that paints "Default" and then flips
    // to "Thinking" a round trip later is worse than one that waits.
    this.choiceId = seed.modelChoiceId;
    this.session.apply(seed.turns as never, this.seedPast as never);
  }

  async connectedCallback() {
    super.connectedCallback();
    // The tab's name is part of the brand too — nothing else in the app sets
    // a <title>, so without this the tab wears whatever the framework's shell
    // defaulted to. Safe here because SSR skips connectedCallback (see the
    // seeding note above); on the server there is no document to touch.
    document.title = BRAND;
    this.session.on("state:changed", () => { this.busy = this.session.isTyping(); });
    // Asked before the lists, and never awaited alongside them: a 401 from the
    // list calls navigates to the login, and the answer to this one decides
    // what the rail may even offer.
    window.addEventListener(SIGNED_OUT, () => { this.signedOut = true; });
    // Back and Forward move between conversations rather than out of the app.
    window.addEventListener("popstate", () => {
      const id = currentId();
      if (id === "") { this.fresh(); } else if (id !== this.threadId) { void this.open(id); }
    });
    this.me = await whoami().catch(() => null);
    this.capabilities = await featuredSkills().catch(() => []);
    // The run says what it is doing while it is doing it. Held here so the
    // card re-renders; the session owns the list and never rebuilds it.
    [this.agents, this.threads] = await Promise.all([listAgents(), listThreads()])
      .catch(() => [[], []] as [AgentFull[], ThreadListing[]]);
    this.agents = this.agents.filter((a) => a.enabled);
    // The flagged default, not the first name in the list — sorted by name,
    // "the first" was whichever agent happened to sort earliest, which for a
    // while was the e2e model double.
    const preferred = this.agents.find((a) => a.isDefault) ?? this.agents[0];
    if (preferred) this.agentId = preferred.id;
    // Recents, pushed. The list arrives whole and replaces what is held —
    // there is no refetch behind it, which is the point: a conversation that
    // acquires its title in another tab acquires it in this sidebar without
    // this tab asking anything (backlog #28).
    this.unlisten = live.on("threads", ({ threads }) => { this.threads = threads; });
    // A reload, a bookmark, a link pasted to someone with the same access:
    // all three arrive as /c/<id> and must land in that conversation rather
    // than on an empty composer. `conversation` is the property the route page
    // hands in; the URL is read as well, because `/` is served by index.ts and
    // has no property to hand.
    const wanted = this.conversation !== "" ? this.conversation : currentId();
    // The seed already drew this conversation (willUpdate, which the server
    // runs too). `open` still runs: it starts the live feed and re-reads, so a
    // conversation that moved on since the server read it catches up.
    if (wanted !== "") { void this.open(wanted); }
    this.threadsTicker = setInterval(() => { this.tickThreads(); }, 10000);
    // Last, and awaited last on purpose: the sidebar, the header and the
    // conversation are all already on screen by the time this asks, and
    // nothing above it waits on a menu.
    await this.loadChoices();
  }

  /* The composer's menu, and the one label the menu's last line needs.
   *
   * Refused rather than empty is the same answer here: `catch(() => [])` gives
   * a console with no picker, which is what a deployment that has not curated
   * a menu should look like anyway.
   *
   * The models are only read when there is a menu. A single-model install asks
   * `/models/choices` once, gets nothing, and never asks anything else — which
   * is the community edition's whole experience of this feature. */
  private async loadChoices(): Promise<void> {
    this.choices = await modelChoices().catch(() => []);
    if (this.choices.length === 0) { return; }
    this.models = await listModels().catch(() => []);
  }

  /* The agent's own model, named the way a person would recognise it.
   *
   * Three rows deep — agent to config to model — and it degrades at each step
   * to "", which the picker renders as a plain "Agent default". `models.label`
   * rather than the config's, because GET /agents resolves the config without
   * its label column and the model is the thing a menu line is naming anyway. */
  private defaultModelLabel(): string {
    const agent = this.agents.find((a) => a.id === this.agentId);
    const modelId = agent?.config?.modelId ?? "";
    if (modelId === "") { return ""; }
    return this.models.find((m) => m.id === modelId)?.label ?? "";
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.threadsTicker !== null) { clearInterval(this.threadsTicker); this.threadsTicker = null; }
    if (this.unlisten !== null) { this.unlisten(); this.unlisten = null; }
  }

  // Take the click ring off the composer's own buttons.
  //
  // nr-chatbot draws a 4px violet square around its `+` and send buttons on
  // `:focus-within`, which fires on a MOUSE click and then stays — so clicking
  // the plus leaves a heavy box around it until something else takes focus.
  // It is the loudest thing on the page and it means nothing to the person who
  // just clicked, because they know where they clicked.
  //
  // `:focus-within` is what makes it wrong, not the outline: it cannot tell a
  // pointer from a keyboard. So the rule is replaced rather than deleted —
  // `:focus-visible` keeps a ring for anyone tabbing through, which is who the
  // indicator was for. Removing it outright would make the composer
  // unnavigable without a mouse.
  //
  // Handed to the shadow root because that is where the rule lives; a
  // stylesheet here cannot reach inside a component. Same mechanism, and the
  // same `dressed` latch against re-adding it on every render, as
  // settings.ts's markdown-token sheet — see the comment there.
  protected updated() {
    softenFocusRings(this.renderRoot);
    dressChat(this.renderRoot);
    void this.dock();
  }

  /* The model picker, held by reference rather than looked up.
   *
   * `renderRoot.querySelector` finds it exactly once — the first time, before
   * it has been moved into the composer. After that it is a child of
   * nr-chatbot's shadow root and this element's own root no longer answers for
   * it, so a lookup on every pass would find nothing and the picker would
   * never be re-docked after the chat pane is rebuilt (switching to the
   * knowledge or graph view destroys the nr-chatbot that was holding it). */
  private picker: HTMLElement | null = null;

  /* Move the picker into the composer's action row, ahead of the send button.
   *
   * The long version of why it goes there at all, and why the component cannot
   * simply be given content there, is at the top of model-picker.ts. The
   * mechanics that matter here:
   *
   * - It is safe to move because `<model-picker>` is a STATIC node in this
   *   element's template — never inside a conditional. lit creates such a node
   *   once from the template clone and thereafter only updates its bindings,
   *   which keep working wherever the node lives; a node inside a ternary
   *   would instead be cleared between part markers that are no longer around
   *   it, and would leak a picker per toggle.
   * - Inserted before the row's first child, which puts it ahead of every
   *   marker lit wrote inside that div. lit only ever clears BETWEEN its own
   *   markers, so a node in front of all of them survives the component's
   *   re-renders — including the one that adds the send button the moment
   *   there is text to send.
   * - `await chat.updateComplete` because the row is written by the
   *   component's render, not by ours: on the first pass after hydration this
   *   element has updated and nr-chatbot has not, so a synchronous query finds
   *   no row at all.
   * - Nothing is docked while there is no menu, and that is not only tidiness:
   *   the action row has a 0.5rem gap, so an empty zero-width child would
   *   still push the send button 8px left on every deployment that offers no
   *   choices. */
  private async dock(): Promise<void> {
    if (this.choices.length === 0) { return; }
    if (this.picker === null) {
      this.picker = this.renderRoot.querySelector("model-picker");
    }
    const picker = this.picker;
    if (picker === null) { return; }
    const chat = this.renderRoot.querySelector("nr-chatbot") as
      (Element & { updateComplete?: Promise<unknown> }) | null;
    if (chat === null) { return; }
    await chat.updateComplete;
    const right = chat.shadowRoot?.querySelector(".action-buttons-right") ?? null;
    if (right === null || picker.parentNode === right) { return; }
    right.insertBefore(picker, right.firstChild);
    // A bare attribute rather than a reactive property, because nothing must
    // ever take it off again: it is what stops the picker painting where lit
    // put it during the server render, which is under the conversation rather
    // than in the composer.
    picker.setAttribute("docked", "");
  }

  private unlisten: (() => void) | null = null;

  /* The open conversation, in the address bar.
   *
   * A query rather than a path, and not for taste: the gateway routes `= /`
   * as an exact match and everything else on this host falls to the
   * admin-gated catch-all, so `/c/<id>` would answer 401 to its own owner. A
   * query keeps the path `/` and needs no gateway change — see
   * locations/agents.conf, and revisit if the console ever gets a prefix of
   * its own there.
   *
   * pushState, so Back walks the conversations you opened rather than leaving
   * the app on the first press. */
  private route(id: string): void {
    if (currentId() === id) { return; }
    history.pushState({ c: id }, "", id === "" ? "/" : `/c/${encodeURIComponent(id)}`);
  }

  private async open(id: string) {
    this.route(id);
    this.threadId = id;
    this.railClosed = false;
    const found = this.threads.find((t) => t.id === id);
    if (found) this.agentId = found.agentId;
    // A conversation in your own rail is yours; one opened from Starting points
    // is not in that list, and the engine says so on the transcript. Assume
    // yours when it IS in the rail so the composer never flickers away on a
    // conversation you own.
    this.mine = found !== undefined;
    await this.session.open(id);
    if (found === undefined) {
      this.mine = await transcript(id).then((t) => t.mine !== false).catch(() => true);
    }
    // The conversation's memory of the last override becomes what the composer
    // shows, so reopening one keeps answering with what you last chose there.
    // Read from the session rather than pushed by it: the follower re-opens a
    // conversation whenever a round it did not start finishes, and a push from
    // in there would reset a picker somebody had just changed and not yet sent.
    this.choiceId = this.session.rememberedChoice();
    await this.refreshRefs();
  }

  private fresh() {
    this.route("");
    this.threadId = ""; this.turnRefs = []; this.railClosed = false; this.session.fresh();
  }

  // Whether the person shut the rail themselves. The auto-open below must
  // lose that argument for the rest of the conversation — a panel that
  // reopens after being closed is not helping, it is nagging.
  private railClosed = false;

  // Nothing opens the rail but the person. It used to open itself for any
  // conversation with artifacts, which on a desktop read as helpful and on a
  // phone WAS the screen: the panel covers the conversation below 1024px, so
  // arriving at a conversation meant arriving at its file list instead, with
  // the conversation invisible behind it. The artifact cards under the
  // composer already say there is something to open.

  // Clicking the rail that is already open closes it, which is what a pressed
  // toggle should do.
  private show(which: "artifacts") {
    if (this.rail === which) { this.rail = ""; this.railClosed = true; return; }
    this.rail = which;
  }

  private async refreshThreads() {
    this.threads = await listThreads().catch(() => this.threads);
  }

  // Recents stays current on its own: an eval script, another tab, a
  // colleague — conversations appear without anyone reloading the page.
  //
  // The feed does that now, and this timer is what happens when the feed does
  // not: a socket that never opened, or one that stopped. It is never
  // cancelled, only skipped, so the moment the
  // pushes stop arriving it takes over again with no state to restore. The
  // refetch on a finished turn is not a poll and stays unconditional — the
  // person who just sent the message should not wait a tick to see their own
  // conversation named.
  private threadsTicker: ReturnType<typeof setInterval> | null = null;

  private tickThreads() {
    if (live.fresh()) return;
    void this.refreshThreads();
  }

  private async refreshRefs() {
    this.turnRefs = this.threadId === "" ? []
      : await artifactsByTurn(this.threadId).catch(() => this.turnRefs);
  }

  // The cards to draw, in the order the conversation earned them. Each message
  // ref resolves against the join by slot@version; one key, one card, however
  // many captions mention it.
  // The by-turn join is the whole source of cards. It is server-derived from
  // artifact_versions.turn_seq, so nothing a user pastes and nothing a model
  // claims can mint an entry — and it sees BOTH doors, which the message refs
  // do not: a save made through write_artifact leaves no marker in the prose,
  // and requiring one meant the primary door's files never carded. That is
  // exactly how the live-Mistral run failed: the model did the right thing,
  // used the tool, and the console showed nothing.
  //
  // One card per artifact, at its newest referenced version.
  private cards(): TurnArtifactRef[] {
    const newest = new Map<number, TurnArtifactRef>();
    for (const row of this.turnRefs) {
      const seen = newest.get(row.slot);
      if (seen === undefined || row.version > seen.version) newest.set(row.slot, row);
    }
    return [...newest.values()].sort((a, b) => a.slot - b.slot);
  }

  // A card opens the preview origin in a tab of its own — it does not open the
  // artifact rail, which moves only when its header toggle is pressed. The
  // previewToken is deliberately absent from say and transcript payloads, so
  // the card buys it at click time from the listing, the one route that says
  // it. noreferrer because that token is the whole authorisation and a page
  // the artifact links to must not be handed it; noopener follows and also
  // keeps the new document from reaching back through window.opener.
  private async openCard(card: TurnArtifactRef) {
    const listed = await listArtifacts(this.threadId).catch(() => [] as ArtifactListing[]);
    const row = listed.find((a) => a.slot === card.slot);
    if (row === undefined) return;
    window.open(previewUrl(row.previewToken, card.version), "_blank", "noopener,noreferrer");
  }

  private async reloadAgents() {
    const listed = await listAgents().catch(() => this.agents);
    this.agents = listed.filter((a) => a.enabled);
    // An agent disabled while it was selected must not stay selected. The
    // replacement is the flagged default, same as first load.
    if (!this.agents.some((a) => a.id === this.agentId)) {
      const preferred = this.agents.find((a) => a.isDefault) ?? this.agents[0];
      this.agentId = preferred ? preferred.id : "";
    }
  }

  private threadTitle(): string {
    const t = this.threads.find((x) => x.id === this.threadId);
    return t && t.title !== "" ? t.title : "New conversation";
  }

  private agentName(): string {
    return this.agents.find((a) => a.id === this.agentId)?.agentName ?? "agent";
  }

  // A message may not be wider than the conversation it is in.
  //
  // nr-chatbot caps a bubble at 75% of the column, but the element inside it
  // that holds the text is a flex child with no cap of its own — and a flex
  // child defaults to min-width:auto, "never narrower than my content". A tool
  // call's arguments are one long unbreakable line of JSON, so the content ran
  // to 1019px inside a 451px bubble and off the right of the window, taking
  // the answer's type names with it. Nothing in this file could reach it: the
  // element lives in that component's shadow root, so the rule is handed to
  // the root itself — settings.ts dresses nr-code-editor the same way.
  // The stylesheet this used to adopt into nr-chatbot's shadow root moved
  // into the component's own static styles (nuraly-ui chatbot.style.ts, "the
  // served look"). Adopted sheets exist only after hydration, so every rule
  // in it was false on the server-rendered first paint — the composer painted
  // square and the empty state jumped into place. Static styles are
  // serialized into the declarative shadow root, so the same rules are now
  // true from the first frame, and there is nothing left to inject here.

  // A chip inside a tool card names a version a script landed; clicking it
  // opens the panel on that file's diff. The card is markup inside
  // nr-chatbot's shadow root, so the console cannot attach handlers to it —
  // instead the click bubbles (composed) and is read off its data attributes.
  /* What the composer's + offers. Files first because it is the common act;
     then the capabilities, which is where a person who knows what they want
     says so. Kimi puts Skills behind the same button, and it is the right
     place: the alternative is a second affordance beside the composer for
     the same job. */
  private attachMenu() {
    let items = [{ id: "upload-file", label: "Add files", icon: "paperclip" }];
    for (const c of this.capabilities) {
      items = [...items, { id: "skill:" + c.skillName, label: c.skillName, icon: capIcon(c.skillName) }];
    }
    return items;
  }

  /* The capability row: what this deployment can do, in the operator's order.
     Borderless like Kimi's — these are verbs, not buttons, and a row of
     outlined pills reads as a toolbar. Scrolls sideways rather than wrapping,
     because a second line of capabilities pushes the composer off a phone. */
  private capabilityRow() {
    // The empty row still renders — see the .caps note in the stylesheet. A
    // deployment with no featured skills keeps an empty 49px band, which is
    // the price of nothing moving on every other deployment.
    if (this.capabilities.length === 0) { return html`<div class="caps"></div>`; }
    return html`
      <div class="caps">
        ${this.capabilities.map((c) => html`
          <button class=${this.pinned === c.skillName ? "cap on" : "cap"}
            title=${c.description}
            @click=${() => { void this.pin(c.skillName); }}>
            <nr-icon name=${capIcon(c.skillName)} size="small"></nr-icon>
            <span>${capLabel(c.skillName)}</span>
          </button>`)}
      </div>
      ${this.starts.length === 0 ? "" : html`
        <div class="starts-head">Start from</div>
        <div class="starts">
          ${this.starts.map((t) => html`
            <button class="start" title=${t.description}
              @click=${() => { void this.startWith(t); }}>
              <span class="start-thumb" data-tpl=${t.id}></span>
              <span class="start-name">${t.label}</span>
              <span class="start-why">${t.description}</span>
            </button>`)}
        </div>`}`;
  }

  /* Conversations other people offered, and one button that makes a copy.

     A gallery and not a list of links: the point of offering is that somebody
     starts from your files, so the action on each card is Remix — which opens
     a NEW conversation of their own — rather than a way to read yours. There
     is deliberately no way to open the source itself: it is somebody else's
     conversation, and the flag offers its files as a starting point, not its
     transcript as reading. */
  private startsPage() {
    return html`
      <div class="starts-page">
        <h2>Starting points</h2>
        <p class="starts-intro">Conversations people have offered to start from.
          Remixing one opens a conversation of your own with its files already in it.</p>
        ${this.offers.length === 0
          ? html`<p class="empty">Nothing is on offer yet. Open a conversation you
              are pleased with and press the share button in its header.</p>`
          : html`<div class="offer-grid">
              ${this.offers.map((o) => html`
                <div class="offer">
                  <!-- A card with a blank name is a card nobody can choose.
                       An offered conversation usually has a title by now (the
                       engine names one from its first message), but one whose
                       naming call never landed still has to read as something. -->
                  <div class="offer-name">${o.title === "" ? "Untitled conversation" : o.title}</div>
                  <div class="offer-meta">${o.agentId}</div>
                  <div class="offer-acts">
                    <!-- Open reads it; Remix copies it. Both, because choosing
                         a starting point without looking at it first is
                         choosing by its title alone. -->
                    <button class="offer-open" @click=${() => { void this.openOffered(o.id); }}>
                      Open
                    </button>
                    <button class="offer-remix" @click=${() => { void this.remix(o.id); }}>
                      Remix
                    </button>
                  </div>
                </div>`)}
            </div>`}
      </div>`;
  }

  private async openStarts(): Promise<void> {
    this.view = "starts";
    this.nav = false;
    this.offers = await replayableThreads().catch(() => []);
  }

  /* Read somebody else's starting point. The same conversation route as any
     other — the engine allows the read because the conversation is offered —
     so the transcript, its cards and its files all draw exactly as they would
     for its owner. What differs is that `mine` comes back false, and the
     composer is replaced by the banner that offers a copy. */
  private async openOffered(id: string): Promise<void> {
    this.view = "chat";
    await this.open(id);
  }

  /* A remix lands you IN the copy. Anything else — a toast, a row appearing in
     the rail — would leave the person on a page about other people's work
     after asking for something of their own. */
  private async remix(id: string): Promise<void> {
    try {
      const made = await remixThread(id);
      this.threads = await listThreads();
      this.view = "chat";
      await this.open(made.id);
    } catch {
      // The engine refuses a source that stopped being offered between the
      // page loading and the click, which is a race worth losing quietly:
      // the list is stale, so refresh it and let them choose again.
      this.offers = await replayableThreads().catch(() => []);
    }
  }

  /* Whether the open conversation is on offer. Read from the rail's own
     listing rather than kept as a second copy: the sidebar already fetches
     every thread with its flag, so a lookup is free and cannot drift from
     what the rail is drawing. */
  private get offered(): boolean {
    const row = this.threads.find((t) => t.id === this.threadId);
    return row !== undefined && row.replayable;
  }

  /* Offer this conversation, or withdraw it. The listing is refreshed rather
     than patched in place: the engine decides what the flag is now, and a
     local guess that disagreed with it would be a second source of truth for
     one boolean. */
  private async toggleOffer(): Promise<void> {
    if (this.threadId === "") { return; }
    const want = !this.offered;
    try {
      await offerThread(this.threadId, want);
      this.threads = await listThreads();
    } catch {
      // A refusal leaves the rail as it was, which is the honest picture: the
      // flag did not change, so neither should the control.
    }
  }

  /* Pinning a capability shows its starting points; pinning it twice lets go.
     Nothing is sent yet — the pin is a statement of intent, and the round
     still carries whatever the person types. */
  private async pin(skillName: string): Promise<void> {
    if (this.pinned === skillName) { this.pinned = ""; this.starts = []; return; }
    this.pinned = skillName;
    this.starts = await templatesOfKind(capKind(skillName)).catch(() => []);
    void this.paintThumbs();
  }

  /* Each card's first page, drawn after the cards exist.

     Cached per template for the tab's lifetime: the engine's side is cached
     too, but a re-pin should not even ask. Fetch and render race the person
     browsing — every await re-checks that the card is still on screen and
     still empty, because pinning Sheets while Docs' thumbnails are in flight
     would otherwise paint spreadsheet cards with documents. */
  private thumbs = new Map<string, HTMLElement>();
  /* A site template's first page, drawn as itself.

     `srcdoc` with the stylesheet inlined, because the iframe has no origin to
     resolve `href="style.css"` against — the files exist as template rows, not
     as anything the browser can fetch. Sandboxed with no allow-scripts: a
     template is markup the operator wrote, but a thumbnail is not a place to
     start running things, and the page needs no script to look like itself.
     Scaled by transform rather than by rendering small: the page is laid out
     at 900px and shown at card width, so its type and spacing are the ones a
     reader will actually get instead of a phone-width reflow. */
  private async siteThumb(id: string): Promise<HTMLElement | null> {
    const files = await listTemplateFiles(id).catch(() => []);
    const html = files.find((f) => f.path.endsWith(".html"));
    if (html === undefined) { return null; }
    const css = files.find((f) => f.path.endsWith(".css"));
    const doc = css === undefined
      ? html.body
      : html.body.replace('<link rel="stylesheet" href="style.css">',
                          `<style>${css.body}</style>`);
    const hold = document.createElement("div");
    hold.className = "site-thumb";
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.srcdoc = doc;
    hold.append(frame);
    return hold;
  }

  private async paintThumbs(): Promise<void> {
    await this.updateComplete;
    for (const t of this.starts) {
      const port = () => this.renderRoot.querySelector(`.start-thumb[data-tpl="${t.id}"]`);
      const held = this.thumbs.get(t.id);
      if (held !== undefined) { port()?.replaceChildren(held); continue; }
      try {
        // A site template has no document to convert — the office path runs
        // LibreOffice, which does not take HTML — so its own first page is
        // rendered instead, in a sandboxed iframe scaled down to the card.
        // That is a real preview rather than an approximation of one: it is
        // the page, laid out by the same engine that will lay it out later.
        if (t.kind === "site") {
          const frame = await this.siteThumb(t.id);
          if (frame === null) { continue; }
          this.thumbs.set(t.id, frame);
          port()?.replaceChildren(frame);
          continue;
        }
        const { pdf } = await templatePdf(t.id);
        const { renderPdfThumb } = await import("./office-view.js");
        const canvas = await renderPdfThumb(pdf, 208);
        if (canvas === null) { continue; }
        this.thumbs.set(t.id, canvas);
        port()?.replaceChildren(canvas);
      } catch {
        // No thumbnail is a fine card; see the stylesheet note.
      }
    }
  }

  /* A template starts the conversation: its files land as version 1, and the
     first message names the skill so the round that follows works on them. */
  private async startWith(t: TemplateRow): Promise<void> {
    const id = await this.session.ensureThread();
    if (id === "") { return; }
    // The endpoint reports what it actually laid down; the message names
    // those paths rather than a file the template is assumed to ship. It
    // used to say "/brief.md", and when the briefs were retired the agent
    // answered, correctly, that it could not find one.
    const laid = await startFromTemplate(id, t.id).catch(() => null);
    this.pinned = "";
    this.starts = [];
    await this.open(id);
    const files = laid?.wrote ?? [];
    if (files.length === 0) {
      await this.session.sendMessage(
        `Start a ${t.label} for me — use your ${t.skillName} skill.`);
      return;
    }
    await this.session.sendMessage(
      `I started from the ${t.label} template: ${files.join(", ")} ${files.length === 1 ? "is" : "are"} `
      + `already in this conversation's files. Use your ${t.skillName} skill to FILL that document in place — `
      + `materialise it, replace its placeholders, save it back to the same path. `
      + `Ask me for anything you need before you start.`);
  }

  private async chipClick(e: Event) {
    const path = e.composedPath() as HTMLElement[];
    const diff = path.find((el) => el?.getAttribute?.("data-diff-path"));
    const card = path.find((el) => el?.getAttribute?.("data-open-path"));
    if (!diff && !card) return;
    this.rail = "artifacts";
    this.railClosed = false;
    await this.updateComplete;
    const panel = this.renderRoot.querySelector("artifact-panel") as
      (HTMLElement & {
        showDiff?: (p: string, v: number) => Promise<void>;
        showPath?: (p: string, v: number) => Promise<void>;
      }) | null;
    if (diff) {
      await panel?.showDiff?.(diff.getAttribute("data-diff-path") ?? "",
        Number(diff.getAttribute("data-diff-version") ?? "0"));
      return;
    }
    // A card on a message opens the artifact it names, at the version the
    // message saved — not the newest, because the message is a record of what
    // it did, and clicking it should show that.
    await panel?.showPath?.(card!.getAttribute("data-open-path") ?? "",
      Number(card!.getAttribute("data-open-version") ?? "0"));
  }

  render() {
    const cards = this.cards();
    return html`
      ${this.signedOut ? html`<login-overlay></login-overlay>` : ""}
      <!-- The model picker, written here and drawn in the composer.
           It is at the top level of this template and NOT inside any
           conditional, which is what makes it safe for updated() to move it
           into nr-chatbot's action row: lit builds a static node once and
           never re-inserts it, so the move is permanent and the bindings below
           keep updating it wherever it ends up. Putting it inside the view
           ternary a few lines down would hand lit a part to clear, and every
           switch to the graph view would leak a picker.
           It is invisible until docked - see model-picker.ts - so its position
           in this markup is never what a person sees. -->
      <model-picker
        .choices=${this.choices}
        .choiceId=${this.choiceId}
        .defaultLabel=${this.defaultModelLabel()}
        @pick-choice=${(e: CustomEvent) => { this.choiceId = e.detail.id as string; }}
      ></model-picker>
      <div class="scrim nav" @click=${() => { this.nav = false; }}></div>
      <console-sidebar
        .threads=${this.threads}
        .activeId=${this.threadId}
        .me=${this.me}
        @pick-thread=${(e: CustomEvent) => { this.view = "chat"; this.nav = false; this.open(e.detail.id); }}
        @new-thread=${() => { this.view = "chat"; this.nav = false; this.fresh(); }}
        @collapse=${() => { this.nav = false; }}
        @open-settings=${() => { this.settings = true; }}
        @open-knowledge=${() => { this.view = "knowledge"; }}
        @open-canvas=${() => { this.view = "canvas"; }}
        @open-starts=${() => { void this.openStarts(); }}
      ></console-sidebar>

      <div class="center">
        ${this.view === "knowledge" ? html`<knowledge-page></knowledge-page>`
          : this.view === "canvas" ? html`<agent-canvas></agent-canvas>`
          : this.view === "starts" ? this.startsPage() : html`
        <header>
          <button class="icon nav" title="Conversations"
            @click=${() => { this.nav = !this.nav; }}>
            <nr-icon name="panel-left" size="medium"></nr-icon>
          </button>
          <!-- Starting a conversation was reachable only from inside the
               drawer, which on a phone means opening a panel to leave the one
               you are in. It is the second thing every chat client puts in its
               header, next to the drawer toggle, and it is one call to the
               same fresh() the drawer's own button dispatches.
               square-pen and not message-square-plus: the latter is not in
               icon-paths, and nr-icon draws the NAME when it has no glyph, so
               a wrong guess here prints the word in the header.
               (No backticks in this comment: it lives inside an html
               template literal, where one ends the literal.) -->
          <button class="icon" title="New conversation"
            @click=${() => { this.view = "chat"; this.nav = false; this.fresh(); }}>
            <nr-icon name="square-pen" size="medium"></nr-icon>
          </button>
          <span class="title">${this.threadTitle()}</span>
          <span class="chip"><nr-icon class="bolt" name="zap" size="small"></nr-icon>
            ${this.threadId === "" ? html`
              <select @change=${(e: Event) => { this.agentId = (e.target as HTMLSelectElement).value; }}>
                ${this.agents.map((a) => html`
                  <option value=${a.id} ?selected=${a.id === this.agentId}>${a.agentName}</option>`)}
              </select>` : this.agentName()}
          </span>
          <!-- Offer this conversation as a starting point. Only on a
               conversation that exists — there is nothing to offer before the
               first message — and pressed when it is already on offer, so the
               control reports the state rather than only changing it. -->
          ${this.threadId === "" ? nothing : html`
            <button class="icon" aria-pressed=${this.offered}
              title=${this.offered
                ? "Offered as a starting point — press to withdraw"
                : "Offer this conversation as a starting point"}
              @click=${() => { void this.toggleOffer(); }}>
              <nr-icon name="share" size="medium"></nr-icon>
            </button>`}
          <button class="icon" title="Artifacts" aria-pressed=${this.rail === "artifacts"}
            @click=${() => this.show("artifacts")}><nr-icon name="folder" size="medium"></nr-icon></button>
        </header>
        <main class=${this.session.getState().messages.length === 0
          ? (this.starts.length > 0 ? "empty has-starts" : "empty") : ""}>
          <!-- The session is the controller. Messages are not passed in: the
               component reads them from the controller's state, and a second
               binding would fight it. The message-sent event is not listened
               for either - it is announced after a send, not a request to
               perform one. -->
          <!-- boxed is the Kimi home reading the component already knows:
               empty state centered in a 768px column, the composer joined
               beneath it at the page's upper third, chips underneath — and
               the ordinary bottom-pinned layout the moment messages exist. -->
          ${this.mine ? nothing : html`
            <!-- Somebody else's starting point. No composer: a message sent
                 here would be refused by the engine (every write still goes
                 through ownership), and a control that cannot work is worse
                 than one that is not drawn. The way to continue is a copy. -->
            <div class="borrowed">
              <span>You are reading a conversation somebody offered as a starting
                point. Remix it to continue in one of your own.</span>
              <button class="offer-remix" @click=${() => { void this.remix(this.threadId); }}>
                Remix
              </button>
            </div>`}
          <nr-chatbot class=${this.session.getState().messages.length > 0 ? "talking" : ""}
            @click=${(e: Event) => { void this.chipClick(e); }}
            .controller=${this.session}
            .isBotTyping=${this.busy}
            .isQueryRunning=${this.busy}
            enable-file-upload
            boxed
            welcome-message=${WORDMARK}
            placeholder="Ask ${this.agentName()}…"
            attach-icon="plus"
            .i18n=${{ input: { attachButton: "" } }}
            .attachItems=${this.attachMenu()}
          ></nr-chatbot>
          ${this.session.getState().messages.length > 0 ? "" : this.capabilityRow()}
        </main>
        ${cards.length === 0 ? "" : html`
        <div class="cards">
          ${cards.map((c) => html`
            <button class="card" title=${c.path}
              @click=${() => { void this.openCard(c); }}>
              <span class="card-name">${c.title === "" ? c.path : c.title}</span>
              <span class="card-meta">${c.kind} · v${c.version}</span>
            </button>`)}
        </div>`}`}
      </div>

      ${this.rail === "artifacts"
        ? html`
          <!-- Rendered with the panel rather than always, unlike the drawer's:
               the drawer element is permanent and only transformed off screen,
               so its scrim needs a host attribute to know when to paint. This
               one exists exactly as long as the thing it dims. Closing through
               the same path as the header toggle, railClosed included, so a
               tap outside is a decision the auto-open respects. -->
          <div class="scrim files"
               @click=${() => { this.rail = ""; this.railClosed = true; }}></div>
          <artifact-panel .threadId=${this.threadId}
            @close-rail=${() => { this.rail = ""; this.railClosed = true; }}
            .ensureThread=${() => this.session.ensureThread()}></artifact-panel>` : ""}
      ${this.settings ? html`<console-settings @close=${() => {
        this.settings = false;
        // The settings tab says a change takes effect on the next message with
        // no restart. That was only true of the server: the header, the agent
        // picker and the placeholder all read a list fetched once at startup,
        // so a rename or a disable was invisible here until a page reload.
        void this.reloadAgents();
      }}></console-settings>` : ""}
    `;
  }
}

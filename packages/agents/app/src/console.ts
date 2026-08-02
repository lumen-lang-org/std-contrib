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
import "./knowledge.js";
import "./canvas.js";
import "./login-overlay.js";
import "./model-picker.js";
import "./settings.js";
import {
  AgentFull, ArtifactListing, Me, ModelChoice, ModelRow, ThreadListing, TurnArtifactRef, WireRef,
  SIGNED_OUT, SkillRow, TemplateRow, artifactsByTurn, featuredSkills, listAgents, listArtifacts,
  listModels, listThreads, modelChoices, previewUrl, listTemplateFiles, offerThread, remixThread, replayableThreads, startFromTemplate, transcript, templatePdf, templatesOfKind, whoami,
  ServerRow, listServers, listSkills, copySkillLocally,
  PluginRow, listPlugins, pluginItems,
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
/* One row of the + menu's gallery, whether it is a skill or a server. The
   two lists are drawn by the same code and so have to describe themselves the
   same way; `source` is what the skills half splits on and is "local" for a
   server, which has no such distinction yet. */
/* One row of the slash menu. Two kinds, because the menu answers two
   questions with one gesture — which skill runs, and which agent answers —
   and `kind` is what tells pickSlash which of those a press meant. */
type SlashRow = {
  kind: "skill" | "agent";
  key: string; name: string; why: string; icon: string; on: boolean;
};

type GalleryRow = {
  key: string; name: string; why: string; on: boolean; icon: string;
  source: string; id: string;
  /* Where this came from, in the words a person reads on the card: "From you",
     "From a plugin", "From github.com". Kimi puts the same line under every
     name in its skills gallery ("From Kimi"), and it earns its space here for
     a reason theirs does not have to carry — provenance decides what you can
     do with the thing. Yours is editable, a repository's is not, and a
     plugin's disappears when the plugin does. */
  from: string;
};

/* What the directory holds. Three of the four are acquired three different
   ways — a skill you write, a connector you address, a plugin you install —
   and Claude splits its own directory on the same seam; ours called two of
   them "Plugins" and had no word left for the third. Agents joined them
   because the rail needed somewhere to send "who am I talking to", and it is
   the same shape: a shelf of cards, one of which you pick. */
type Shelf = "" | "skills" | "agents" | "connectors" | "plugins";

/* How many rows the slash menu will ever draw. Six is about a third of a phone
   screen: enough that a match is usually visible without the menu becoming the
   page. Past it, keep typing — that is what the filter is for. */
const SLASH_ROWS = 6;

/* The skill the globe switches on. A name and not an id: the globe is a switch
   on a capability, and pin() speaks names. */
const SEARCH_SKILL = "search-web";

const capIcon = (name: string) => CAPS[name]?.icon ?? "tool";
const capKind = (name: string) => CAPS[name]?.kind ?? "";

// A mark for a server, recognised from what it calls itself or where it points.
//
// These are not brand marks and cannot be: the icon set carries no Jira, no
// GitHub, no Slack, and the rule in CLAUDE.md against emoji rules out the
// usual cheat — an emoji is a font, so it is a coloured cartoon on one machine
// and an empty box on the next. So each known service gets the closest true
// thing in the set (an issue tracker is a calendar of work, a repository is a
// link to somewhere else, a mail server is mail), and everything unrecognised
// gets `plug`, which is what an MCP server is.
//
// Matching on both name and endpoint because either can be the honest one: a
// server called "tickets" pointed at atlassian.net is Jira, and so is one
// called "Jira" behind a gateway URL that says nothing.
const SERVICE_ICONS: [RegExp, string][] = [
  [/jira|atlassian|linear|tracker|issue/i, "calendar"],
  [/github|gitlab|bitbucket|repo/i, "link"],
  [/mail|gmail|smtp|imap/i, "mail"],
  [/file|drive|dropbox|s3|storage|bucket/i, "hard-drive"],
  [/postgres|mysql|sqlite|database|sql/i, "database"],
  [/web|search|browse|fetch|http-client/i, "globe"],
];
// The name is asked first, and the endpoint is reduced to its host before it
// is asked at all. Both matter: a pattern let loose on a whole endpoint
// matches the scheme, and since every endpoint is an http URL, one greedy
// `http` turned a server plainly called "filesystem" into a globe.
const serverIcon = (s: { serverName: string; endpoint: string }) => {
  const host = s.endpoint.replace(/^[a-z]+:\/\//i, "").split(/[/:?]/)[0] ?? "";
  for (const [re, icon] of SERVICE_ICONS) if (re.test(s.serverName)) return icon;
  for (const [re, icon] of SERVICE_ICONS) if (re.test(host)) return icon;
  return "plug";
};

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

const CHAT_SOURCES = `
  .joule-sources { display: flex; flex-wrap: wrap; gap: 6px;
                   margin: 10px 0 2px; }
  .joule-source { display: inline-flex; align-items: center; gap: 6px;
                  max-width: 220px; padding: 4px 10px 4px 7px;
                  border: 1px solid var(--border, rgba(0,0,0,.09));
                  border-radius: 999px; text-decoration: none;
                  font-size: 12.5px; line-height: 1.3;
                  color: var(--muted, rgba(0,0,0,.45));
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .joule-source:hover { color: var(--fg, rgba(0,0,0,.9));
                        border-color: var(--muted, rgba(0,0,0,.45)); }
  .joule-source img { border-radius: 3px; flex: none; }
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
  adopt(chat.shadowRoot, CHAT_SOURCES, "sourced");
  for (const el of chat.shadowRoot.querySelectorAll("nr-button")) {
    if (el.shadowRoot !== null) { adopt(el.shadowRoot, CHAT_BUTTON, "skinned"); }
  }
  citeSources(chat.shadowRoot);
}

/* The pages an answer stood on, under the answer.
 *
 * A model that searched says so in prose — "according to github.com/..." — and
 * a url in a sentence is a thing to squint at rather than a thing to click.
 * This lifts every link out of a finished turn and puts the distinct ones in a
 * row beneath it: favicon, host, one click.
 *
 * Read off the rendered message rather than carried alongside it, because the
 * transcript is the one place every path agrees. A turn that searched, a turn
 * that was handed a link, and a turn replayed from history all arrive here the
 * same way — nothing has to be threaded through the session, the socket and
 * the API for the row to appear.
 *
 * The favicon comes from DuckDuckGo's icon service, which is a request to a
 * third party for every distinct host an answer cites. That is a real cost and
 * the reason it is one host and not a page fetch: it leaks which domains were
 * cited, to a company that already saw the search. `onerror` hides the image
 * rather than leaving a broken glyph, so a host with no icon degrades to text.
 */
function citeSources(root: ShadowRoot) {
  for (const msg of root.querySelectorAll(".message.bot .message__content")) {
    const holder = msg as HTMLElement & { cited?: boolean };
    if (holder.cited === true) { continue; }
    // The text, not the anchors. The transcript renders a model's urls as
    // plain words — there is no linkifier in the component and the console
    // escapes what it stores — so a pass that lifted <a href> found nothing on
    // an answer that plainly cited two pages.
    const text = holder.textContent ?? "";
    const found = text.match(/https?:\/\/[^\s<>"')\]]+/g);
    if (found === null) { continue; }
    const seen = new Set<string>();
    const hosts: { host: string; href: string }[] = [];
    for (const raw of found) {
      // Trailing punctuation belongs to the sentence, not the address.
      const href = raw.replace(/[.,;:!?)]+$/, "");
      let host = "";
      try { host = new URL(href).hostname.replace(/^www\./, ""); } catch { continue; }
      // One entry per SITE. An answer citing four pages of one doc set is
      // citing one source, and four identical favicons say less than one.
      if (host === "" || seen.has(host)) { continue; }
      seen.add(host);
      hosts.push({ host, href });
    }
    if (hosts.length === 0) { continue; }
    holder.cited = true;
    const row = document.createElement("div");
    row.className = "joule-sources";
    for (const s of hosts) {
      const chip = document.createElement("a");
      chip.className = "joule-source";
      chip.href = s.href;
      chip.target = "_blank";
      // noopener: the linked page is somebody else's, and window.opener would
      // be a handle on this one.
      chip.rel = "noopener noreferrer";
      const img = document.createElement("img");
      img.src = "https://icons.duckduckgo.com/ip3/" + s.host + ".ico";
      img.alt = "";
      img.width = 14;
      img.height = 14;
      img.addEventListener("error", () => { img.style.display = "none"; });
      chip.append(img, document.createTextNode(s.host));
      row.appendChild(chip);
    }
    holder.appendChild(row);
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
    /* touch-action: none, so a drag that begins on the dimmed area is not a
       scroll of the page under it. The scrim's job is to swallow what is
       behind it, and on a touch screen a gesture is as much "behind it" as a
       click is. */
    .scrim { display: none; background: rgba(0,0,0,.28);
             overscroll-behavior: contain; touch-action: none; }
    .center { flex: 1; display: flex; flex-direction: column; min-width: 0;
              position: relative; }
    /* The bar across the bottom of an empty home, the way Kimi draws it: a
       thing to look at when you have nothing to type, rather than a screen of
       nothing under the composer. Theirs pairs a label on the left with a
       quieter hint and a chevron on the right, at 14px, and reads at about
       56% and 42% white — which is what --muted and --faint already are here.
       Floating over the column rather than sitting in the flow, so it does not
       enter the centring calculation the wordmark and composer depend on.
       The chevron points RIGHT and theirs points up: theirs raises a panel
       over the page, this one leaves for another. An arrow that lies about
       where the content is costs more than the symmetry is worth. */
    /* Fixed to the viewport, not absolute in the column. Absolute pinned it to
       the bottom of .center, which is the page — and a phone's page is not what
       a phone shows you. Safari keeps its toolbar over the bottom of the
       viewport and reports a taller one until it collapses, so the bar sat
       under the chrome and simply was not there. Fixed answers to the visual
       viewport instead, and safe-area-inset-bottom keeps it clear of the home
       indicator on a device that has one (0 everywhere else, so the expression
       is the same rule on a laptop). */
    /* A phone control, and only there: the rail carries "Starting points" as a
       row already, so on a screen wide enough to show the rail this bar would
       be a second door beside an open one. On a phone the rail is a drawer,
       which puts the same destination two taps and a panel away — that gap is
       the whole reason this exists. Enabled in the phone block further down,
       because a media query has to come after the rule it overrides. */
    .explore { display: none; position: fixed; left: 12px; right: 12px;
               bottom: calc(12px + env(safe-area-inset-bottom, 0px));
               align-items: center; justify-content: space-between;
               gap: 10px; padding: 9px 14px; border-radius: 14px;
               /* Neither filled nor outlined. A fill made it a card on a page
                  whose point is that it is empty; the outline that replaced it
                  drew a box around the emptiness instead. What is left is the
                  words, which is all the row ever needed to be — the label and
                  the chevron say it is a target. */
               border: 0; background: none;
               color: var(--muted); font: inherit; font-size: 14px;
               cursor: pointer; text-align: left;
               transition: background-color .15s cubic-bezier(.23,1,.32,1); }
    .explore:hover { background: var(--bg-sunken); }
    .explore span { display: inline-flex; align-items: center; gap: 7px;
                    min-width: 0; }
    .explore .hint { color: var(--faint); flex: none; }
    .explore .label { overflow: hidden; text-overflow: ellipsis;
                      white-space: nowrap; }
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
      .explore { display: flex; }
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
    /* Higher again on a phone. The figure above centres a block in a window
       wider than it is tall; a phone is the other shape, and the same block
       reads low because what is left under it is a third of the screen rather
       than a strip. Half the difference is what moves — padding-bottom biases
       a centred box by half of itself — so this is ~25px up at 844px, and it
       scales with the screen instead of naming a pixel that suits one phone.

       Here rather than in the phone block above, which is the whole reason
       this needs saying: that block is written EARLIER in this stylesheet, so
       at equal specificity the desktop rule above would win and the override
       would do nothing at all. A media query is not stronger than the rule it
       means to replace; it only has to come after it. */
    @media (max-width: 640px) { main.empty { padding-bottom: 24vh; } }
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
    .starts-page { padding: 28px 24px; max-width: 1240px; margin: 0 auto;
                   overflow-y: auto; }
    /* Desktop is where this page had never been designed: 900px of column on
       a 1900px window, one card adrift in it. The width above is most of the
       fix; the rest is air — this is a browsing page, and it gets the same
       generosity the directory got. */
    @media (min-width: 1025px) {
      .starts-page { padding: 40px 48px; }
      .starts-page h2 { font-size: 24px; }
      .starts-intro { margin-bottom: 28px; }
      .offer-grid { gap: 16px;
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
      .offer { padding: 18px; border-radius: 14px;
               transition: border-color .15s cubic-bezier(.23,1,.32,1),
                           background-color .15s cubic-bezier(.23,1,.32,1); }
      .offer:hover { border-color: var(--muted); background: var(--bg-sunken); }
    }
    /* The skills gallery. A sheet on a phone and a centred card above it —
       the artifact panel's shape, because a person has met it already and a
       third way of showing a temporary surface is a third thing to learn. */
    /* Its own backdrop, at every width. The files scrim it used to borrow is
       displayed only inside the 1024px media block — it was written for the
       files sheet, which only exists there — so on a desktop this panel
       floated over a fully lit page with nothing behind it: no dimming, and a
       click on the page underneath went to the page. This one is the
       directory's own, always drawn, and it is what makes the panel read as
       being in front of the conversation rather than pasted onto it. */
    .scrim.shelves { display: block; position: fixed; inset: 0; z-index: 39;
                     background: rgba(0,0,0,.32); backdrop-filter: blur(2px); }
    /* Wide enough to be a directory. At 560px the card grid fell to two
       columns on a 1500px screen and the panel read as a menu that had been
       stretched; a directory is something you browse, and browsing wants the
       width. Still bounded — a panel edge to edge is a page, and this one is
       deliberately not a page. */
    .gallery { position: fixed; z-index: 40; background: var(--bg-card);
              border: 1px solid var(--border); border-radius: 16px;
              box-shadow: 0 24px 60px -12px rgba(0,0,0,.35);
              display: flex; flex-direction: column; overflow: hidden;
              left: 50%; transform: translateX(-50%); top: 8vh; bottom: 8vh;
              width: min(980px, calc(100% - 48px)); }
    .gallery-head { display: flex; align-items: center; justify-content: space-between;
                   padding: 12px 10px 12px 16px; font-weight: 600;
                   border-bottom: 1px solid var(--border); }
    /* Cards, not rows. A row list is for things you scan down looking for one
       name you already know; these are things you are choosing between, and a
       card gives the description room to be read rather than truncated to a
       trailing ellipsis. Two columns where there is width for them, one on a
       phone — auto-fill rather than a fixed count, so it is the panel's width
       that decides and not a breakpoint that has to be kept in step with it. */
    /* overscroll-behavior, and it is the whole of the phone bug it fixes.
       The list scrolls perfectly well — 563px of window over 1427px of cards —
       but with the default 'auto' a drag that reaches either end keeps going
       into whatever is behind, and on a touch screen a flick reaches the end
       constantly. What that looks like is a panel that will not scroll and a
       page that scrolls instead. 'contain' stops the chain at this box.
       min-height: 0 belongs with it: this is a grid inside a flex column, and
       a flex child's automatic minimum is its content, so the day the panel
       is shorter than the cards it would grow past the panel rather than
       scroll inside it. It has not happened yet only because the phone sheet
       is tall. */
    .gallery-list { overflow-y: auto; overscroll-behavior: contain;
                    -webkit-overflow-scrolling: touch; min-height: 0;
                    padding: 14px 16px 16px; display: grid; gap: 10px;
                    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                    align-content: start; }
    /* Under a heading the grid stops being the scroller — the column of
       headings and grids is. Two grids each with their own scrollbar is two
       lists in one panel. */
    .gallery-list.flat { overflow: visible; padding: 0 16px 14px; }
    .gallery-scroll { overflow-y: auto; overscroll-behavior: contain;
                      -webkit-overflow-scrolling: touch; min-height: 0; }
    .gallery-group { font-size: 12px; font-weight: 600; letter-spacing: .04em;
                     text-transform: uppercase; color: var(--faint);
                     padding: 16px 16px 8px;
                     display: flex; align-items: center; gap: 7px; }
    .gallery-title { display: flex; align-items: center; gap: 8px; }
    /* Tabs where the title used to be. Text and a count, separated by nothing
       but weight and ink — a pill or a border per tab would make three of them
       heavier than the cards underneath, which are the actual subject. */
    .gallery-tabs { display: flex; align-items: center; gap: 4px;
                    min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .gallery-tabs::-webkit-scrollbar { display: none; }
    .gallery-tab { display: flex; align-items: center; gap: 7px; flex: none;
                   padding: 6px 10px; border: 0; border-radius: 9px;
                   background: none; font: inherit; font-weight: 600;
                   font-size: 14.5px; color: var(--faint); cursor: pointer;
                   transition: color .15s cubic-bezier(.23,1,.32,1),
                               background-color .15s cubic-bezier(.23,1,.32,1); }
    .gallery-tab:hover { color: var(--muted); background: var(--bg-sunken); }
    .gallery-tab.on { color: var(--fg); background: var(--fill-1); }
    /* One line saying what this shelf is. Three nouns that sound alike need
       it once, where somebody is looking at them. */
    .gallery-lede { margin: 12px 16px 0; color: var(--muted);
                    font-size: 13px; line-height: 1.45; }
    .pick-from { font-size: 12px; color: var(--faint); }
    /* How many, beside the name. Both references carry the number rather than
       making you count the cards, and it is the fastest way to see that a
       filter is hiding most of them. */
    .gallery-count { font-size: 11px; font-weight: 600; letter-spacing: 0;
                     color: var(--faint); background: var(--fill-1);
                     border: 1px solid var(--border); border-radius: 999px;
                     padding: 1px 7px; text-transform: none; }
    .gallery-find { display: flex; align-items: center; gap: 8px;
                    margin: 12px 16px 0; padding: 8px 12px; border-radius: 10px;
                    border: 1px solid var(--border); color: var(--faint); }
    .gallery-find:focus-within { border-color: var(--focus); }
    .gallery-find input { flex: 1; min-width: 0; border: 0; background: none;
                          font: inherit; font-size: 14px; color: var(--fg);
                          outline: none; }
    .gallery-find input::placeholder { color: var(--faint); }
    /* The mark sits on a tile rather than loose beside the name — a bare glyph
       at 14px next to bold text reads as punctuation. Both references give it
       a square of its own, which is also what keeps the names on a shared left
       edge when one skill's icon is wider than another's. */
    .pick-tile { display: grid; place-items: center; flex: none;
                 width: 26px; height: 26px; border-radius: 8px;
                 background: var(--fill-1); border: 1px solid var(--border);
                 color: var(--muted); }
    .pick.on .pick-tile { color: var(--fg); }
    /* The slash menu. Anchored to the bottom of the viewport above the
       composer's own band rather than measured against the composer, which
       grows as you type — see slashMenu() for why that matters. */
    .slash { position: fixed; z-index: 45; left: 50%; bottom: 132px;
             transform: translateX(-50%);
             width: min(560px, calc(100% - 24px));
             max-height: 46vh; overflow-y: auto; overscroll-behavior: contain;
             background: var(--bg-card); border: 1px solid var(--border);
             border-radius: 14px; padding: 6px;
             display: flex; flex-direction: column; gap: 2px;
             box-shadow: 0 10px 30px rgba(0,0,0,.28); }
    .slash-row { display: flex; align-items: center; gap: 10px; width: 100%;
                 text-align: left; padding: 8px 10px; border: 0;
                 border-radius: 10px; background: none; font: inherit;
                 color: var(--fg); cursor: pointer; }
    .slash-row:hover { background: var(--bg-sunken); }
    .slash-row.on { background: var(--bg-user); }
    .slash-text { display: flex; flex-direction: column; gap: 1px;
                  min-width: 0; }
    .pick-act { align-self: flex-start; margin-top: 2px; font-size: 12.5px;
                color: var(--muted); border: 1px solid var(--border);
                border-radius: 999px; padding: 3px 10px; cursor: pointer; }
    .pick-act:hover { color: var(--fg); border-color: var(--muted);
                      background: var(--bg-sunken); }
    .pick-act:focus-visible { outline: 2px solid var(--focus);
                              outline-offset: 2px; }
    .gallery-none { color: var(--muted); padding: 18px 16px; margin: 0; }
    .pick { display: flex; flex-direction: column; gap: 5px; text-align: left;
            padding: 12px; border: 1px solid var(--border); border-radius: 12px;
            background: none; font: inherit; color: var(--fg); cursor: pointer;
            transition: background-color .15s cubic-bezier(.23,1,.32,1),
                        border-color .15s cubic-bezier(.23,1,.32,1); }
    .pick:hover:not(:disabled) { background: var(--bg-sunken);
                                 border-color: var(--muted); }
    .pick-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
    /* Plugins are shown, not chosen — a server is attached to an agent in
       Settings. Disabled rather than absent, because the list is the answer to
       "what is available"; not-a-button is the honest way to say the choosing
       happens elsewhere. */
    .pick:disabled { cursor: default; }
    .pick.on { background: var(--bg-user); }
    .pick-name { font-size: 14px; font-weight: 600; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap; }
    /* Three lines, then stop. A card whose height follows its description
       makes a grid of ragged boxes, and the full text is on the card's title
       for anyone who wants it. */
    .pick-why { font-size: 13px; color: var(--muted); line-height: 1.4;
                overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3;
                -webkit-box-orient: vertical; }
    .starts-back { display: inline-flex; align-items: center; gap: 4px;
                   margin: 0 0 14px -6px; padding: 6px 10px 6px 6px;
                   border: 0; border-radius: 8px; background: none; font: inherit;
                   font-size: 14px; color: var(--muted); cursor: pointer; }
    .starts-back:hover { background: var(--bg-sunken); color: var(--fg); }
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
  /* Which shelf of the directory is open, or "" for closed. It is also the
     active tab: the overlay is one surface with three tabs rather than three
     surfaces, which is Kimi's shape — you go there to browse, and browsing
     means moving between them without closing anything. */
  @state() private gallery: Shelf = "";
  /* What is typed into the gallery's filter. Cleared when it opens, because a
     filter left over from last time is a gallery that looks empty. */
  @state() private galleryFind = "";
  /* The slash menu: what has been typed after "/" in the composer, or null
     when the composer holds anything that is not a lone slash-word. null
     rather than "" because "" is a real state — the moment after the slash,
     when every skill matches. */
  @state() private slash: string | null = null;
  /* Every skill, not just the featured few the chips draw. Fetched the first
     time the gallery is opened rather than on load: a console that nobody
     asks is a console that should not have asked. */
  @state() private allSkills: SkillRow[] = [];
  /* MCP servers, which the + menu calls Plugins. Loaded with the rest so the
     menu knows whether to offer the row at all — the alternative is a row that
     opens an empty panel. */
  @state() private servers: ServerRow[] = [];
  /* Installed bundles, and what each one brought. The directory needs the
     second to say "From <plugin>" on a skill card: a plugin's skill is stored
     as an ordinary repo-sourced skill, so without the receipts there is no way
     to tell one that came from a bundle from one somebody synced by hand. */
  @state() private plugins: PluginRow[] = [];
  /* Which agent the graph view opens selected on — set by the card that
     opened it, cleared by nothing: the canvas ignores it after first load. */
  @state() private canvasFocus = "";
  @state() private pluginOf = new Map<string, string>();

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
    this.startDot();
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
    // Only to decide whether the + menu offers a Plugins row. A deployment
    // with no servers should not have one, and finding that out after the menu
    // is open is too late.
    this.servers = await listServers().catch(() => []);
    // The whole skill list, at startup rather than on first use.
    //
    // It was lazy — fetched when the gallery or the slash menu first opened —
    // and that was fine until something had to know about a skill BEFORE
    // anyone asked: the composer's globe appears only where search-web
    // exists, and a list that arrives after the composer is drawn means a
    // control that is simply missing. search-web is not featured, so the
    // capability list does not carry it either. One small call at boot buys
    // the answer for every reader of it.
    this.allSkills = await listSkills().catch(() => []);
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
    if (this.dotTicker !== null) { clearInterval(this.dotTicker); this.dotTicker = null; }
    if (this.unlisten !== null) { this.unlisten(); this.unlisten = null; }
  }

  /* The wordmark's period, drifting through colours.
     Set on documentElement rather than on this element: the mark is drawn deep
     inside nr-chatbot's shadow root, and a custom property inherits across a
     shadow boundary while no selector written here can reach through one.
     Hue only — saturation and lightness are pinned so every colour it lands on
     is one this palette would have chosen, and none of them is a grey that
     makes the dot look broken or a neon that makes it look like an error. The
     step is randomised but bounded away from zero, so consecutive colours are
     always visibly different rather than occasionally the same twice.
     Timer, not a CSS animation, because "random" is the requirement and
     keyframes can only ever be a fixed cycle. Cleared on disconnect. */
  private startDot() {
    if (this.dotTicker !== null) return;
    let hue = Math.floor(Math.random() * 360);
    const paint = () => {
      hue = (hue + 40 + Math.floor(Math.random() * 280)) % 360;
      document.documentElement.style
        .setProperty("--nuraly-chatbot-brand-dot", `hsl(${hue} 72% 58%)`);
    };
    paint();
    this.dotTicker = setInterval(paint, 1400);
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
    this.watchComposerKeys();
  }

  /* Enter, before the composer gets it.
   *
   * The slash menu has to answer Enter, and a `@keydown` on <nr-chatbot> is
   * too late to: the component's own handler is bound to the contenteditable
   * INSIDE its shadow root, and an event reaches the target's own listeners
   * before it bubbles to the host. So with the menu open, Enter both chose a
   * skill and sent what was typed — "/sheet" went to the model as a message,
   * a real turn came back, and the empty home (with its Starting points bar)
   * was correctly replaced by a conversation. What looked like a disappearing
   * footer was a message nobody meant to send.
   *
   * Capture runs the other way, outermost first, so this sees Enter before the
   * component does and can stop it there. Attached to the element rather than
   * declared in the template because Lit's bindings are bubble-phase only.
   * Idempotent: `updated` runs on every render, and addEventListener with the
   * same function and phase is a no-op after the first. */
  private watchComposerKeys() {
    const chat = this.renderRoot.querySelector("nr-chatbot") as Element | null;
    if (chat === null) return;
    chat.addEventListener("keydown", this.composerKey as EventListener, true);
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
    // The globe first, and outside the guard below: whether the operator has
    // curated a model menu has nothing to do with whether this deployment can
    // search, and hanging one on the other is how a control goes missing for
    // reasons nobody can see.
    const chatEl = this.renderRoot.querySelector("nr-chatbot") as
      (Element & { updateComplete?: Promise<unknown> }) | null;
    if (chatEl !== null) {
      await chatEl.updateComplete;
      this.dockSearch(chatEl);
    }
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

  /* The globe, beside the + in the composer.
   *
   * Docked the way the model picker is, and for the same reason: the row it
   * belongs in is drawn inside nr-chatbot's shadow root, so a control that
   * belongs beside the + has to be moved there — nothing written in this
   * component's template can render into that row.
   *
   * It is a switch on one skill rather than a mode of its own. Search IS a
   * skill here, so turning it on is pinning search-web and turning it off is
   * unpinning it; a second mechanism that meant the same thing would be a
   * second thing to keep in step. That also means the state survives being
   * set from anywhere else — the slash menu, the gallery, the chips — because
   * there is only one piece of state.
   *
   * Absent when the deployment has no search skill. A globe that turns nothing
   * on is worse than no globe.
   */
  private dockSearch(chat: Element & { updateComplete?: Promise<unknown> }) {
    if (!this.hasSearchSkill()) return;
    const left = chat.shadowRoot?.querySelector(".action-buttons-left") ?? null;
    if (left === null) return;
    let globe = left.querySelector(".joule-search") as HTMLElement | null;
    if (globe === null) {
      globe = document.createElement("button");
      globe.className = "joule-search";
      // setAttribute, not .type: the variable is an HTMLElement (the query
      // above cannot know it found a button), and a cast for one attribute is
      // noise where an attribute call says the same thing.
      globe.setAttribute("type", "button");
      globe.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
        + 'stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle>'
        + '<path d="M2 12h20"></path>'
        + '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 '
        + '15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>';
      // The mark is inline SVG and not <nr-icon>, which the rest of this
      // console uses without exception. The reason is the boundary: this
      // element is adopted into another component's shadow root, and a custom
      // element moved there still resolves — but its styling reaches for
      // tokens through a tree it no longer sits in, and the icon came out at
      // the wrong size with no colour. A path has no such dependency.
      globe.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.pin(SEARCH_SKILL);
      });
      left.appendChild(globe);
      this.styleSearchGlobe(chat);
    }
    const on = this.pinned === SEARCH_SKILL;
    globe.setAttribute("aria-pressed", on ? "true" : "false");
    globe.title = on ? "Web search is on" : "Search the web";
    globe.classList.toggle("on", on);
  }

  private hasSearchSkill(): boolean {
    return this.capabilities.some((s) => s.skillName === SEARCH_SKILL)
      || this.allSkills.some((s) => s.skillName === SEARCH_SKILL);
  }

  /* One stylesheet, adopted into the composer's root once. The button lives in
     nr-chatbot's shadow tree, so this component's own styles do not reach it;
     adopting is the supported way in, and the guard keeps a re-render from
     stacking copies. */
  private styleSearchGlobe(chat: Element) {
    const root = chat.shadowRoot;
    if (root === null || root === undefined) return;
    const already = (root as ShadowRoot & { jouleSearchStyled?: boolean });
    if (already.jouleSearchStyled === true) return;
    already.jouleSearchStyled = true;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .joule-search { display: inline-grid; place-items: center;
        width: 28px; height: 28px; margin-left: 2px; padding: 0;
        border: 0; border-radius: 999px; background: none; cursor: pointer;
        color: var(--nuraly-chatbot-placeholder, rgba(0,0,0,.45));
        transition: background-color .15s ease, color .15s ease; }
      .joule-search:hover { color: var(--nuraly-chatbot-brand-fg, #17171A);
        background: var(--bg-sunken, rgba(0,0,0,.05)); }
      .joule-search.on { color: var(--focus, #2563EB);
        background: var(--bg-user, rgba(37,99,235,.10)); }
    `);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
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
  private dotTicker: ReturnType<typeof setInterval> | null = null;

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
  /* The composer's + menu: what you can bring into a message.

     Three rows where it used to be one plus a copy of the capability chips.
     The chips are already on screen directly beneath the composer, so
     repeating them here spent the menu on the only things that did not need
     it — and worse, they did nothing: nr-chatbot's own dropdown handler acts
     on `upload-file` and `upload-url` and ignores every other id, so those
     rows were dead the whole time. The event does escape the component
     (bubbles and composed, from the dropdown controller), so what was missing
     was a listener here, which render() now has.

     Skills and Plugins open a picker rather than listing their contents
     inline: there are fourteen skills on this deployment and a menu that long
     is a list with a lid on it. Plugins appears only where there are servers
     to show, because a row that opens an empty panel teaches you not to press
     the others. */
  private attachMenu() {
    const items = [
      { id: "upload-file", label: "Add files & photos", icon: "paperclip" },
      { id: "pick:skills", label: "Skills", icon: "zap" },
    ];
    // Connectors, not "Plugins" — the row opens the list of MCP servers, and
    // calling that Plugins left no word for a bundle you install. Each row
    // opens the directory on its own tab; the tabs are how you get to the
    // other two once it is open.
    if (this.servers.length > 0) {
      items.push({ id: "pick:connectors", label: "Connectors", icon: "share" });
    }
    if (this.plugins.length > 0) {
      items.push({ id: "pick:plugins", label: "Plugins", icon: "cube" });
    }
    return items;
  }

  /* The composer's own text, read where it actually lives.
     nr-chatbot's input is a contenteditable div inside its shadow root, and
     the component publishes no value for it — so this reaches in. Kept to one
     method so there is one place to fix if the component ever grows a real
     property for it. */
  private composerBox(): HTMLElement | null {
    // Typed as Element, because the app's declaration for nr-chatbot names its
    // properties and not the HTMLElement half — asking it for shadowRoot is a
    // compile error even though every element has one.
    const chat = this.renderRoot.querySelector("nr-chatbot") as Element | null;
    return chat?.shadowRoot?.querySelector(".input-box__input") as HTMLElement | null;
  }

  /* Open, filter or close the slash menu as the composer changes.

     The rule is narrow on purpose: a lone "/word" and nothing else. Anything
     with a space in it is a sentence that happens to start with a slash — a
     path, a fraction, a date — and a menu that opened over those would be in
     the way far more often than it helped. `input` is composed, so this fires
     from inside the component's shadow root without the component knowing. */
  private onComposerInput() {
    // The full list is what the menu searches, and it is fetched the first
    // time a slash is typed rather than on load — same reasoning as the
    // gallery: a console nobody asks should not have asked.
    if (this.allSkills.length === 0) { void this.loadAllSkills(); }
    const text = (this.composerBox()?.textContent ?? "").replace(/ /g, " ");
    const m = /^\/([\w-]*)$/.exec(text.trim());
    this.slash = m === null ? null : m[1].toLowerCase();
  }

  private async loadAllSkills(): Promise<void> {
    if (this.allSkills.length > 0) return;
    this.allSkills = await listSkills().catch(() => []);
  }

  /* Choosing from the slash menu: pin the skill and take the "/…" back out.
     The composer is emptied rather than left holding the typed name — the name
     was the way of asking, not part of the message, and leaving it would send
     "/make-doc" to the model as if it were a sentence. */
  private pickSlash(row: SlashRow) {
    if (row.kind === "agent") {
      this.agentId = row.key;
    } else {
      void this.pin(row.key);
    }
    const label = row.kind === "agent" ? row.name : row.key;
    const box = this.composerBox();
    if (box !== null) {
      // Left in the box, not cleared. A pin with an empty composer reads as
      // nothing having happened; the command staying put is what says the
      // choice landed. ChatSession takes this exact string back off the front
      // of the next send, so it is visible without being said.
      const prefix = "/" + label + " ";
      this.session.slashPrefix = prefix;
      box.textContent = prefix;
      const at = document.createRange();
      at.selectNodeContents(box);
      at.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(at);
      // The component tracks its own emptiness for the placeholder and the
      // send button, and it learns about this edit the same way it learns
      // about typing.
      box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      box.focus();
    }
    this.slash = null;
  }

  /* Keys the slash menu owns while it is open, and only then.

     Enter is the one that matters: with the menu up it takes the first match
     instead of sending, because "/make-doc" is not a message and sending it
     would put a command in the transcript. Escape dismisses without touching
     what was typed, so a slash that was genuinely the start of a sentence can
     be carried on with. Everything else falls through to the component —
     stopping keys it needs is how a composer stops accepting text. */
  /* Bound once, so the capture listener can be taken off again. */
  private readonly composerKey = (e: KeyboardEvent) => { this.onComposerKey(e); };

  private onComposerKey(e: KeyboardEvent) {
    if (this.slash === null) return;
    if (e.key === "Escape") { this.slash = null; e.stopPropagation(); return; }
    if (e.key !== "Enter" || e.shiftKey) return;
    const rows = this.slashMatches();
    if (rows.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.pickSlash(rows[0]);
  }

  /* The rows a slash query matches, in the order the menu draws them. */
  private slashMatches(): SlashRow[] {
    const q = this.slash ?? "";
    const skill = (s: SkillRow): SlashRow => ({
      kind: "skill", key: s.skillName, name: s.skillName, why: s.description,
      icon: capIcon(s.skillName), on: this.pinned === s.skillName,
    });
    // Agents, but only where choosing one still means anything.
    //
    // The header offers its picker on a NEW conversation and prints a name on
    // an existing one, because the agent answering a thread is fixed once that
    // thread exists. A slash row that switched it mid-conversation would be
    // offering something the rest of the console refuses, so this follows the
    // same condition rather than inventing a second rule.
    //
    // Servers are deliberately absent. An MCP server is attached to an agent
    // in Settings; there is no per-conversation act to perform on one, and a
    // row that only reports something is a row that does nothing when pressed
    // — the same reason the gallery lists them without making them choosable.
    const agents: SlashRow[] = this.threadId !== "" ? [] : this.agents.map((a) => ({
      kind: "agent", key: a.id, name: a.agentName,
      why: a.description === "" ? "Agent" : a.description,
      icon: "user", on: a.id === this.agentId,
    }));
    // A bare slash offers the shelf, not the warehouse. Every skill on a
    // deployment with fourteen of them is a menu that covers the composer and
    // asks you to read it — and the featured ones are already the operator's
    // answer to "which of these does anyone want". Typing widens the search to
    // all of them, which is the point at which you have said what you are
    // looking for.
    if (q === "") return this.capabilities.map(skill).slice(0, SLASH_ROWS);
    const hits = [
      ...this.allSkills.filter((s) =>
        (s.skillName + " " + s.description).toLowerCase().includes(q)).map(skill),
      ...agents.filter((a) => (a.name + " " + a.why).toLowerCase().includes(q)),
    ];
    return hits.slice(0, SLASH_ROWS);
  }

  /* What the + menu's rows do. nr-chatbot handles the two file rows itself and
     leaves the rest to whoever is listening; this is that listener. Unknown
     ids fall through on purpose — the component may grow rows of its own. */
  private async onAttachPick(e: Event) {
    const id = (e as CustomEvent).detail?.item?.id as string | undefined;
    if (id === "pick:skills") { await this.openShelf("skills"); }
    else if (id === "pick:connectors") { await this.openShelf("connectors"); }
    else if (id === "pick:plugins") { await this.openShelf("plugins"); }
  }

  /* The slash menu, over the composer.

     A list and not the gallery's cards: this one is read while typing, with
     the answer usually one or two rows down, and a grid of cards would push
     the third match off a phone. It is the same content in the shape the
     moment calls for.

     Fixed and bottom-anchored rather than positioned against the composer:
     the composer moves as it grows, and a menu that has to be re-measured
     every keystroke is a menu that lags a keystroke behind. */
  private slashMenu() {
    if (this.slash === null) return nothing;
    const rows = this.slashMatches();
    if (rows.length === 0) return nothing;
    return html`
      <div class="slash" role="listbox" aria-label="Skills">
        ${rows.map((r) => html`
          <button class=${r.on ? "slash-row on" : "slash-row"}
            role="option" aria-selected=${r.on}
            @mousedown=${(e: Event) => {
              // mousedown, not click: the composer loses focus first
              // otherwise, and a blur that closed the menu would cancel the
              // click that was choosing from it.
              e.preventDefault(); this.pickSlash(r); }}>
            <span class="pick-tile"><nr-icon name=${r.icon}
              size="small"></nr-icon></span>
            <span class="slash-text">
              <span class="pick-name">${r.name}</span>
              <span class="pick-why">${r.why}</span>
            </span>
          </button>`)}
      </div>`;
  }

  /* The directory: skills, connectors and plugins, as a gallery rather than a
     menu.

     One overlay with three tabs, which is Kimi's shape and not an arbitrary
     one — you arrive to browse, and browsing means moving between the three
     without closing anything. The tabs are also the only place in the console
     that says out loud what the three ARE, so the wording under each title is
     doing real work: a skill you write, a connector you address, a plugin you
     install.

     A skill is chosen here the way a capability chip is — pin() — so this adds
     a way in rather than a second mechanism. Connectors and plugins are shown
     and not chosen: a connector is attached to an agent in Settings and a
     plugin is installed there, and a card that looked like it could do either
     from here would be lying about what a press does. */
  private openShelf(shelf: Shelf) {
    this.galleryFind = "";
    this.gallery = shelf;
    return this.loadShelves();
  }

  /* What the directory draws, fetched the first time it is opened. Skills were
     already lazy for the reason the comment on the field gives; plugins join
     them because most deployments have none and a list of none is not worth a
     request on every page load. */
  private async loadShelves() {
    if (this.allSkills.length === 0) {
      this.allSkills = await listSkills().catch(() => []);
    }
    if (this.plugins.length === 0) {
      this.plugins = await listPlugins().catch(() => []);
      const owner = new Map<string, string>();
      for (const p of this.plugins) {
        const items = await pluginItems(p.id).catch(() => []);
        for (const it of items) { owner.set(it.itemId, p.pluginName); }
      }
      this.pluginOf = owner;
    }
  }

  private shelfRows(shelf: Shelf): GalleryRow[] {
    if (shelf === "skills") {
      return this.allSkills.map((s) => ({
        key: s.skillName, name: s.skillName, why: s.description,
        on: this.pinned === s.skillName, icon: capIcon(s.skillName),
        source: s.source, id: s.id, from: this.provenance(s.id, s.source, s.sourceUrl),
      }));
    }
    if (shelf === "agents") {
      // Choosing one is choosing who answers, which is the same act the slash
      // menu performs — so it goes through the same field rather than a second
      // way of saying it.
      return this.agents.map((a) => ({
        key: a.id, name: a.agentName, why: a.description,
        on: this.agentId === a.id, icon: "message-square",
        source: "local", id: a.id,
        from: a.isDefault ? "Answers by default" : "",
      }));
    }
    if (shelf === "connectors") {
      return this.servers.map((s) => ({
        key: s.id, name: s.serverName === "" ? s.id : s.serverName,
        why: s.enabled ? s.endpoint : "Disabled · " + s.endpoint,
        on: false, icon: serverIcon(s), source: "local", id: s.id,
        from: this.provenance(s.id, "local", ""),
      }));
    }
    return this.plugins.map((p) => ({
      key: p.id, name: p.pluginName, why: p.description, on: false,
      icon: "cube", source: "repo", id: p.id,
      from: p.version === "" ? "Installed" : "Installed · v" + p.version,
    }));
  }

  /* The line under a card's name. A plugin's receipt wins over the row's own
     source, because "From the web-search plugin" is the answer to both "can I
     edit this" and "what happens if I remove that", and "From
     raw.githubusercontent.com" answers neither well. */
  private provenance(id: string, source: string, sourceUrl: string): string {
    const bundle = this.pluginOf.get(id);
    if (bundle !== undefined) { return "From the " + bundle + " plugin"; }
    if (source !== "repo") { return "From you"; }
    if (sourceUrl === "") { return "From a repository"; }
    try { return "From " + new URL(sourceUrl).hostname; }
    catch { return "From a repository"; }
  }

  private pickerPanel() {
    if (this.gallery === "") return nothing;
    const shelf = this.gallery;
    const rows = this.shelfRows(shelf);
    // Filtered on both halves, because half of what you remember about a skill
    // is what it does rather than what it is called — "spreadsheet" should
    // find make-sheet. Case-folded on one side only would fail every capital.
    const find = this.galleryFind.trim().toLowerCase();
    const shown = find === ""
      ? rows
      : rows.filter((r) => (r.name + " " + r.why).toLowerCase().includes(find));
    const lede = shelf === "skills"
      ? "Instructions the agent can follow. Pick one to pin it to this conversation."
      : shelf === "agents"
        ? "Who answers. Picking one changes who this conversation is with."
        : shelf === "connectors"
          ? "Services this deployment can call. Attach one to an agent in Settings."
          : "Bundles installed from a manifest, each carrying its own skills and connectors.";
    const empty = shelf === "skills"
      ? "This deployment has no skills yet."
      : shelf === "agents"
        ? "No agents are enabled."
        : shelf === "connectors"
          ? "No connectors are configured."
          : "No plugins are installed.";
    const one = shelf === "skills" ? "skill" : shelf === "agents" ? "agent"
      : shelf === "connectors" ? "connector" : "plugin";
    return html`
      <div class="scrim shelves" @click=${() => { this.gallery = ""; }}></div>
      <div class="gallery" role="dialog" aria-label="Directory">
        <div class="gallery-head">
          <!-- Tabs, not a title. The heading is the thing you are looking at,
               and with four shelves the heading has to be pressable or the
               only way between them is closing this and reopening it from a
               menu two levels down. -->
          <div class="gallery-tabs" role="tablist">
            ${(["skills", "agents", "connectors", "plugins"] as const).map((t) => html`
              <button class=${t === shelf ? "gallery-tab on" : "gallery-tab"}
                role="tab" aria-selected=${t === shelf ? "true" : "false"}
                @click=${() => { this.galleryFind = ""; this.gallery = t; }}>
                ${t === "skills" ? "Skills" : t === "agents" ? "Agents"
                  : t === "connectors" ? "Connectors" : "Plugins"}
                <span class="gallery-count">${this.shelfRows(t).length}</span>
              </button>`)}
          </div>
          <button class="icon" title="Close" @click=${() => { this.gallery = ""; }}>
            <nr-icon name="x" size="medium"></nr-icon>
          </button>
        </div>
        <p class="gallery-lede">${lede}</p>
        <!-- A filter, because fourteen is past the number you can find one in
             by reading. Kimi and Claude both put one above a list this long.
             Hidden under five rows, where it would be furniture. -->
        ${rows.length < 5 ? nothing : html`
          <div class="gallery-find">
            <nr-icon name="search" size="small"></nr-icon>
            <input type="text" .value=${this.galleryFind}
              placeholder=${"Find a " + one}
              aria-label=${"Find a " + one}
              @input=${(e: Event) => {
                this.galleryFind = (e.target as HTMLInputElement).value; }}>
          </div>`}
        ${rows.length === 0
          ? html`<p class="gallery-none">${empty}</p>`
          : shown.length === 0
            ? html`<p class="gallery-none">Nothing matches
                “${this.galleryFind.trim()}”.</p>`
            : html`${this.galleryGroups(shown, shelf)}`}
      </div>`;
  }

  /* Yours, then everybody else's.
     The split is the point of the heading, not decoration: a skill this
     deployment wrote is one you can change, and a skill a repository or a
     plugin owns is one you cannot — the engine refuses the write. Showing them
     in one undifferentiated grid meant the only way to find out which kind you
     were looking at was to try to edit it. A section that has nothing in it is
     not drawn, so a deployment with no repository skills sees no headings at
     all and the grid looks exactly as it did. */
  private galleryGroups(rows: GalleryRow[], shelf: Shelf) {
    const skills = shelf === "skills";
    if (!skills) return this.galleryGrid(rows, shelf);
    const mine = rows.filter((r) => r.source !== "repo");
    const theirs = rows.filter((r) => r.source === "repo");
    if (theirs.length === 0) return this.galleryGrid(mine, shelf);
    if (mine.length === 0) return this.galleryGrid(theirs, shelf);
    return html`
      <div class="gallery-scroll">
        <div class="gallery-group">Yours
          <span class="gallery-count">${mine.length}</span></div>
        ${this.galleryGrid(mine, shelf, false)}
        <div class="gallery-group">Installed and synced
          <span class="gallery-count">${theirs.length}</span></div>
        ${this.galleryGrid(theirs, shelf, false)}
      </div>`;
  }

  /* A card is pressable only where pressing it means something. A skill pins,
     an agent becomes the one you are talking to — both are choices this
     surface can make. A connector is attached to an agent in Settings and a
     plugin is installed there, so their cards are disabled rather than absent:
     the list is the answer to "what can this reach", and hiding it to avoid a
     dead press would be answering a different question. */
  private galleryGrid(rows: GalleryRow[], shelf: Shelf, scrolls = true) {
    const choosable = shelf === "skills" || shelf === "agents";
    return html`<div class=${scrolls ? "gallery-list" : "gallery-list flat"}>
              ${rows.map((r) => html`
                <button class=${r.on ? "pick on" : "pick"}
                  ?disabled=${!choosable} title=${r.why}
                  @click=${() => {
                    if (shelf === "skills") { void this.pin(r.key); this.gallery = ""; }
                    else if (shelf === "agents") { this.agentId = r.key; this.gallery = ""; }
                  }}>
                  <span class="pick-top">
                    <span class="pick-tile"><nr-icon name=${r.icon}
                      size="small"></nr-icon></span>
                    <span class="pick-name">${r.name}</span>
                  </span>
                  <!-- Provenance under the name, above the description, which
                       is where Kimi puts "From Kimi". It reads as a byline
                       there rather than as another line of prose. -->
                  ${r.from === "" ? nothing : html`<span class="pick-from">${r.from}</span>`}
                  ${r.why === "" ? nothing : html`<span class="pick-why">${r.why}</span>`}
                  <!-- The way out of read-only, on the card that is read-only
                       rather than in a menu somewhere else. A nested button
                       inside a button is invalid, so the card is the parent of
                       a click this one stops: without stopPropagation, copying
                       would also pin the original and close the gallery, which
                       is two things nobody asked for. -->
                  ${shelf !== "agents" ? nothing : html`
                    <span class="pick-act"
                      role="button" tabindex="0"
                      title="See this agent's sub-agents, connectors and tools"
                      @click=${(e: Event) => { e.stopPropagation();
                        this.canvasFocus = r.key; this.gallery = "";
                        this.view = "canvas"; }}
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault(); e.stopPropagation();
                        this.canvasFocus = r.key; this.gallery = "";
                        this.view = "canvas"; }}>View graph</span>`}
                  ${r.source !== "repo" ? nothing : html`
                    <span class="pick-act"
                      role="button" tabindex="0"
                      title="Make your own editable copy"
                      @click=${(e: Event) => { e.stopPropagation();
                        void this.copyToLocal(r.id); }}
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault(); e.stopPropagation();
                        void this.copyToLocal(r.id); }}>Copy to local</span>`}
                </button>`)}
            </div>`;
  }

  /* Take a copy of somebody else's skill, and show the result rather than
     announcing it: the gallery reloads and the copy is in the Yours section,
     which is the answer to "did that work" without a toast to dismiss. The
     filter is cleared for the same reason — a copy that lands outside the
     current filter would look like nothing happened. */
  private async copyToLocal(id: string): Promise<void> {
    const made = await copySkillLocally(id).catch(() => null);
    if (made === null) return;
    this.allSkills = await listSkills().catch(() => this.allSkills);
    this.galleryFind = "";
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
        <!-- The way out. This view replaces the whole conversation column, so
             without it the only route back is the browser's Back — which the
             console does not put this view into (openStarts pushes no history
             entry), so on a phone with no visible Back there was none at all.
             Its own control rather than a header change: the header belongs to
             the chat view and is not rendered here. -->
        <button class="starts-back" @click=${() => { this.view = "chat"; }}>
          <nr-icon name="chevron-left" size="small"></nr-icon>Back
        </button>
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
    // Only a skill that MAKES something has starting points, and only that
    // skill's own kind. capKind answers "" for anything not in CAPS — every
    // skill past the four the chips draw — and templatesOfKind("") is not
    // "no templates" but "no filter", so it answers with all of them. Pinning
    // search-web put a budget spreadsheet and a landing page under the
    // composer: templates for a skill that writes nothing, offered because a
    // missing kind read as a wildcard.
    const kind = capKind(skillName);
    this.starts = kind === ""
      ? []
      : await templatesOfKind(kind).catch(() => []);
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
    // Every card at once, not one after another. The engine's conversion is
    // cached and the client keeps painted canvases, but this loop used to
    // await each card's fetch AND its pdf.js render before starting the
    // next — so a row of four cached thumbnails still popped in one by one,
    // each a round-trip plus a render late. Concurrent, the row fills in the
    // time the slowest single card takes. Each card still lands on its own
    // the moment it is ready; nothing waits for the whole set.
    await Promise.all(this.starts.map(async (t) => {
      const port = () => this.renderRoot.querySelector(`.start-thumb[data-tpl="${t.id}"]`);
      const held = this.thumbs.get(t.id);
      if (held !== undefined) { port()?.replaceChildren(held); return; }
      try {
        // A site template has no document to convert — the office path runs
        // LibreOffice, which does not take HTML — so its own first page is
        // rendered instead, in a sandboxed iframe scaled down to the card.
        // That is a real preview rather than an approximation of one: it is
        // the page, laid out by the same engine that will lay it out later.
        if (t.kind === "site") {
          const frame = await this.siteThumb(t.id);
          if (frame === null) { return; }
          this.thumbs.set(t.id, frame);
          port()?.replaceChildren(frame);
          return;
        }
        const { pdf } = await templatePdf(t.id);
        const { renderPdfThumb } = await import("./office-view.js");
        const canvas = await renderPdfThumb(pdf, 208);
        if (canvas === null) { return; }
        this.thumbs.set(t.id, canvas);
        port()?.replaceChildren(canvas);
      } catch {
        // No thumbnail is a fine card; see the stylesheet note.
      }
    }));
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
      <!-- The account menu raises two different things and the rail knows the
           difference: "Preferences" is this event, a person's own panel, and
           "Deployment settings" navigates to /admin from the rail itself. It
           was briefly one event doing the second job, which is why pressing
           Preferences opened the operator's page.

           And this comment lives HERE, above the tag, because a comment among
           the attributes is not a comment: lit parses the template as HTML, an
           HTML comment cannot open inside a start tag, and every binding after
           it silently stops being an attribute. That is what "left menu link
           stop working" was — one comment, six dead event handlers. -->
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
        @open-agents=${() => { void this.openShelf("agents"); }}
        @open-connectors=${() => { void this.openShelf("connectors"); }}
      ></console-sidebar>

      <div class="center">
        ${this.view === "knowledge" ? html`<knowledge-page></knowledge-page>`
          : this.view === "canvas" ? html`<agent-canvas .focusAgent=${this.canvasFocus}></agent-canvas>`
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
            @nr-dropdown-item-click=${(e: Event) => { void this.onAttachPick(e); }}
            @input=${() => { this.onComposerInput(); }}
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
        ${this.session.getState().messages.length > 0 ? "" : html`
          <!-- Points at the starting-points page, not at the .starts row under
               the composer. That row is only populated once a capability is
               pinned, so a bar hung off it is absent on the one screen it
               exists for — the empty home nobody has touched yet. The page
               behind openStarts() is filled from replayableThreads() on the
               way in and is the thing a person is actually being offered. -->
          <button class="explore" @click=${() => { void this.openStarts(); }}>
            <span class="label"><nr-icon name="star" size="small"></nr-icon>Starting
              points</span>
            <span class="hint">Explore<nr-icon name="chevron-right"
              size="small"></nr-icon></span>
          </button>`}
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
      ${this.slashMenu()}
      ${this.pickerPanel()}
      <!-- Two surfaces, split by whose setting it is. Settings is the user
           zone of the tabbed element — Preferences (theme, account) first,
           then what people author: agents, prompts, skills, templates,
           connectors, plugins. The admin zone of the same element is not
           here at all; it is /admin, its own route, behind the gateway's
           check. There was briefly a third, separate Preferences panel;
           merged, because two gears beside each other in one menu is a
           choice nobody should have to make. -->
      ${this.settings ? html`<console-settings .me=${this.me} @close=${() => {
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

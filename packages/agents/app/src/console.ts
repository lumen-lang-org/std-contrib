// The shell: sidebar | header + chat | workspace. Each region is its own
// element in its own file; this one only wires them together. The chat area
// is LumenUI's <nr-chatbot>, driven through its properties and events —
// nothing here reaches into it.

import { LitElement, css, html, nothing } from "lit";
import { BRAND, WORDMARK } from "./brand.js";
import { customElement, property, state } from "lit/decorators.js";
import "./ui.js";
import "./search-dash.js";
import "./sidebar.js";
import "./artifact-panel.js";
import "./library.js";
import "./discover.js";
import "./discover-article.js";
import { loadPluginRenderers } from "./plugin-cards.js";
import "./knowledge.js";
import "./canvas.js";
import "./login-overlay.js";
import "./model-picker.js";
import "./settings.js";
import "./tasks.js";
import {
  AgentFull, ArtifactListing, Me, ModelChoice, ModelRow, ThreadListing, TurnArtifactRef, WireRef,
  QUOTA_SPENT, SIGNED_OUT, SkillRow, TemplateRow, artifactsByTurn, featuredSkills, getQuota, listAgents, listArtifacts,
  listModels, listThreads, modelChoices, previewUrl, listTemplateFiles, offerThread, remixThread, replayableThreads, startFromTemplate, transcript, templatePdf, templatesOfKind, whoami,
  ServerRow, listServers, listSkills, copySkillLocally, createServer, updateServer, serverTools, setServerTool,
  ConnectionRow, listConnections,
  PluginRow, listPlugins, CardPluginRow, listCardPlugins, pluginItems, SkillFileRow, listSkillFiles, readBanner, isAdmin } from "./api.js";
import "./mcp-gallery.js";
import { CATALOGUE, brandMark } from "./mcp-gallery.js";
import type { CatalogueEntry, EntryStatus } from "./mcp-gallery.js";
import { connectEntry, connectServer } from "./connect-flow.js";
import { ChatSession, rememberFold } from "./chat-session.js";
import * as live from "./live.js";


/* The conversation the address names, or "". One function, because the shape
   of the URL is the sort of thing that otherwise gets half-changed: this used
   to be `?c=<id>` on the root, and only moved to a path once the gateway had
   a location for it (locations/agents.conf). */
function currentId(): string {
  const m = /^\/c\/([^/?#]+)/.exec(location.pathname);
  return m === null ? "" : decodeURIComponent(m[1]);
}

/** Which article the address names, "" for every other address. The feed's
 *  own `/discover` answers "" too — it is the feed, not an article. */
function currentArticle(): string {
  const m = /^\/discover\/([^/?#]+)/.exec(location.pathname);
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
  // The same skill the composer's globe toggles. Two doors, one pin, one
  // piece of state — the chip and the globe light together. kind "" means no
  // Start-from row: research starts from a question, and the composer is
  // right there.
  "search-web": { label: "Research", icon: "search", kind: "" },
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
  /* The answer is set in the interface face, like everything else.
     It was a serif reading stack for a while — Perplexity's move, an answer
     that reads like an article. Reverted: this console is a working surface
     more than a reading one, and the serif made a two-line correction or a
     tool result look like an essay about itself. A long researched answer
     was the case it flattered, and that is the minority of what is asked
     here. Size and leading stay generous; only the face goes back. */
  .message.bot .message__content {
    font-size: 15.5px;
    line-height: 1.6;
  }
  /* The working parts inside an answer stay instrumental: step cards, code,
     file chips are telemetry, not prose. */
  .message.bot .message__content pre,
  .message.bot .message__content code,
  .message.bot .message__content .tool-call,
  .message.bot .message__content details { font-family: var(--mono, ui-monospace, monospace); }
  .message.bot .message__content .tool-call * { font-family: inherit; }
  @media (max-width: 640px) {
    .message.bot .message__content { font-size: 16.5px; }
  }

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

/* Retry, quietly.
 *
 * The library draws type="secondary" as a filled near-black — its own
 * definition, not a token this console sets — so the one control on a FAILED
 * turn was the heaviest mark on the screen, louder than any answer above it.
 * A retry is a recovery, not a call to action: it belongs in the same outline
 * register as the composer's own controls, and the failure line beside it is
 * what should carry the weight.
 *
 * Adopted into the nr-button's own shadow root because the colours live on
 * its inner button element: a part exposes the host, and the host is not
 * where the background is. Same mechanism as CHAT_BUTTON above, on the
 * elements that carry the retry class. */
const RETRY_BUTTON = `
  button { background: transparent !important;
           border: 1px solid var(--border, rgba(0,0,0,.14)) !important;
           color: var(--muted, rgba(0,0,0,.55)) !important;
           font-weight: 500 !important; border-radius: 999px !important; }
  button:hover:not(:disabled) { background: var(--bg-sunken, rgba(0,0,0,.045)) !important;
           border-color: var(--muted, rgba(0,0,0,.35)) !important;
           color: var(--fg, rgba(0,0,0,.9)) !important; }
`;

/* Dress the chat component and only the chat component. Same `dressed` latch
   as softenFocusRings, under a second flag so the two passes do not cancel
   each other out on a root that both visit. */
/* Completions, drawn inside the composer's own box.
 *
 * One card that grows: the field, a hairline the width of the box, then the
 * rows. No border of their own and no radius — the container already has
 * both, and a second outline is what made every earlier attempt read as two
 * boxes stacked. The negative margins undo the container's own padding so the
 * hairline and the row highlight run edge to edge, the way a divider inside a
 * card does. */
const CHAT_HINTS = `
  .joule-hints {
    display: flex; flex-direction: column;
    /* The container's padding is 6px 8px 6px 20px — NOT symmetric. Undoing it
       with -20px on both sides pushed the rows twelve pixels past the right
       border, so the hover highlight ran outside the card's own outline and
       the box looked like it had a seam down one side. Each side undoes the
       padding it actually has. */
    margin: 6px -8px -6px -20px;
    border-top: 1px solid var(--nuraly-border-color, rgba(128,128,128,.22));
    /* Bottom padding, because the negative margin above takes the card's own
       away: without it the last row's text sits on the border it is inside. */
    padding: 6px 0 10px;
    max-height: 46vh; overflow-y: auto; overscroll-behavior: contain;
  }
  .joule-hint {
    display: flex; align-items: center; gap: 12px; width: 100%;
    text-align: left; padding: 9px 20px; border: 0; background: none;
    font: inherit; font-size: 14.5px; color: inherit; cursor: pointer;
  }
  .joule-hint:hover, .joule-hint.on { background: rgba(128,128,128,.10); }
  /* The last row carries the card's own corner, so a highlight on it cannot
     square off the rounded bottom it sits in. */
  .joule-hint:last-child { border-radius: 0 0 22px 22px; }
  .joule-hint-mark { flex: none; opacity: .45; font-size: 15px; }
  .joule-hint-text {
    flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .joule-hint-had { opacity: .55; }
  .joule-hint-text b { font-weight: 600; }
`;

/* Remember which folds the reader opened, from INSIDE the transcript's root.
 *
 * `toggle` is not composed. A non-composed event does not leave the shadow
 * root it fired in at all — not in the bubble phase, and not in the capture
 * phase either, because the path stops at the boundary. So a listener on the
 * console host hears nothing however early it runs, which is what the first
 * version of this did: it was registered in capture on the host, looked
 * correct, and never fired once. The card came back shut from every rebuild
 * and the measurement said so.
 *
 * Registered on the ROOT and not on the folds, because the folds are markup
 * that is destroyed and rebuilt on every streamed chunk — a listener attached
 * to one would go with it. The root outlives them.
 *
 * Once per root, flagged on the root itself: dressChat runs on every render. */
/* Follow the newest message only while the reader is at the newest message.
 *
 * nr-chatbot scrolls to the bottom whenever `messages` changes, and during a
 * streamed answer that is every chunk. Its own guard against fighting the
 * reader only cancels the re-pinning it does while content settles; the jump
 * itself is unconditional. So a reader who scrolled up to re-read something
 * was hauled back to the live edge several times a second, and scrolling up
 * during a reply was effectively impossible.
 *
 * Fixed from HERE rather than in the component. The component already offers
 * the seam — `autoScroll` is a declared property — so the policy belongs to
 * the app that has an opinion about it, and the component keeps doing the one
 * thing it is good at: holding the bottom while markdown, fonts and images
 * land late. Patching its internals would fork a dependency this console
 * shares, for a decision that is this console's to make.
 *
 * 80px of slack, the same threshold the component uses, so a reader resting
 * just short of the end is still followed; further up is a deliberate move
 * away from the live edge and is left alone.
 *
 * Once per root: the scroller outlives every message in it. */
function followTheEnd(chat: Element & { autoScroll?: boolean }) {
  const root = chat.shadowRoot as (ShadowRoot & { following?: boolean }) | null;
  if (root === null || root.following === true) { return; }
  const list = root.querySelector(".messages");
  if (list === null) { return; }
  root.following = true;
  const atEnd = () => list.scrollHeight - list.clientHeight - list.scrollTop < 80;
  list.addEventListener("scroll", () => { chat.autoScroll = atEnd(); }, { passive: true });
}

function rememberFolds(root: ShadowRoot & { folded?: boolean }) {
  if (root.folded === true) { return; }
  root.folded = true;
  root.addEventListener("toggle", (e: Event) => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement)) { return; }
    const key = el.getAttribute("data-fold");
    // Folds this console did not write are left alone — a plugin card's own,
    // say. Nothing here should be deciding for markup it does not own.
    if (key === null || key === "") { return; }
    rememberFold(key, el.open);
  }, true);
}

function dressChat(root: ParentNode) {
  // As Element: the generated type for <nr-chatbot> does not declare
  // shadowRoot, though every element has one open here.
  const chat = root.querySelector("nr-chatbot") as Element | null;
  if (chat === null || chat.shadowRoot === null) { return; }
  rememberFolds(chat.shadowRoot);
  followTheEnd(chat as Element & { autoScroll?: boolean });
  adopt(chat.shadowRoot, CHAT_SKIN, "skinned");
  adopt(chat.shadowRoot, CHAT_SOURCES, "sourced");
  // The completion rows live INSIDE this root — see drawHints — so their
  // rules have to be handed to it. A stylesheet in the console cannot reach
  // across a shadow boundary; custom properties can, which is what keeps the
  // colours on the console's palette rather than introducing a second one.
  adopt(chat.shadowRoot, CHAT_HINTS, "hinted");
  for (const el of chat.shadowRoot.querySelectorAll("nr-button")) {
    if (el.shadowRoot === null) { continue; }
    // The retry gets its own quieter sheet; every other button in here keeps
    // the transcript skin. Two flags, so a root that takes one is still
    // eligible for the other.
    if (el.classList.contains("message__retry")) { adopt(el.shadowRoot, RETRY_BUTTON, "retried"); }
    else { adopt(el.shadowRoot, CHAT_BUTTON, "skinned"); }
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
/* A host worth citing: a real domain, not a machine on somebody's network.
   Anything with no dot is a bare hostname; a final label of digits is an IP;
   localhost and .local are the same story with friendlier spelling. */
const PUBLIC_HOST = /^(?!localhost$)(?!.*\.local$)(?!.*\.internal$)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

function citeSources(root: ShadowRoot) {
  for (const msg of root.querySelectorAll(".message.bot .message__content")) {
    const holder = msg as HTMLElement & { cited?: boolean };
    if (holder.cited === true) { continue; }
    // Never a failed turn. A failure line is not an answer, so nothing in it
    // is a source — and the address in one is the deployment's own, which is
    // exactly what should not become a link a reader can press or a chip a
    // screenshot can carry.
    if (msg.closest(".message.error, .message--error") !== null) { continue; }
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
      // Public names only. A bare IP, a localhost, a .local or a private
      // range is somewhere inside this deployment: it cannot be a citation
      // for anybody reading, and a chip for one publishes an address that was
      // never meant to leave the machine.
      if (!PUBLIC_HOST.test(host)) { continue; }
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

/* Agents a person may be handed, out of every agent the deployment has.

   The engine's list is the operator's whole bench, fixtures included: the
   scripted model double the e2e suite talks to, its sub-agent, the eval
   judge, and a link agent per test run that nothing cleans up. Eleven of the
   eighteen rows on joule.sh were those, and the composer offered them by
   name — a visitor was invited to "Ask e2e-doubled…", and a conversation
   that landed on one would be answered by a stub.

   The convention is the filter: a fixture is named e2e-*, which the specs
   that create them already follow, and the two long-lived ones say so in
   their own descriptions. Naming rather than a new column because this is a
   question about who may be OFFERED one, which is a console question — the
   API still serves them, /admin still lists them, and a test that names an
   agent directly is unaffected. */
function offerable(a: { agentName?: string }): boolean {
  return !(a.agentName ?? "").startsWith("e2e-");
}

/** The deployment area's tabs, as links.
 *
 *  One row per nested route under /admin, in the order and grouping
 *  src/settings.ts's TABS uses — the rail inside the page and this menu are
 *  two views of one list, and a person who learns the order in one should not
 *  have to learn it again in the other.
 *
 *  Deliberately a SECOND copy rather than an import of TABS: settings.ts pulls
 *  in the whole settings implementation, and the header of every conversation
 *  would then pay for a module nobody on this screen has opened. It is nine
 *  strings; the cost of them drifting is a menu row that lands on the wrong
 *  tab, which the e2e below catches. Importing the tab list here would cost
 *  the console's first paint, which nothing catches.
 *
 *  `head` rows are headings and carry no link. */
type AdminLink = { head?: string; label?: string; href?: string; icon?: string };

const ADMIN_LINKS: AdminLink[] = [
  { head: "Models" },
  { label: "Models", href: "/admin/models", icon: "zap" },
  { label: "Model menu", href: "/admin/model-menu", icon: "list" },
  { label: "Providers", href: "/admin/providers", icon: "cloud" },
  { head: "Capabilities" },
  { label: "MCP", href: "/admin/mcp", icon: "code" },
  { label: "Images", href: "/admin/images", icon: "box" },
  { label: "Search", href: "/admin/search", icon: "search" },
  { head: "Access" },
  { label: "Sign-in", href: "/admin/sign-in", icon: "log-in" },
  { head: "Operations" },
  { label: "Tracing", href: "/admin/tracing", icon: "layers" },
  { label: "Banner", href: "/admin/banner", icon: "bell" },
];

@customElement("agent-console")
export class AgentConsole extends LitElement {
  static styles = css`
    /* The composer's tokens are in head.html on :root, not here. nr-chatbot
       is not a child of this shadow root, so a rule for the tag matches
       nothing — silently — and even :host did not carry them down in
       practice. head.html is where the palette already lives. */
    /* The ground the sheet floats on, and the rail sits on the same one.
     *
     * Without this the inset around the centre column showed the page's white
     * through it, so the sheet had a rounded corner and nothing to be rounded
     * AGAINST — the frame read as a gap rather than as ground. The rail
     * already paints --bg-rail; giving the host the same value makes the two
     * continuous, and the white sheet is then the only raised surface. */
    :host { display: flex; height: 100%; background: var(--bg-rail); }
    console-sidebar { width: 264px; flex: none; }
    /* Hidden by the header's toggle on a wide screen. Removed from the
       layout rather than narrowed to zero: the rail is a flex item with padding and
       borders, and a zero-width one still paints a hairline where the column
       used to be. */
    :host(:not([railed])) console-sidebar { display: none; }
    /* The rail, floated back for as long as the pointer is on it. A sheet
       with a shadow rather than the column it usually is, because it is over
       the page now and has to read as being over it. */
    /* The rail, floated back for as long as the pointer is on it. A sheet
       with a shadow rather than the column it usually is, because it is over
       the page now and has to read as being over it. */
    :host(:not([railed])[railpeek]) console-sidebar {
      display: flex; position: fixed; inset: 8px auto 8px 8px; z-index: 46;
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 0 32px -8px rgba(0,0,0,.32);
    }

    /* Floating over the column rather than in it, so no screen has to make
       room for a control that is usually absent. */
    .unrail { position: fixed; top: 14px; left: 14px; z-index: 40;
              width: 32px; height: 32px; border-radius: 9px;
              display: grid; place-items: center; cursor: pointer;
              border: 1px solid var(--border); background: var(--bg);
              color: var(--muted);
              transition: color .15s cubic-bezier(.23,1,.32,1),
                          border-color .15s cubic-bezier(.23,1,.32,1); }
    .unrail:hover { color: var(--fg); border-color: var(--muted); }

    /* --- motion -----------------------------------------------------------
       One curve and three durations for the whole console, so surfaces that
       do the same thing move the same way.

       The curve is cubic-bezier(.23,1,.32,1) — an ease-out that leaves fast
       and settles slowly. It was already on the hovers and on the drawer
       before any of this; the keyframes below adopt it rather than inventing
       a second feel. Nothing eases IN: a panel a person just asked for should
       be most of the way there before they can notice it starting.

       The durations are short on purpose. A menu is a response to a click and
       has to feel like one, so it is .13s; a sheet that covers the page can
       afford .2s because it is a bigger change and reads as such. Anything
       past a quarter second stops being feedback and becomes a wait.

       Only entrances are animated, and that is a limit of how these surfaces
       are built rather than a preference: each one is rendered conditionally,
       so on close the element is gone from the tree before a leaving
       animation could run. Faking it would mean keeping dead nodes around and
       timing their removal, which is a bug factory in exchange for 120ms
       nobody is looking at — a dismissal is meant to feel instant.

       Everything here is opacity and transform only. Both are composited, so
       a phone animates them without laying the page out again; animating
       height or top on the same surfaces would drop frames on exactly the
       hardware where it shows most. */
    @keyframes veil-in { from { opacity: 0; } }
    /* A menu, growing from the control that opened it. The scale is small
       enough to read as arrival rather than as zoom. */
    @keyframes pop-in {
      from { opacity: 0; transform: translateY(-4px) scale(.97); }
    }
    /* A sheet, rising. Further and slower than a menu because it covers. */
    @keyframes sheet-in {
      from { opacity: 0; transform: translate(-50%, 10px) scale(.985); }
    }
    /* Same rise for a sheet that is not centred, so it does not need the
       -50% the gallery's own positioning carries. */
    @keyframes rise-in {
      from { opacity: 0; transform: translateY(10px) scale(.99); }
    }
    /* A count that has just changed. It draws the eye once, at the moment the
       number is new, and then stops — which is the whole job of a badge. */
    @keyframes badge-in {
      from { opacity: 0; transform: scale(.4); }
      60% { transform: scale(1.12); }
    }

    /* Reduced motion is honoured by removing the movement, not the surface.
       Every rule above animates from a transformed, transparent state, so
       switching them off must land the element at its resting position — and
       animation: none does exactly that, because the resting state IS the
       CSS. Transitions are not removed either, only collapsed to 1ms, so a
       hover still answers instantly rather than not at all. */
    @media (prefers-reduced-motion: reduce) {
      .scrim.shelves, .gallery, .hmenu, .fly, .attach, .explore,
      artifact-panel, .icon .badge {
        animation: none !important;
      }
      * { transition-duration: .01ms !important; }
    }
    /* The scrim behind a layer that covers. Two of them — the nav drawer and
       the files sheet — and each is what dismisses its own layer: a tap
       anywhere else. Hidden above the breakpoint, where neither layer covers
       anything and a dimmed page would be dimming nothing. */
    /* touch-action: none, so a drag that begins on the dimmed area is not a
       scroll of the page under it. The scrim's job is to swallow what is
       behind it, and on a touch screen a gesture is as much "behind it" as a
       click is. */
    /* The scrim behind a panel. Dimmed AND blurred, not only dimmed.
       A flat 28% wash left every row of the page behind it perfectly legible,
       so a panel over the Knowledge screen read as two screens fighting for
       the same space rather than as one thing on top of another. The blur is
       what says "this is behind" — the dimming alone only says "this is
       darker". The webkit-prefixed copy comes first, for Safari. */
    .scrim { display: none; background: rgba(0,0,0,.28);
             -webkit-backdrop-filter: blur(10px) saturate(.9);
             backdrop-filter: blur(10px) saturate(.9);
             overscroll-behavior: contain; touch-action: none; }
    /* The conversation column, as a sheet floating on the ground.
     *
     * The macOS reading: the window's ground shows at the edges, the content
     * sits on a rounded card above it, and the separation is the inset and
     * the corner rather than a line. That is why the rail keeps its own
     * background here and this element takes the sheet colour — the border
     * between the two columns stops being the thing doing the work.
     *
     * The radius is on the card, so the header's sticky band and the
     * transcript both have to be clipped to it: without overflow:hidden the
     * header's own background paints square over the top corners the moment
     * it sticks, which is the one frame where the rounding matters. */
    .center { flex: 1; display: flex; flex-direction: column; min-width: 0;
              position: relative;
              margin: 8px 8px 8px 0; border-radius: 14px;
              background: var(--bg-chat);
              border: 1px solid var(--border);
              overflow: hidden; }
    /* No inset on a phone: the rail is a drawer there, so the column IS the
       window and an 8px frame around it is a border for its own sake. */
    @media (max-width: 640px) {
      .center { margin: 0; border-radius: 0; border: 0; }
    }
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
             /* The chat side sits on its own paper, a shade off the rail's
                white, so the two columns read as two surfaces rather than one
                sheet with a line drawn on it. Header and main carry the same
                value: the header is sticky, so a different one would show as
                a band sliding over the transcript. */
             background: var(--bg-chat);
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
             white-space: nowrap; min-width: 0; }
    .bar-space { flex: 1; }
    /* The announcement, and the empty box that holds it.
       It used to be a strip in the flow above the header, which cost the page
       its top 53px on a phone: the header — drawer toggle, sign in — started
       below the fold of its own bar, and the centred wordmark and composer
       were pushed down with it. An announcement is the least important thing
       on the screen and it was displacing the most important.
       So the strip floats instead. .notice-slot is a zero-height box placed
       AFTER the header, which is what makes this need no magic number: the
       slot lands exactly at the header's bottom edge, and the card inside it
       is absolute, so it takes no column height at all. Header stays at y=0,
       the hero centres in the whole page, and the card hangs over the top of
       the content — never over the composer, which is the one thing a banner
       must not cover. Under the drawer scrim (39) so an open drawer dims it. */
    .notice-slot { position: relative; height: 0; z-index: 38; }
    .notice { position: absolute; top: 8px; left: 12px; right: 12px;
              display: flex; align-items: center; gap: 10px;
              padding: 8px 12px; font-size: 13px; line-height: 1.4;
              border-radius: 12px; background: var(--bg-card);
              border: 1px solid var(--border);
              box-shadow: 0 8px 24px -10px rgba(0,0,0,.28); }
    .notice span { flex: 1; min-width: 0; }

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
            transition: background-color .15s cubic-bezier(.23,1,.32,1),
                        transform .12s cubic-bezier(.23,1,.32,1); }
    .icon:hover { background: var(--bg-sunken); }
    /* A press that is felt, not only seen. Every one of these buttons opens
       something that takes a moment to arrive, and without this the click
       lands in silence — the first thing that moves is the panel. .93 is the
       smallest scale that still reads on a 34px target; larger buttons need
       less, not more. Transitioned in both directions, so a press that is
       dragged off the button returns rather than snapping. */
    .icon:active { transform: scale(.93); }
    .icon[aria-pressed="true"] { background: var(--bg-sunken); }
    /* How many files this conversation has made, on the folder that opens
       them. Without it the rail is a door with nothing written on it: a
       conversation that produced five documents and one that produced none
       look identical, so the panel is opened to find out — or, more often,
       never opened at all and the documents are never seen.
       Counted, not a dot: "there is something in here" is half the answer,
       and the number costs the same pixels. Two digits fit; past that it
       says 99+, because a badge that keeps growing moves the header around
       it.
       The button is the positioning context, so the badge is placed against
       the glyph rather than against the header. */
    .icon.count { position: relative; }
    .icon .badge { position: absolute; top: 2px; right: 1px; min-width: 15px;
                   height: 15px; padding: 0 4px; box-sizing: border-box;
                   border-radius: 999px; background: var(--accent);
                   color: var(--accent-fg); font: 600 10px/15px var(--display);
                   letter-spacing: 0; text-align: center;
                   font-variant-numeric: tabular-nums;
                   border: 1.5px solid var(--bg); pointer-events: none;
                   /* Overshoots slightly and settles. The badge appears the
                      moment a conversation writes its first file, which is
                      exactly when it should be noticed once — a count that
                      simply blinks into existence is missed. */
                   animation: badge-in .22s cubic-bezier(.23,1,.32,1); }
    /* The header's own little menu — the artifact panel's kebab, one floor
       up. Anchored to the header (sticky is positioned, so absolute children
       measure against it); the scrim is what makes a click anywhere else a
       close instead of a click-through. */
    .hmenu-scrim { position: fixed; inset: 0; z-index: 44; }
    .hmenu { position: absolute; right: 14px; top: calc(100% - 4px); z-index: 45;
             min-width: 224px; background: var(--bg-card);
             border: 1px solid var(--border); border-radius: 12px; padding: 5px;
             box-shadow: 0 10px 30px rgba(0,0,0,.18);
             /* Origin at the top right, which is where the button that opened
                it is. A menu that grows from its own trigger says which
                control it belongs to without a pointer or a tail. */
             transform-origin: top right;
             animation: pop-in .13s cubic-bezier(.23,1,.32,1); }
    .hmenu button { display: flex; align-items: center; gap: 10px; width: 100%;
                    padding: 9px 11px; border: 0; border-radius: 8px;
                    background: none; font: inherit; font-size: 13.5px;
                    color: var(--fg); cursor: pointer; text-align: left;
                    transition: background-color .13s cubic-bezier(.23,1,.32,1); }
    .hmenu button:hover { background: var(--bg-sunken); }
    /* The operator menu is a list of destinations rather than one action,
       so it gets the rail's own headings — same size, same tracking, same
       muted ink as the group labels inside /admin, because it is the same
       list seen from outside. */
    .amenu { min-width: 208px; }
    .amenu .amenu-head { font-size: 11px; letter-spacing: 0.09em;
                         text-transform: uppercase; color: var(--muted);
                         font-weight: 600; padding: 8px 11px 4px; }
    .amenu .amenu-head:first-child { padding-top: 4px; }
    /* The guest strip: ration and door, worn in the header like the chips
       around it. The count is a bordered pill in muted ink — information, not
       a control — and the sign-in is the one filled mark in the bar, because
       it is the one thing a guest is being asked to consider. (No backticks
       in this comment: it lives inside a css template literal.) The low class
       borrows the danger ink once three messages remain; it must change
       colour, not start blinking. */
    .guest-strip { display: flex; align-items: center; gap: 8px; flex: none; }
    .guest-count { font-size: 12.5px; color: var(--muted);
                   border: 1px solid var(--border); border-radius: 999px;
                   padding: 4px 10px; white-space: nowrap; }
    .guest-count.low { color: var(--danger, #a8321f);
                       border-color: var(--danger, #a8321f); }
    .guest-signin { border: 0; border-radius: 999px; padding: 6px 12px;
                    cursor: pointer; font: 500 12.5px var(--display);
                    background: var(--brand); color: var(--accent-fg, #fff); }
    .guest-signin:hover { filter: brightness(1.06); }
    /* On a phone the pill's sentence is the widest thing in the bar; the
       button carries the feature alone and the count lives in its title and
       in the wall. */
    @media (max-width: 640px) { .guest-count { display: none; } }
    main { flex: 1; min-height: 0; background: var(--bg-chat); }
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
        /* Only in here. Above the breakpoint the panel is a docked column and
           a rise would be a column jumping in the layout; as a sheet over the
           page it is the same gesture as the directory, and gets the same
           motion. */
        animation: rise-in .2s cubic-bezier(.23,1,.32,1);
      }
      .scrim.files { display: block; position: fixed; inset: 0; z-index: 45; }
    }
    @media (min-width: 1025px) {
      /* Hidden again, and this time on purpose rather than by inheritance.
         Showing it put TWO identical panel-left buttons sixty pixels apart —
         the rail's own collapse control and this one — both doing the same
         job, which reads as one of them being broken. The rail hides itself
         with its own button; the floating .unrail brings it back. One control
         in each state, which is one more than there used to be and one fewer
         than I briefly shipped. */
      .icon.nav { display: none; }
      /* The rail is a column here, and its account menu already carries
         Settings — see the comment on the button. */
      .icon.settings-here { display: none; }
    }

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
    /* The bias is a fraction of the height the shell ACTUALLY has, not of vh.
       vh is the layout viewport, which on iOS does not shrink when the
       keyboard opens — so with the keyboard up the block was still being
       pushed a seventh of a FULL screen upward inside a half-screen window,
       and the wordmark was clipped through the middle of its own letters.
       --app-h is the measured visible height (head.html sets it from
       visualViewport), so the bias shrinks with the room. */
    main.empty { display: flex; flex-direction: column; justify-content: center;
                 padding-bottom: calc(var(--app-h, 100svh) * 0.14); }
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
    @media (max-width: 640px) {
      main.empty { padding-bottom: calc(var(--app-h, 100svh) * 0.24); }
    }
    /* With thumbnails the card row is ~200px tall, so the block only needs
       to move up enough to clear it — 6vh put the wordmark against the header
       with a screen of blank beneath. Centred-but-biased: still centre, just
       with the cards' height taken out of the calculation. */
    main.empty.has-starts { justify-content: center; padding-top: 0;
                            padding-bottom: 0; }
    main.empty nr-chatbot { flex: 0 0 auto; height: auto; }

    /* Compact: the answers extend the composer upward.
     *
     * The same content-sizing the empty home already uses — the card is as
     * tall as what is in it — with a ceiling on the message list so it grows
     * to a point and then scrolls. Everything here is the component's own
     * public surface: the messages part on the list, and the inverted-scroll
     * property for the column-reverse that keeps the newest line against the
     * composer.
     * Nothing reaches into the shadow root and nothing was patched.
     *
     * The card is anchored to the BOTTOM of the block rather than centred,
     * which is what makes it grow upward: with the block centred, two lines of
     * answer push the composer down half their height and the caret moves
     * under the reader's hands mid-sentence.
     */
    main.compact { justify-content: flex-end; padding-bottom: 4vh; }
    main.compact nr-chatbot { flex: 0 0 auto; height: auto; }
    main.compact nr-chatbot::part(content) { flex: 0 0 auto; min-height: 0; }
    /* One object, not two. Without this the conversation floats above the
       composer as a separate block with a rule between them, which is a
       transcript with a box under it — the opposite of the claim being made.
       The border goes on the boxed area, which is the one wrapper holding both
       — the content part turned out to be the message list alone, so a border
       there enclosed the conversation and left the composer outside it. The
       composer inside gives up its own. */
    main.compact nr-chatbot::part(boxed-area) {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--nuraly-chatbot-input-bg, var(--bg-raised));
      overflow: hidden;
      max-width: 768px;
      margin: 0 auto;
      width: 100%;
    }
    main.compact nr-chatbot::part(input-container) {
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: transparent;
    }
    main.compact nr-chatbot::part(messages) {
      max-height: min(46vh, 440px);
      overflow-y: auto;
      /* The hairline the suggestion list has, mirrored: the drop-down is
         separated from the composer below it, so the conversation is
         separated from the composer above it. */
      border-bottom: 1px solid var(--border);
    }
    /* The growth itself. A height that jumps is read as a re-layout; one that
       moves is read as the card opening. The house curve, and off entirely
       for anyone who asked for less motion. */
    main.compact nr-chatbot::part(messages) {
      transition: max-height .28s cubic-bezier(.23,1,.32,1);
    }
    @media (prefers-reduced-motion: reduce) {
      main.compact nr-chatbot::part(messages) { transition-duration: .01ms; }
    }
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
    /* Above the header, which is sticky at 40. Both sat at 39/40, and equal
       z-index is decided by paint order — so the header drew ON TOP of the
       directory, with the folder icon and the guest strip floating over a
       dialog that was supposed to have taken the screen. The index layer at
       51/52 already had this right; this is the same band, so the two
       overlays cannot fight each other either. */
    .scrim.shelves { display: block; position: fixed; inset: 0; z-index: 49;
                     background: rgba(0,0,0,.32); backdrop-filter: blur(2px);
                     /* Slower than the panel it stands behind, and no
                        movement: the page dims TO make room, and the sheet
                        arrives in front of it. Both at once reads as one
                        gesture rather than two things appearing. */
                     animation: veil-in .2s cubic-bezier(.23,1,.32,1); }
    /* Wide enough to be a directory. At 560px the card grid fell to two
       columns on a 1500px screen and the panel read as a menu that had been
       stretched; a directory is something you browse, and browsing wants the
       width. Still bounded — a panel edge to edge is a page, and this one is
       deliberately not a page. */
    /* The index layer. Bounded and scrollable rather than full-bleed: what it
       holds is one screen of reading, and a sheet the size of the window would
       make a glance look like a destination. */
    /* Height follows the content, capped — not inset top AND bottom. Pinned to
       both edges the panel was a tall white column with a third of it empty,
       which reads as something still loading. */
    /* Above the header, which is sticky at 40 — at the same 40 the header won
       on document order alone and stayed lit over a dimmed page. Below the nav
       drawer (60) and its scrim (55), which are still the layer that covers
       everything. */
    .scrim.index { display: block; position: fixed; inset: 0; z-index: 51; }
    .index-layer { position: fixed; z-index: 52; overflow-y: auto;
                   top: 8vh; bottom: auto; max-height: 84vh;
                   left: max(12px, calc(50vw - 380px));
                   right: max(12px, calc(50vw - 380px));
                   background: var(--bg-card); border: 1px solid var(--border);
                   border-radius: 18px; padding: 30px 32px 36px;
                   box-shadow: 0 24px 60px -12px rgba(0,0,0,.35); }
    .index-close { position: absolute; top: 14px; right: 14px; }
    @media (max-width: 720px) {
      .index-layer { top: 6vh; left: 10px; right: 10px; max-height: 88vh;
                     padding: 22px 16px 28px; border-radius: 16px; }
    }
    .gallery { position: fixed; z-index: 50; background: var(--bg-card);
              border: 1px solid var(--border); border-radius: 16px;
              box-shadow: 0 24px 60px -12px rgba(0,0,0,.35);
              display: flex; flex-direction: column; overflow: hidden;
              left: 50%; transform: translateX(-50%); top: 8vh; bottom: 8vh;
              width: min(980px, calc(100% - 48px));
              /* The keyframe carries the -50% itself. A transform in a
                 keyframe replaces the one in the rule rather than composing
                 with it, so a rise written as translateY alone would drop the
                 centring and the panel would fly in from half a screen to the
                 right — which is what it did the first time. */
              animation: sheet-in .2s cubic-bezier(.23,1,.32,1); }
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
    .gallery-tab { display: flex; align-items: center; gap: 6px; flex: none;
                   padding: 6px 10px; border: 0; border-radius: 9px;
                   background: none; font: inherit; font-weight: 600;
                   font-size: 14.5px; color: var(--faint); cursor: pointer;
                   transition: color .15s cubic-bezier(.23,1,.32,1),
                               background-color .15s cubic-bezier(.23,1,.32,1); }
    .gallery-tab:hover { color: var(--muted); background: var(--bg-sunken); }
    /* --bg-sunken, which is what every other selected control in this file
       sits on (.icon[aria-pressed], the menu rows). --fill-1 is a step
       lighter and was the only wash of its kind here, so the chosen tab read
       as fainter than a pressed button meaning the same thing. */
    .gallery-tab.on { color: var(--fg); background: var(--bg-sunken); }
    /* One line saying what this shelf is. Three nouns that sound alike need
       it once, where somebody is looking at them. */
    .gallery-lede { margin: 12px 16px 0; color: var(--muted);
                    font-size: 13px; line-height: 1.45; }
    .pick-from { font-size: 12px; color: var(--faint); }
    /* The shelf of services you can sign in to, under the ones you already
       have. A heading rather than a second tab: these are the same kind of
       thing as the cards above them, at a different stage of setup, and
       splitting them across tabs would hide the answer to "what can I add"
       behind a click. */
    .gallery-scroll mcp-gallery { display: block; padding: 0 16px 16px; }
    /* --- the attach menu, in the composer's dropdown ----------------------- */
    /* Light DOM inside nr-chatbot's slot, so these rules reach it from here.
       Sized to the reference: a menu you read down, not a grid. */
    /* box-sizing, stated: this shadow root carries no reset, so the rows were
       width:100% against the panel's PADDING box and came out 8px wider
       than the content box they sat in — which put the switch at the end of
       each connector row 6px past the panel's right edge, half of it clipped.
       Stretch is what a flex column does anyway, so the width goes too. */
    .attach, .attach-row { box-sizing: border-box; }
    /* This panel is slotted into nr-dropdown, so the box around it is the
       component's and this animates only what the console draws inside it.
       Kept lighter than .hmenu for that reason — two nested surfaces each
       doing a full pop is one motion too many in a corner this small. */
    .attach { min-width: 264px; padding: 4px; display: flex; flex-direction: column;
              transform-origin: bottom left;
              animation: pop-in .12s cubic-bezier(.23,1,.32,1); }
    .attach-row { display: flex; align-items: center; gap: 10px;
                  font: inherit; font-size: 13.5px; color: var(--fg); text-align: left;
                  background: none; border: 0; border-radius: 8px; padding: 8px 10px;
                  cursor: pointer;
                  transition: background-color .13s cubic-bezier(.23,1,.32,1); }
    .attach-row:hover { background: var(--bg-sunken); }
    /* A connector row is not itself pressable — the switch inside it is — so it
       must not take the hover of something that acts on click. */
    .attach-row.conn-row { cursor: default; }
    .attach-row.conn-row:hover { background: none; }
    .attach-row nr-icon { color: var(--fg); flex: none; }
    /* The label only. A bare attach-row span selector also matched the
       switch's own knob and the mark's inner span, which gave the knob flex:1
       and stretched the pill across the row until it ran out of menu. */
    .attach-label { flex: 1; min-width: 0; overflow: hidden;
                    text-overflow: ellipsis; white-space: nowrap; }
    .attach-row .go { color: var(--muted); flex: none; }
    .attach-mark { display: inline-grid; place-items: center; width: 18px; height: 18px;
                   flex: none; }
    .attach-mark svg { width: 15px; height: 15px; display: block; }
    .attach-rule { height: 1px; background: var(--border); margin: 4px 8px; }
    .attach-warn { background: none; border: 0; padding: 2px; cursor: pointer;
                   display: grid; place-items: center; flex: none; }
    .attach-warn nr-icon { color: var(--warn, #b26a00); }
    /* The submenu. Positioned against its own row so it opens level with it,
       which is what makes a flyout read as belonging to the row rather than as
       a second menu that happened to appear. */
    /* The wrapper is a flex column so the button inside it stretches. As a
       plain block it left the button at its own intrinsic width, so the one
       row that opens a submenu was the one row narrower than the rest — the
       others are direct flex children of the panel and stretch for free. */
    .attach-sub { position: relative; display: flex; flex-direction: column; }
    .attach-row.open { background: var(--bg-sunken); }
    .fly { position: fixed; z-index: 60; max-height: 320px; overflow-y: auto; padding: 4px;
           box-sizing: border-box; background: var(--bg-card);
           border: 1px solid var(--border); border-radius: 12px;
           box-shadow: 0 12px 32px rgba(23,23,26,0.16);
           display: flex; flex-direction: column;
           /* A submenu grows from the row that opened it, so its origin is the
              left edge — the side it is attached to. It is also the fastest
              surface here: it appears while the menu it belongs to is already
              on screen, and a second wait inside an open menu feels like lag
              rather than like motion. */
           transform-origin: top left;
           animation: pop-in .12s cubic-bezier(.23,1,.32,1); }
    .fly .attach-row.on { color: var(--brand); }
    .fly .attach-row.on nr-icon { color: var(--brand); }
    .fly-find { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
                margin-bottom: 2px; border-bottom: 1px solid var(--border); }
    .fly-find nr-icon { color: var(--muted); flex: none; }
    .fly-find input { flex: 1; min-width: 0; border: 0; background: none; padding: 0;
                      font: inherit; font-size: 13px; color: var(--fg); outline: none; }
    .fly-find input::placeholder { color: var(--muted); }
    .fly-none { margin: 0; padding: 8px 10px; font-size: 12.5px; color: var(--muted); }
    /* --- a connector, with its switches ------------------------------------ */
    .conn-list { display: flex; flex-direction: column; gap: 8px; padding: 0 16px; }
    .conn { border: 1px solid var(--border); border-radius: 12px;
            background: var(--bg-card); padding: 10px 12px; }
    .conn-top { display: flex; align-items: center; gap: 10px; }
    .conn-mark { display: inline-grid; place-items: center; width: 20px; height: 20px;
                 flex: none; }
    .conn-mark svg { width: 16px; height: 16px; display: block; }
    .conn-name { font-size: 14px; font-weight: 600; flex: 1; min-width: 0;
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conn-ok { font-size: 12px; color: var(--ok); white-space: nowrap; }
    .conn-connect { font: inherit; font-size: 12.5px; padding: 4px 12px; cursor: pointer;
                    border-radius: 999px; border: 1px solid var(--brand);
                    background: var(--brand); color: var(--accent-fg); white-space: nowrap; }
    /* The switch. A button with role=switch rather than a checkbox: it is the
       control the reference uses, it reads to a screen reader as on or off
       rather than as checked, and it needs no label beside it to be understood. */
    .sw { flex: none; width: 34px; height: 20px; border-radius: 999px; cursor: pointer;
          border: 1px solid var(--border); background: var(--bg-sunken); padding: 0;
          position: relative; transition: background-color .16s cubic-bezier(.23,1,.32,1),
                                          border-color .16s cubic-bezier(.23,1,.32,1); }
    .sw span { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
               border-radius: 50%; background: var(--muted); display: block;
               transition: transform .16s cubic-bezier(.23,1,.32,1), background-color .16s; }
    .sw.on { background: var(--brand); border-color: var(--brand); }
    .sw.on span { transform: translateX(14px); background: var(--accent-fg); }
    .conn-sub { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
    .conn-where { font-size: 12px; color: var(--faint); flex: 1; min-width: 0;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conn-tools { display: inline-flex; align-items: center; gap: 4px; flex: none;
                  font: inherit; font-size: 12px; background: none; border: 0;
                  padding: 0; cursor: pointer; color: var(--muted); }
    .conn-tools:hover { color: var(--fg); }
    /* The tool list. Scrolls at about eight rows: a connector with 52 of them
       would otherwise push the shelf below it off the panel entirely. */
    .tool-list { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border);
                 max-height: 260px; overflow-y: auto; display: flex;
                 flex-direction: column; gap: 2px; }
    .tool { display: grid; grid-template-columns: auto auto 1fr; align-items: baseline;
            gap: 8px; padding: 4px 6px; border-radius: 8px; cursor: pointer; }
    .tool:hover { background: var(--bg-sunken); }
    .tool input { margin: 0; accent-color: var(--brand); cursor: pointer; }
    .tool-name { font-size: 12.5px; font-family: var(--mono, monospace); }
    .tool-why { font-size: 12px; color: var(--muted); overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
    .tool-none { margin: 0; padding: 6px; font-size: 12.5px; color: var(--muted); }
    /* A brand mark in the tile a connector's icon would have used. The tile
       keeps its size and shape so the grid stays a grid; only what is drawn
       inside it changes. */
    .pick-tile.brandy { display: grid; place-items: center; }
    .pick-tile.brandy svg { width: 15px; height: 15px; display: block; }
    .shelf-problem { margin: 0 16px 16px; font-size: 12.5px; color: var(--danger); }
    /* How many, beside the name. Both references carry the number rather than
       making you count the cards, and it is the fastest way to see that a
       filter is hiding most of them.

       Ink, not a pill. It was an outlined capsule, which made four bordered
       chips sit in the one row of this console that is supposed to be text —
       the note above .gallery-tabs says the tabs are "separated by nothing
       but weight and ink", and a border per count is exactly what that rules
       out. It was also the only place in the app that draws a count that way:
       settings.ts's group and candidate counts are muted numerals beside a
       label, and this now reads like them.
       Quieter than the label deliberately. The word is what you press; the
       number is what you glance at. A zero especially — "Plugins 0" inside a
       ring announced an empty shelf, where the same 0 in faint ink just
       answers a question nobody asked twice.
       Tabular figures so 13 and 8 keep the label ahead of them from shifting
       as a filter counts down. */
    .gallery-count { font-size: 12.5px; font-weight: 500; letter-spacing: 0;
                     color: var(--faint); font-variant-numeric: tabular-nums;
                     text-transform: none; }
    .gallery-tab:hover .gallery-count { color: var(--muted); }
    .gallery-tab.on .gallery-count { color: var(--muted); }
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
    /* The completion list: the composer's own surface, continued.
       No shadow and no top radius — the join has to read as one box, and a
       second shadow under the composer's own draws a seam exactly where the
       design says there is none. */
    .hints { position: fixed; z-index: 45;
             background: var(--bg-card);
             border: 1px solid var(--border); border-top: 0;
             /* 24px, matching the composer's own corner — see composerCard. */
             border-radius: 0 0 24px 24px;
             padding: 6px 0 8px;
             display: flex; flex-direction: column;
             max-height: 46vh; overflow-y: auto; overscroll-behavior: contain; }
    /* Opening upward: every edge that made the join swaps ends.
       NOT column-reverse. That was here to move the divider to the bottom and
       it also reversed the ROWS — the best match ended up furthest from the
       field and the arrow keys walked the list backwards. The divider moves
       with a second pseudo-element instead, which is what one is for. */
    .hints.up { border-top: 1px solid var(--border); border-bottom: 0;
                border-radius: 24px 24px 0 0;
                padding: 8px 0 6px; }
    /* A separator that stops short of the edges, so the rule reads as
       dividing the list from the field rather than as the box's own border.
       It sits against whichever edge the composer is on: ::before when the
       list hangs below it, ::after when it stands above. */
    .hints::before { content: ""; display: block; height: 1px; margin: -6px 14px 6px;
                     background: var(--border); }
    .hints.up::before { display: none; }
    .hints.up::after { content: ""; display: block; height: 1px; margin: 6px 14px -6px;
                       background: var(--border); }
    .hint { display: flex; align-items: center; gap: 12px; width: 100%;
            text-align: left; padding: 9px 16px; border: 0; background: none;
            font: inherit; font-size: 14.5px; color: var(--fg); cursor: pointer; }
    .hint:hover, .hint.on { background: var(--bg-sunken); }
    /* A completion is one line and never wraps: the list is scanned down its
       left edge, and a row that becomes two breaks that column for every row
       under it. */
    .hint-text { flex: 1; min-width: 0; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap; }
    /* What you already typed, held back; the completion in the reading
       weight. */
    .hint-had { color: var(--muted); }
    .hint-text b { font-weight: 600; }
    .hints nr-icon { color: var(--muted); flex: none; }
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
    /* Reading a skill. The briefing is preformatted because it IS formatted —
       its indentation and its blank lines are how a model reads it, and
       reflowing it here would show something other than what the model gets. */
    .skill-open { display: flex; flex-direction: column; min-height: 0; }
    .skill-open-head { display: flex; align-items: center; gap: 8px;
              padding: 10px 16px 0; }
    .skill-open-name { font-size: 15px; font-weight: 600; flex: 1; min-width: 0;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pin-now { flex: none; border: 1px solid var(--border); border-radius: 999px;
              background: none; color: var(--fg); font: 600 12px var(--sans, sans-serif);
              padding: 6px 12px; cursor: pointer; }
    .pin-now:hover { background: var(--bg-sunken); }
    .skill-open-body { overflow-y: auto; overscroll-behavior: contain;
              padding: 4px 16px 16px; }
    .skill-open-why { color: var(--muted); margin: 6px 0 12px; font-size: 13px; }
    .skill-open-label { display: flex; align-items: center; gap: 6px;
              font-size: 12px; font-weight: 600; letter-spacing: .04em;
              text-transform: uppercase; color: var(--muted); margin: 14px 0 6px; }
    .skill-open-text { margin: 0; padding: 12px; border-radius: 10px;
              background: var(--bg-sunken); border: 1px solid var(--border);
              font: 12px/1.5 var(--mono, ui-monospace, monospace);
              white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
    .skill-file { margin-top: 8px; }
    .skill-file summary { cursor: pointer; font: 12px var(--mono, ui-monospace, monospace);
              color: var(--muted); padding: 6px 0; }
    .skill-file summary:hover { color: var(--fg); }
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
    /* The search field, the shape the artifacts library gives one — the two
       pages do the same job and should not look like two products. */
    .starts-find { display: flex; align-items: center; gap: 10px;
                   border: 1px solid var(--border); border-radius: 12px;
                   padding: 10px 14px; background: var(--bg); margin: 0 0 20px;
                   max-width: 520px; }
    .starts-find:focus-within { border-color: var(--muted); }
    .starts-find input { flex: 1; min-width: 0; border: 0; background: none;
                         padding: 0; font: inherit; font-size: 14.5px;
                         color: inherit; outline: none; }
    .starts-find nr-icon { color: var(--muted); flex: none; }

    .offer-grid { display: grid; gap: 14px;
                  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
                  align-content: start; }
    /* The whole card opens it, so the whole card has to look pressable. No
       overflow:hidden — see the artifacts library for what that costs a grid
       item: it zeroes the element's intrinsic height and every row collapses
       to its borders. */
    .offer { display: flex; flex-direction: column; gap: 6px; padding: 16px;
             min-height: 118px;
             border: 1px solid var(--border); border-radius: 14px;
             background: var(--bg); cursor: pointer;
             transition: border-color .15s cubic-bezier(.23,1,.32,1),
                         transform .15s cubic-bezier(.23,1,.32,1); }
    .offer:hover { border-color: var(--muted); transform: translateY(-1px); }
    .offer:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .offer-name { font-size: 15px; font-weight: 600; line-height: 1.35;
                  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3;
                  -webkit-box-orient: vertical; }
    .offer-meta { font-size: 12.5px; color: var(--muted); }
    /* Pushed to the foot so every card's action sits on one line however long
       the titles above them run. */
    .offer-acts { display: flex; gap: 8px; margin-top: auto; padding-top: 10px; }
    .offer-remix { font: inherit; font-size: 13px; padding: 5px 14px;
                   cursor: pointer; border: 1px solid var(--border);
                   border-radius: 999px; background: none; color: var(--muted);
                   transition: color .15s cubic-bezier(.23,1,.32,1),
                               border-color .15s cubic-bezier(.23,1,.32,1); }
    .offer-remix:hover { color: var(--fg); border-color: var(--muted); }
    /* The banner that stands where the composer would be. */
    .borrowed { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
                max-width: 768px; margin: 0 auto 14px; padding: 12px 16px;
                border: 1px solid var(--border); border-radius: 12px;
                background: var(--bg-rail); color: var(--muted); font-size: 13.5px; }
    .offer-remix:hover { background: var(--bg-user); border-color: var(--muted); }
    .caps { min-height: 32px; box-sizing: content-box; }
    /* Out of the way while the composer is suggesting.
     *
     * The card grows downward over this row, and the pills kept drawing —
     * their icons showed THROUGH the list, between the suggestions, because
     * the row comes later in the document and neither box claims a stacking
     * order. Hiding it rather than stacking the card over it: these are a
     * shortcut for somebody who has not started, and somebody typing a query
     * has started. Hidden by visibility rather than display, so the row keeps
     * its reserved height and the card does not jump when the list closes. */
    main.hinting .caps { visibility: hidden; }
    /* And the phone's Explore bar, for the same reason and with the same
       reservation: it sits under the composer at narrow widths, the card
       grows over it, and its text drew through the suggestions. */
    main.hinting .explore { visibility: hidden; }
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
    /* One rule, not two. The pair that used to be here disagreed — the second
       set max-width: 768px and, coming later, won — so on a phone the row was
       wider than the screen it was supposed to scroll inside. An element wider
       than its viewport does not scroll itself; it just hangs off the edge,
       which is exactly what a person saw: a second card half off screen and no
       way to reach it. */
    .starts { display: flex; gap: 10px; padding: 0 18px;
              max-width: min(768px, 100%); margin: 0 auto;
              overflow-x: auto; overscroll-behavior-x: contain;
              scrollbar-width: none; }
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
                        box-shadow .15s cubic-bezier(.23,1,.32,1),
                        transform .15s cubic-bezier(.23,1,.32,1); }
    /* A pixel. The card already answers a hover with its border and a shadow;
       the lift is what makes those two read as one object rising rather than
       as two properties changing. More than 1px and the row of cards ripples
       as the pointer crosses it. */
    .card:hover { border-color: var(--accent); box-shadow: 0 3px 8px rgba(0,0,0,.08);
                  transform: translateY(-1px); }
    .card:active { transform: translateY(0); box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .card .card-name { font-size: 13px; font-weight: 600; max-width: 100%;
                       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card .card-meta { font: 11.5px var(--mono); color: var(--muted); }
    /* The composer sits on the bottom edge of the window, in every browser.
     *
     * The component grows its transcript with
     *   :host([boxed]) .chatbot-content:not(:has(.empty-state)) { flex: 1 }
     * and Firefox does not apply that rule — measured, not guessed: the same
     * element computes flex 1 1 0% in Chromium and flex 0 0 auto in
     * Firefox 153 on the same page. With flex:0 the transcript is only as tall
     * as its messages, so the composer rides up under the last reply and
     * leaves a third of the window blank beneath it.
     *
     * Reachable because .chatbot-content carries part="content" — the note
     * further up about ::part being useless is about .input-box, which exposes
     * none, and does not generalise. Scoped to a conversation: the empty home
     * deliberately lets the chatbot size to its content so the wordmark and
     * composer centre together, and this would undo that. */
    main:not(.empty) nr-chatbot::part(content) { flex: 1 1 auto; min-height: 0; }
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
    think: () => this.thinkOn,
    // The one place a conversation's id arrives without anyone having opened
    // it: the first message of a new thread creates it server-side and this is
    // how the console learns which one it got. It has to route too, or the
    // conversation you just started is the one you cannot link to or reload
    // back into.
    onThreadOpened: (id) => { this.threadId = id; this.route(id); },
    onTurnDone: () => { void this.refreshThreads(); void this.refreshRefs(); },
    // The strip's clock: each guest reply carries the count the engine
    // recorded after the run, so two tabs agree without either asking again.
    onGuestRemaining: (n) => {
      this.guestRemaining = n;
      if (this.guestLimit === 0) { this.guestLimit = 10; }
    },
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
  /* What the composer held when somebody chose "Schedule this", so the form
     opens with the instruction already in it. Cleared on the way out, or
     arriving from the rail later would resurrect a sentence from an hour
     ago. */
  @state() private taskDraft = "";
  /* Whether this conversation is being had in the composer card rather than
     on a page of its own. True for one begun here; false for one opened from
     the rail, which is a transcript to read rather than a sentence in
     progress. */
  @state() private compact = true;
  @state() private view: "chat" | "knowledge" | "canvas" | "starts" | "library" | "discover" | "article" | "tasks" = "chat";

  /* Which article, when the view is "article".
   *
   * A view inside the console rather than a page of its own, for the reason
   * Discover itself is one: moving between two of this app's screens must not
   * throw away the shell, the sidebar, the socket and the signed-in identity
   * and rebuild them. It still has an ADDRESS — see `openArticle` — because a
   * story is the most linkable thing on the site. */
  @state() private articleId = "";
  /* What other people have offered, loaded when the page opens. */
  @state() private offers: ThreadListing[] = [];
  /* What is typed into the Starting points filter. Its own field rather than
     sharing the gallery's: the two lists are on screen at different times, and
     a filter that survived from one to the other would read as a bug. */
  @state() private startsFind = "";
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
  /* The guest ration, for the strip in the header. `remaining` is null until
     the server has said a number — a strip that guesses "10" and corrects
     itself a beat later is a strip that lies once per page load. Every value
     here is the engine's: GET /quota once at boot, then `guestRemaining` off
     each say reply. Nothing decrements locally. */
  @state() private guestLimit = 0;
  @state() private guestRemaining: number | null = null;
  @state() private guestResetsAt = "";
  /* The soft wall: raised by QUOTA_SPENT (a send met the 429), dismissible,
     thread still readable behind it. Distinct from `signedOut`, which is a
     real 401 and stays the hard, undismissable path. */
  @state() private quotaWall = false;
  /* The same overlay opened on purpose — the strip's Sign in, the rail's row.
     Soft and dismissible, with the default lede rather than the wall's. */
  @state() private signIn = false;
  /* Reflected, because the drawer and its scrim are styled from the host —
     a boolean in a template cannot reach the sidebar element's own transform. */
  @property({ type: Boolean, reflect: true }) nav = false;

  /* Whether the rail is showing on a WIDE screen.
   *
   * `nav` is the phone drawer and only does anything under 1024px, so above
   * that the toggle button in the header flipped a flag nothing read — one
   * control, doing nothing, on every desktop. This is the other half: below
   * 1024 the button opens the drawer, above it the button hides the column.
   * Reflected so the rules can be written against the host. */
  @property({ type: Boolean, reflect: true }) railed = true;

  /* Peeking at a hidden rail.
   *
   * Hiding the rail buys width and costs reach: every conversation and every
   * screen in the app was one click away and is now two, with a hidden panel
   * in between. Hovering the toggle floats the real rail back over the page
   * so it can be read and clicked without being brought back for good — the
   * column stays wide, and the thing you wanted is still one movement away.
   *
   * The SAME element, floated, rather than a second copy: console-sidebar
   * holds the conversation list and its pollers, and mounting it twice would
   * be two of both. */
  @property({ type: Boolean, reflect: true }) railPeek = false;

  /** What the header's toggle does, which depends on how wide the window is. */
  private toggleRail(): void {
    if (window.matchMedia("(max-width: 1024px)").matches) { this.nav = !this.nav; }
    else { this.railed = !this.railed; }
  }
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
  /* The skill whose body and files are open, and what they are. A card used
     to pin and close, which answered "give me this" and never "what IS this"
     — and a briefing is the whole of what a skill does, so not being able to
     read one made every skill a name and a sentence. */
  @state() private skillOpen = "";
  /* The operator's announcement, above everything. Loaded once per page
     life, dismissible per TAB (sessionStorage): an announcement should not
     reappear on every navigation, and should reappear tomorrow. */
  @state() private banner = "";
  @state() private skillFiles: SkillFileRow[] = [];
  /* What is typed into the gallery's filter. Cleared when it opens, because a
     filter left over from last time is a gallery that looks empty. */
  @state() private galleryFind = "";
  /* The slash menu: what has been typed after "/" in the composer, or null
     when the composer holds anything that is not a lone slash-word. null
     rather than "" because "" is a real state — the moment after the slash,
     when every skill matches. */
  @state() private slash: string | null = null;
  /* Completions for what is being typed, from the deployment's own index.
     Empty when there is nothing to offer, which is most of the time — a
     suggestion list that draws for every keystroke is a list nobody reads. */
  @state() private hints: string[] = [];
  /* Which hint the arrow keys are on; -1 for none, which is the state after
     typing and before pressing anything. */
  @state() private hintAt = -1;
  /* The keystroke a fetch is in flight for, so a slower answer for an older
     prefix cannot overwrite a newer one — the classic out-of-order race, and
     the reason a suggestion list flickers between two prefixes. */
  private hintFor = "";
  private hintTimer = 0;
  /* Every skill, not just the featured few the chips draw. Fetched the first
     time the gallery is opened rather than on load: a console that nobody
     asks is a console that should not have asked. */
  @state() private allSkills: SkillRow[] = [];
  /* MCP servers, which the + menu calls Plugins. Loaded with the rest so the
     menu knows whether to offer the row at all — the alternative is a row that
     opens an empty panel. */
  @state() private servers: ServerRow[] = [];
  /* Which connectors this person is signed in to — server id to its state.
     Per-caller, so never a column on the server row: the same connector reads
     as connected for whoever approved it and not for anybody else. */
  @state() private connections = new Map<string, ConnectionRow>();
  /* Why a Connect did not work, said under the shelf that offered it. */
  @state() private connectProblem = "";
  /* Which connector's tool list is open, and what each one offered. */
  @state() private toolsOpen = "";
  /* Which submenu of the attach menu is open, or "". */
  @state() private attachSub = "";
  /* Where the open submenu sits, in viewport coordinates. */
  @state() private subAt = { x: 0, y: 0 };
  /* The submenu's own filter. Cleared whenever it opens. */
  @state() private subFind = "";
  /* How wide the open submenu is: its own width beside the menu, the
     parent's width where it stands in for it. */
  @state() private subW = 224;
  @state() private toolList = new Map<string, { name: string; description: string; on: boolean }[]>();
  /* Installed bundles, and what each one brought. The directory needs the
     second to say "From <plugin>" on a skill card: a plugin's skill is stored
     as an ordinary repo-sourced skill, so without the receipts there is no way
     to tell one that came from a bundle from one somebody synced by hand. */
  @state() private plugins: PluginRow[] = [];
  // The card plugins, listed beside the bundles — see listCardPlugins.
  @state() private cardPlugins: CardPluginRow[] = [];
  /* Which agent the graph view opens selected on — set by the card that
     opened it, cleared by nothing: the canvas ignores it after first load. */
  @state() private canvasFocus = "";
  /* The header's three-dot menu. */
  @state() private hmenu = false;
  /* The operator's shortcut menu, open or shut. Its own flag rather than
     a shared "which menu" enum: the two live at opposite ends of the
     header and closing one to open the other is a frame of nothing. */
  @state() private amenu = false;
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
  private seededView = false;
  private seeded = false;
  willUpdate(): void {
    /* The route's own screen, applied before the first render — on the server
       as well as in the browser. Assigned rather than compared-and-assigned
       because `view` is state the person then changes by clicking, and
       `startView` is only ever the opening position: the guard is `seededView`,
       not a re-read of the property. */
    if (!this.seededView && this.startView !== "") {
      this.seededView = true;
      this.view = this.startView as typeof this.view;
      if (this.startView === "article") { this.articleId = this.openArticleAt; }
      /* Starting points is the one screen whose CONTENT is fetched by the
         thing that opens it rather than by the element itself — there is no
         <starts-page>, it is markup this component draws from `offers`. So
         arriving at the address has to do what clicking the rail row does, or
         the route renders the frame around an empty list. */
      if (this.startView === "starts") { void this.openStarts(); }
    }
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
    void this.session.apply(seed.turns as never, this.seedPast as never);
  }

  async connectedCallback() {
    super.connectedCallback();
    // Card buttons live inside the chatbot's shadow root as plain HTML, so the
    // listener goes on the host and reads composedPath(). Capture, so a card
    // in a message cannot be beaten to the click by the transcript.
    this.addEventListener("click", this.onCopyCard, true);
    // The tab's name is part of the brand too — nothing else in the app sets
    // a <title>, so without this the tab wears whatever the framework's shell
    // defaulted to. Safe here because SSR skips connectedCallback (see the
    // seeding note above); on the server there is no document to touch.
    document.title = BRAND;
    this.startDot();
    // Arriving ON /settings: open it, without pushing the address it already
    // has. openSettings() would push a duplicate entry and make Back a no-op
    // for the first press.
    if (this.openSettingsAt !== "") {
      this.settingsTab = this.openSettingsAt;
      this.settings = true;
    }
    /* Arriving ON /discover or /discover/<id>. Read from the address rather
       than only from the property so both doors work: the route page hands
       the id in, and a push from the feed changes the path without
       re-rendering the page. No pushState — the address is already this. */
    const landed = this.openArticleAt !== "" ? this.openArticleAt : currentArticle();
    if (landed !== "") {
      this.articleId = landed;
      this.view = "article";
    } else if (location.pathname === "/discover" || location.pathname === "/discover/") {
      this.view = "discover";
    } else if (location.pathname === "/tasks" || location.pathname === "/tasks/") {
      // Arriving on the address rather than navigating to it. No pushState —
      // the address is already this one.
      this.view = "tasks";
    }
    // Back and forward through Settings. The overlay is a place now, so the
    // browser's own controls have to move between it and the conversation —
    // a panel that a URL opens and Back cannot close is worse than one with
    // no URL at all.
    window.addEventListener("popstate", () => {
      const path = location.pathname;
      if (path.startsWith("/settings")) {
        const asked = path.slice("/settings".length).replace("/", "").trim();
        this.settingsTab = asked === ""
          ? "Preferences"
          : asked[0].toUpperCase() + asked.slice(1).toLowerCase();
        this.settings = true;
      } else {
        this.settings = false;
      }
    });
    // The plugin renderers, into their sandbox. Fire-and-forget: a transcript
    // that renders before a module lands shows the marker line as text, which
    // is the ordinary degradation, for one page load's race at most.
    void loadPluginRenderers();
    this.session.on("state:changed", () => { this.busy = this.session.isTyping(); });
    // Asked before the lists, and never awaited alongside them: a 401 from the
    // list calls navigates to the login, and the answer to this one decides
    // what the rail may even offer.
    window.addEventListener(SIGNED_OUT, () => { this.signedOut = true; });
    // The list is placed with measured coordinates, so it has to be measured
    // again when the box it is measured against moves. Only while it is open,
    // and a re-render is all it takes — the position is computed in render.
    window.addEventListener("resize", () => {
      if (this.hints.length > 0) { this.requestUpdate(); }
    });
    // A phone keyboard opening does not always fire `resize` — it resizes the
    // VISUAL viewport, which has its own event. Without this the list keeps
    // the position it was measured for before the keyboard appeared.
    window.visualViewport?.addEventListener("resize", () => {
      if (this.hints.length > 0) { this.requestUpdate(); }
    });
    // The guest wall, beside the sign-out for the same reason: `call` cannot
    // know who holds the shell. Soft where SIGNED_OUT is hard — the thread
    // stays readable, and dismissing it is allowed. Not latched: a guest who
    // dismisses and sends again meets the 429 again and this fires again.
    window.addEventListener(QUOTA_SPENT, (e) => {
      const said = (e as CustomEvent).detail as
        { resetsAt?: string; limit?: number } | undefined;
      if (typeof said?.resetsAt === "string" && said.resetsAt !== "") {
        this.guestResetsAt = said.resetsAt;
      }
      if (typeof said?.limit === "number" && said.limit > 0) { this.guestLimit = said.limit; }
      this.guestRemaining = 0;
      this.quotaWall = true;
    });
    // Back and Forward move between conversations rather than out of the app.
    window.addEventListener("popstate", () => {
      /* Discover's addresses are handled first and RETURN, because the line
         below reads "no conversation in the path" as "start a fresh one" —
         which, arriving on /discover or /discover/<id>, would throw away the
         feed and show an empty composer instead. Back out of an article has
         to land on the feed. */
      const article = currentArticle();
      if (article !== "") {
        this.articleId = article;
        this.view = "article";
        return;
      }
      if (location.pathname === "/discover" || location.pathname === "/discover/") {
        this.articleId = "";
        this.view = "discover";
        return;
      }
      if (location.pathname === "/tasks" || location.pathname === "/tasks/") {
        this.view = "tasks";
        return;
      }
      if (this.view === "article" || this.view === "discover" || this.view === "tasks") {
        this.view = "chat";
      }
      const id = currentId();
      if (id === "") { this.fresh(); } else if (id !== this.threadId) { void this.open(id); }
    });
    this.me = await whoami().catch(() => null);
    // The strip's first number, asked only when there is a strip to draw.
    // Not awaited: the header renders "Guest · Sign in" without the count and
    // fills it in when this lands — the answer decorates the strip, it does
    // not gate the shell.
    if (this.me?.anonymous === true) { void this.loadQuota(); }
    this.capabilities = await featuredSkills().catch(() => []);
    // The + menu draws every connector with a switch, so both of these are
    // needed before it is first opened rather than when the directory is.
    // Loaded together because they are one answer split across two routes: a
    // connector without its connection state cannot be told from one nobody
    // has signed in to, and every row would draw the warning.
    this.servers = await listServers().catch(() => []);
    await this.loadConnections();
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
    void readBanner().then((b) => {
      const text = b?.text ?? "";
      if (text !== "" && sessionStorage.getItem("joule-banner-seen") !== text) this.banner = text;
    }).catch(() => undefined);
    [this.agents, this.threads] = await Promise.all([listAgents(), listThreads()])
      .catch(() => [[], []] as [AgentFull[], ThreadListing[]]);
    this.agents = this.agents.filter((a) => a.enabled).filter(offerable);
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

  /* The guest ration at boot. `limit: 0` is the signed-in and community
     answer — unlimited — and leaves every guest field untouched, so the strip
     never draws for anyone who is not rationed. Refused is treated the same
     way: a strip is not worth an error surface, and the send path's 429 stays
     the honest gate either way. */
  private async loadQuota(): Promise<void> {
    const q = await getQuota().catch(() => null);
    if (q === null || q.limit <= 0) { return; }
    this.guestLimit = q.limit;
    this.guestRemaining = typeof q.remaining === "number"
      ? q.remaining
      : Math.max(0, q.limit - (q.used ?? 0));
    this.guestResetsAt = q.resetsAt ?? "";
  }

  /* "in 5h 20m" — how long until the ration comes back, from the engine's own
     resetsAt instant. "" when it is unknown or already past, and the copy that
     appends it must survive the "" ("today" alone is still true). Computed at
     render, not ticked: the wall re-renders on every open anyway, and a
     counter that visibly counts would promise a precision nobody needs. */
  private resetsIn(): string {
    if (this.guestResetsAt === "") { return ""; }
    const left = Date.parse(this.guestResetsAt) - Date.now();
    if (!Number.isFinite(left) || left <= 0) { return ""; }
    const h = Math.floor(left / 3600000);
    const m = Math.max(1, Math.round((left % 3600000) / 60000));
    return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }

  /* What the soft wall says. The spent case and the chosen case share one
     overlay; only the sentence differs, and neither promises the conversation
     carries over — it does not, yet. */
  private quotaNote(): string {
    const limit = this.guestLimit > 0 ? String(this.guestLimit) : "";
    const when = this.resetsIn();
    return `You have used your ${limit === "" ? "" : limit + " "}free messages for today.`
      + ` They come back ${when === "" ? "at midnight UTC" : when} — or sign in to keep chatting.`;
  }

  /* The header's guest strip: who you are, what is left, and the way up. Only
     for a caller the gateway marked anonymous; everyone signed in — and the
     community box, where `me` is null — never sees it. The count waits for
     the server's number rather than assuming 10. */
  private guestStrip() {
    if (this.me?.anonymous !== true) { return nothing; }
    const n = this.guestRemaining;
    const limit = this.guestLimit > 0 ? this.guestLimit : 10;
    const worn = n === null ? "Guest"
      : n <= 0 ? "No free messages left today"
      : `Guest · ${n} of ${limit} free message${limit === 1 ? "" : "s"} left today`;
    return html`
      <div class="guest-strip">
        <span class="guest-count ${n !== null && n <= 3 ? "low" : ""}"
          title=${this.guestResetsAt === "" ? "Free messages reset at midnight UTC"
            : `Free messages reset ${this.resetsIn() || "at midnight UTC"}`}>${worn}</span>
        <button class="guest-signin" @click=${() => { this.signIn = true; }}>Sign in</button>
      </div>`;
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
    // Not for a guest: `/models` is the operator's list and carries every
    // provider's base URL — a GCP project path, a private address for a local
    // runtime — so it stays closed to anonymous callers rather than being
    // opened for a label. The picker degrades to "Agent default", which is
    // what it already shows wherever a model has no label.
    if (this.me?.anonymous === true) { return; }
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
    this.removeEventListener("click", this.onCopyCard, true);
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
    this.drawHints();
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
      this.defaultSearchOn();
      this.dockSearch(chatEl);
      this.dockThink(chatEl);
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
    let globe = left.querySelector(".joule-globe") as HTMLElement | null;
    if (globe === null) {
      globe = document.createElement("button");
      // Two classes: `joule-chip` is the shared look, `joule-globe` is
      // this control's own identity. They were one class, and the Think
      // button added later shared it — so this lookup found THAT button,
      // decided the globe already existed, and search silently lost its
      // control while Think wore search's on-state.
      globe.className = "joule-chip joule-globe";
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
        + '15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>'
        // The word, because a lone glyph is a guess. Kimi and Claude both
        // label this control; ours was a circle nobody could name, and the
        // label is also what makes the on-state legible without hovering.
        + '<span>Search</span>';
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
      this.hangIndexCard(globe, chat);
    }
    const on = this.pinned === SEARCH_SKILL;
    globe.setAttribute("aria-pressed", on ? "true" : "false");
    globe.title = on ? "Web search is on" : "Search the web";
    globe.classList.toggle("on", on);
  }

  /* Think, beside the globe.
   *
   * Docked the same way and for the same reason — the row lives in the
   * chatbot's shadow root — and drawn from the same stylesheet, so the pair
   * read as one control each rather than two unrelated buttons. Unlike
   * search, this is NOT a skill: it rides on the send as `think`, which the
   * engine turns into whatever the provider spells thinking as.
   *
   * Offered for every deployment. A model with nothing to switch simply
   * answers as it always did, which is what "off" already means. */
  private dockThink(chat: Element & { updateComplete?: Promise<unknown> }) {
    const left = chat.shadowRoot?.querySelector(".action-buttons-left") ?? null;
    if (left === null) return;
    let bulb = left.querySelector(".joule-think") as HTMLElement | null;
    if (bulb === null) {
      bulb = document.createElement("button");
      bulb.className = "joule-chip joule-think";
      bulb.setAttribute("type", "button");
      // Inline SVG for the reason the globe is one: an nr-icon adopted into
      // another component's shadow root loses the tokens it styles from.
      bulb.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
        + 'stroke-linejoin="round"><path d="M9 18h6"></path>'
        + '<path d="M10 22h4"></path>'
        + '<path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"></path>'
        + '</svg><span>Think</span>';
      bulb.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.thinkOn = !this.thinkOn;
        this.dockThink(chat);
      });
      left.appendChild(bulb);
      this.styleSearchGlobe(chat);
    }
    bulb.setAttribute("aria-pressed", this.thinkOn ? "true" : "false");
    bulb.title = this.thinkOn ? "Thinking out loud is on" : "Think before answering";
    bulb.classList.toggle("on", this.thinkOn);
  }

  /* Search on by default.
   *
   * It was a switch that started off, so every conversation that wanted a
   * current fact needed a press first — and the press is invisible until you
   * know the globe means search. On is the better default: the skill only
   * costs a tool the model may ignore, and the control is right there to turn
   * it off. Once per boot, and never against a person's own choice: if
   * something is already pinned (a capability chip, a slash command, a
   * template) that pin wins.
   */
  /* The composer's Think toggle. Off, and it stays off unless someone asks:
     a reasoning model spends the same token budget on deliberating that the
     answer comes out of, and left on by default a local 8B talked itself out
     of a whole reply. So thinking is something a person turns on for a
     question that deserves it, not a tax on every "hi". */
  @state() private thinkOn = false;

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
    this.askHints(text.trim());
  }

  /* Completions, debounced.
   *
   * 140ms, which is about the gap between keystrokes at a normal typing
   * speed: fast enough that a pause produces a list, slow enough that typing
   * a word is one request rather than six. The index is a shared service and
   * a composer is the one place in this console that could ask it per
   * character.
   *
   * Only for a short prefix. Suggestions are titles out of the corpus, and
   * they answer "what is this thing called" — a question somebody is asking
   * in the first few words. Past that a person is writing a sentence, and a
   * dropdown over what they are writing is in the way.
   *
   * Never while the slash menu is up: two lists over one composer, and the
   * arrow keys would belong to neither. */
  private askHints(text: string): void {
    window.clearTimeout(this.hintTimer);
    /* Only on the empty home, never inside a conversation.
     *
     * Completions answer "what is this thing called" — the question somebody
     * is asking when they arrive with nothing on screen. Mid-conversation the
     * composer is a reply box: what goes in it is a follow-up to what is
     * above, not a title from an index, and a list of corpus titles over a
     * transcript is a suggestion about the wrong thing.
     *
     * It also settles the geometry. The docked composer has no room beneath
     * it, so a card that grows there has to grow upward over the transcript,
     * pinned by its bottom edge — a second anchoring rule, its own drift to
     * correct, and a list covering the answer somebody is reading. Not
     * offering it is better than placing it well. */
    const ask = text.length >= 2 && text.length <= 48
      && this.threadId === ""
      && this.slash === null && !text.includes("\n");
    if (!ask) { this.hints = []; this.hintAt = -1; this.hintFor = ""; return; }
    this.hintTimer = window.setTimeout(() => { void this.fetchHints(text); }, 140);
  }

  private async fetchHints(text: string): Promise<void> {
    this.hintFor = text;
    try {
      const res = await fetch(
        `/search-api/suggest?q=${encodeURIComponent(text)}&k=6`,
        { credentials: "same-origin" });
      if (!res.ok) { return; }
      const body = await res.json() as { suggestions?: { text?: string }[] };
      // The answer for a prefix nobody is typing any more is dropped rather
      // than shown: without this the list flickers back to an older word
      // whenever an earlier request lands second.
      if (this.hintFor !== text) { return; }
      const seen = new Set<string>();
      const rows: string[] = [];
      for (const one of body.suggestions ?? []) {
        const said = (one.text ?? "").trim();
        // Nothing that merely repeats what is already typed, and nothing so
        // long it wraps the row — a title of a hundred characters is not a
        // completion, it is a search result.
        if (said === "" || said.length > 72) { continue; }
        if (said.toLowerCase() === text.toLowerCase()) { continue; }
        const key = said.toLowerCase();
        if (seen.has(key)) { continue; }
        seen.add(key);
        rows.push(said);
      }
      // Six on a desktop, four on a phone. The cap above keeps the card
      // inside the screen by scrolling; this keeps it from needing to — a
      // list you have to scroll to see the fourth suggestion is a list whose
      // fourth suggestion nobody reads.
      this.hints = rows.slice(0, window.innerWidth <= 640 ? 4 : 6);
      this.hintAt = -1;
    } catch {
      // An index that cannot be reached costs suggestions and nothing else.
      this.hints = [];
    }
  }

  /** Take a suggestion — into the composer, or straight out as a message.
   *
   *  `send` is what separates a POINTER from a KEYBOARD. Pressing a row with
   *  a mouse or a thumb is a whole decision: the hand has left the keys, the
   *  row was read and chosen, and asking for one more press on a send button
   *  is asking somebody to confirm what they just did. Arrowing to a row and
   *  pressing Enter is the same decision, so that sends too — but Tab is not,
   *  it is "complete this and let me keep typing", so it fills the composer
   *  and stops there. */
  private takeHint(said: string, send = false): void {
    const box = this.composerBox();
    if (box === null) { return; }
    box.textContent = said;
    this.hints = [];
    this.hintAt = -1;
    box.focus();
    // Caret to the end, so the next keystroke continues the phrase rather
    // than landing in front of it.
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    if (send) {
      // Through the session, the way Enter in the composer goes — not by
      // synthesising a keystroke. A fake Enter would have to be aimed at the
      // component's own handler inside its shadow root, and would then be a
      // second path to sending that could drift from the first.
      box.textContent = "";
      void this.session.sendMessage(said);
    }
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
  /** Put the phone's keyboard away once a message is on its way.
   *
   *  On a touch screen the keyboard is half the viewport, and after sending
   *  there is nothing to type into — the answer is arriving above it, behind
   *  the very panel that is covering it. Every messaging app on a phone
   *  dismisses on send for this reason.
   *
   *  Only on touch, and only where a pointer is coarse. On a desktop the
   *  focus belongs where it is: sending is Enter, the next message is more
   *  typing, and stealing focus would mean reaching for the mouse between
   *  every turn. `matchMedia` rather than a width test, because the question
   *  is what is doing the pointing, not how wide the window is — a narrow
   *  desktop window has a keyboard that is already out of the way.
   *
   *  The composer lives in nr-chatbot's shadow root, so this blurs whatever
   *  the document says is active: a blur is what closes the keyboard, and
   *  activeElement is the one handle that crosses the boundary without
   *  reaching into the component's internals. */
  private dropKeyboard(): void {
    if (!window.matchMedia("(pointer: coarse)").matches) { return; }
    const active = document.activeElement as HTMLElement | null;
    active?.blur?.();
    // The component may return focus to its own input as it clears the box —
    // the blur has to land after that, or the keyboard springs straight back.
    window.setTimeout(() => {
      const again = document.activeElement as HTMLElement | null;
      again?.blur?.();
    }, 50);
  }

  /* Bound once, so the capture listener can be taken off again. */
  private readonly composerKey = (e: KeyboardEvent) => { this.onComposerKey(e); };

  private onComposerKey(e: KeyboardEvent) {
    /* The completion list answers the arrows, Enter, Tab and Escape — in
     * capture, for the reason the whole handler runs there: the component's
     * own Enter is bound inside its shadow root and would send the message
     * before a bubbling listener ever saw the key.
     *
     * Enter only takes a suggestion when one is HIGHLIGHTED. Enter with the
     * list open and nothing chosen sends what was typed, which is what a
     * person who ignored the list means by it — a list that swallows the
     * first Enter is a list that makes people afraid of it. Tab takes the
     * first suggestion without needing an arrow key first, the way a shell
     * completes. */
    if (this.hints.length > 0 && this.slash === null) {
      if (e.key === "Escape") {
        this.hints = []; this.hintAt = -1; e.stopPropagation(); return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        // The cursor walks -1 (nothing chosen) through the last row and back
        // to -1, so a person can arrow past the end and get their own typing
        // back rather than being trapped in the list. Written as a shift of
        // the whole range by one instead of two special cases at the edges.
        const n = this.hints.length;
        const step = e.key === "ArrowDown" ? 1 : -1;
        this.hintAt = ((this.hintAt + 1 + step) + (n + 1)) % (n + 1) - 1;
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        this.takeHint(this.hints[Math.max(0, this.hintAt)]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && this.hintAt >= 0) {
        e.preventDefault(); e.stopPropagation();
        this.takeHint(this.hints[this.hintAt], true);
        return;
      }
    }

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

  private searchDefaulted = false;
  private defaultSearchOn() {
    if (this.searchDefaulted) return;
    if (!this.hasSearchSkill()) return;
    this.searchDefaulted = true;
    if (this.pinned !== "") return;
    void this.pin(SEARCH_SKILL);
  }

  private hasSearchSkill(): boolean {
    return this.capabilities.some((s) => s.skillName === SEARCH_SKILL)
      || this.allSkills.some((s) => s.skillName === SEARCH_SKILL);
  }

  /* What the index holds, on hovering the globe.
   *
   * The point of the chip is that Joule searches its OWN index, and nothing
   * on the screen said so — the numbers lived on a page nobody had a reason
   * to open. A hover card puts the fact where the control is: eleven thousand
   * pages is an argument, and it is only an argument at the moment somebody
   * is deciding whether to leave search on.
   *
   * Built as a DOM string rather than a Lit template because it is mounted
   * inside nr-chatbot's shadow root, where this component does not render.
   * Everything interpolated is a number this console formatted or a two-letter
   * language code, and both are escaped anyway — the source is an API, not a
   * promise.
   *
   * position: fixed, so it needs no positioned ancestor in a tree this file
   * does not own, and it is measured off the chip each time it opens rather
   * than placed once: the composer moves with the transcript. */
  private indexCard: { at: number; body: string } | null = null;

  /** The index, as a layer over whatever is open. Same component the public
   *  page renders, same mode, so there is one description of the corpus and
   *  not two to keep in step. */
  @state() private indexOpen = false;

  private async indexBody(): Promise<string> {
    const fresh = this.indexCard !== null && Date.now() - this.indexCard.at < 60_000;
    if (fresh) return this.indexCard!.body;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
    const num = (n: number) => n.toLocaleString("en-US");
    try {
      const [s, a] = await Promise.all([
        fetch("/search-api/stats").then((r) => r.json()),
        fetch("/search-api/analytics").then((r) => r.json()),
      ]);
      const langs: { key: string; n: number }[] = (a.by_lang ?? []).slice(0, 5);
      const total: number = (a.by_lang ?? []).reduce(
        (sum: number, b: { n: number }) => sum + b.n, 0);
      const secs = Math.max(0, Math.floor(Date.now() / 1000) - (s.newest_fetch ?? 0));
      const ago = secs < 90 ? secs + "s" : secs < 5400 ? Math.round(secs / 60) + "m"
        : Math.round(secs / 3600) + "h";
      const bars = langs.map((b, i) =>
        `<i style="flex:${b.n};opacity:${(1 - i * 0.15).toFixed(2)}"></i>`).join("");
      const words = langs.map((b) =>
        `${esc(b.key || "??")} ${total > 0 ? Math.round((b.n / total) * 100) : 0}%`).join(" · ");
      const body =
        `<b>${num(s.indexed ?? 0)}</b> pages Joule indexed itself`
        + `<em>from ${num(s.domains ?? 0)} domains · newest ${ago} ago</em>`
        + `<span class="rule">${bars}</span>`
        + `<em>${esc(words)}</em>`
        // Deliberately NOT an anchor with an href. It was one, and the overlay
        // opened and then the page navigated to /stats underneath it: the
        // click is composed, so it leaves the chatbot's shadow root and
        // reaches the router, which routes on anchors and does not ask whether
        // somebody already called preventDefault. Nothing to route, nothing
        // routes.
        + `<button type="button" class="more">See the index</button>`;
      this.indexCard = { at: Date.now(), body };
      return body;
    } catch {
      // A card that cannot say anything says nothing. Not an error toast: the
      // chip still works, and the index being unreachable is not this hover's
      // news to break.
      return "";
    }
  }

  private hangIndexCard(globe: HTMLElement, chat: Element) {
    const root = chat.shadowRoot;
    if (root === null || root === undefined) return;
    let tip: HTMLElement | null = null;
    let timer = 0;
    // Whether the pointer is still on the chip. The body may be a network away
    // on the very first hover, and without this the panel appears after the
    // pointer has moved on — a card opening under somebody's mouse three
    // seconds after they left is worse than no card.
    let wanted = false;

    // Warmed as soon as the chip exists, not on the first hover. The card used
    // to open only on the SECOND try, and this is why: the first hover was
    // waiting on a tailnet round trip through the proxy, the pointer left, and
    // nothing was ever drawn. The proxy keeps its own warm copy now
    // (server/search-proxy.ts); this is the same idea one hop nearer.
    void this.indexBody();

    const close = () => {
      wanted = false;
      window.clearTimeout(timer);
      tip?.remove();
      tip = null;
    };
    const open = async () => {
      const body = await this.indexBody();
      if (body === "" || tip !== null || !wanted) return;
      tip = document.createElement("div");
      tip.className = "joule-index-tip";
      tip.innerHTML = body;
      root.appendChild(tip);
      const box = globe.getBoundingClientRect();
      // Above the chip, left-aligned to it, nudged back inside the viewport on
      // a narrow screen rather than allowed to hang off the edge.
      const width = Math.min(300, window.innerWidth - 24);
      const left = Math.max(12, Math.min(box.left, window.innerWidth - width - 12));
      tip.style.width = width + "px";
      tip.style.left = left + "px";
      tip.style.top = (box.top - 12) + "px";
      tip.addEventListener("mouseenter", () => window.clearTimeout(timer));
      tip.addEventListener("mouseleave", close);
      // Same page. A link that navigates away from a composer somebody is
      // typing into is a link that loses what they typed — and the index is a
      // thing to glance at, not a place to go.
      tip.querySelector(".more")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
        this.indexOpen = true;
      });
    };

    globe.addEventListener("mouseenter", () => {
      wanted = true;
      window.clearTimeout(timer);
      // Long enough that crossing the chip on the way to Send does not flash a
      // panel at somebody who never asked for one.
      timer = window.setTimeout(() => { void open(); }, 400);
    });
    globe.addEventListener("mouseleave", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(close, 180);
    });
    globe.addEventListener("click", close);
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
      .joule-chip { display: inline-flex; align-items: center; gap: 6px;
        height: 28px; margin-left: 2px; padding: 0 11px 0 8px;
        border: 0; border-radius: 999px; background: none; cursor: pointer;
        font: inherit; font-size: 13px; line-height: 1;
        color: var(--nuraly-chatbot-placeholder, rgba(0,0,0,.45));
        transition: background-color .15s ease, color .15s ease; }
      .joule-chip svg { flex: none; }
      .joule-chip:hover { color: var(--nuraly-chatbot-brand-fg, #17171A);
        background: var(--bg-sunken, rgba(0,0,0,.05)); }
      .joule-chip.on { color: var(--focus, #2563EB);
        background: var(--bg-user, rgba(37,99,235,.10)); }
      /* Off, the word goes and the mark stays: two labelled chips side by side
         read as a toolbar competing with the composer, and the one that is ON
         is the only one saying something about this send. The word comes back
         on hover, so a mark nobody can name is still nameable — and it is
         always in the title attribute for a screen reader either way. */
      .joule-chip:not(.on) span { display: none; }
      .joule-chip:not(.on) { padding: 0 8px; }
      .joule-chip:not(.on):hover span { display: inline; }
      .joule-chip:not(.on):hover { padding: 0 11px 0 8px; }
      /* Whoever runs out of room, it must not be paid for by drawing over a
         neighbour. The right-hand group is justify-content: flex-end with a
         min-width, so content too wide for it overflows to the LEFT — across
         the chips this sheet just added. Sizing it to its content and letting
         the chip row be the thing that gives means the failure mode is a
         clipped chip, which is legible, instead of two labels in one place,
         which is not. */
      /* The index card. transform: translateY(-100%) rather than a measured
         height, so it sits on the chip's top edge whatever it ends up
         containing. */
      .joule-index-tip {
        position: fixed; z-index: 60; transform: translateY(-100%);
        display: flex; flex-direction: column; gap: 5px;
        padding: 12px 14px; border-radius: 13px;
        background: var(--bg-card, #fff); color: var(--fg, #17171A);
        border: 1px solid var(--border, rgba(0,0,0,.10));
        box-shadow: 0 16px 40px -14px rgba(0,0,0,.34);
        font-size: 12.5px; line-height: 1.45;
        animation: joule-tip-in .13s cubic-bezier(.23,1,.32,1); }
      @keyframes joule-tip-in {
        from { opacity: 0; transform: translateY(calc(-100% + 5px)); }
        to { opacity: 1; transform: translateY(-100%); } }
      .joule-index-tip b { font-size: 15px; font-weight: 600;
        font-variant-numeric: tabular-nums; }
      .joule-index-tip em { font-style: normal;
        color: var(--muted, rgba(0,0,0,.45)); font-size: 11.5px; }
      .joule-index-tip .rule { display: flex; gap: 2px; height: 6px; margin: 2px 0 1px;
        border-radius: 999px; overflow: hidden;
        background: var(--bg-sunken, rgba(0,0,0,.05)); }
      .joule-index-tip .rule i { background: currentColor; min-width: 2px; }
      .joule-index-tip .more { margin-top: 3px; font: inherit; font-size: 12px;
        color: inherit; background: none; border: 0; cursor: pointer; padding: 0 0 1px;
        border-bottom: 1px solid var(--border, rgba(0,0,0,.18));
        align-self: flex-start; }
      .joule-index-tip .more:hover { border-color: currentColor; }
      @media (prefers-reduced-motion: reduce) {
        .joule-index-tip { animation: none; } }
      .action-buttons-right { flex: none; }
      .action-buttons-left { min-width: 0; overflow: hidden; }
      /* A shorter box on a phone — IN A CONVERSATION. The component opens
         with two lines of writing room (3.5rem); over a transcript on a
         390x844 screen that is composer eating reading room, so it drops to
         a line and a half there. The HOME SCREEN keeps the full height: the
         composer is the page there, and shrinking it read as the product
         getting smaller. .talking is the class the console already stamps
         when messages exist. */
      @media (max-width: 640px) {
        :host(.talking) .input-box__input { min-height: 2.25rem; }
        :host(.talking) .input-container { padding-top: 4px; padding-bottom: 4px; }
      }
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
    // Opening one from the rail is reading, not composing: it gets the page.
    this.compact = false;
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
    this.takeComposer();
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
    this.compact = true;
    this.route("");
    this.threadId = ""; this.turnRefs = []; this.railClosed = false; this.session.fresh();
    this.takeComposer();
  }

  /* Put the caret where the person is about to type.

     Opening a conversation, or starting one, is a person saying they intend to
     write — and every other chat surface acts on that. Without it the first
     keystroke goes nowhere and has to be typed twice.

     Deferred past the render that is about to happen: the composer lives in
     another component's shadow root and, on a fresh conversation, is not on
     screen at the moment this is called. Skipped where a pointer is not the
     input method — focusing on a phone raises the keyboard over the
     conversation somebody just opened to read. */
  private takeComposer(): void {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) { return; }
    void this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        const box = this.composerBox();
        if (box === null) { return; }
        // Not while a dialog owns the screen: the directory and the settings
        // overlay both take focus for their own controls, and stealing it back
        // would fight them.
        if (this.gallery !== "" || this.indexOpen) { return; }
        box.focus();
      });
    });
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
    this.agents = listed.filter((a) => a.enabled).filter(offerable);
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
    const a = this.agents.find((x) => x.id === this.agentId);
    // The default agent speaks as the product. "Ask assistant…" names an
    // implementation detail; "Ask Joule…" names the thing on the sign. A
    // NON-default agent keeps its own name — a person who chose docflow
    // deserves to see which mouth they are talking into.
    if (a === undefined || a.isDefault) { return BRAND; }
    return a.agentName;
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

  /* The attach menu, drawn here rather than by the component.

     `attachItems` is {id, label, icon} and nothing else, which is right for a
     list of actions and wrong for a menu that has to carry switches. Turning a
     connector off is something people do mid-conversation and for that
     conversation's reasons — this one is noisy, that one is slow, I do not
     want the model touching Linear for this question — and a menu that cannot
     express it sends them to a settings tab, which means they do not bother
     and ask a model holding tools it should not have.

     nr-dropdown has taken arbitrary content in its `content` slot all along;
     what was missing was a slot in nr-chatbot to reach it, which the component
     now has behind `custom-attach-menu`. Light DOM, so these are this
     component's own styles and events. */
  private attachPanel() {
    return html`
      <div class="attach" slot="attach-menu" role="menu"
        @mouseleave=${() => { this.attachSub = ""; }}>
        <button class="attach-row" role="menuitem"
          @mouseenter=${() => { this.attachSub = ""; }}
          @click=${() => this.pickFile()}>
          <nr-icon name="paperclip" size="small"></nr-icon><span class="attach-label">Add files &amp; photos</span>
        </button>
        <!-- A chevron promises a submenu, so it has to open one. It used to
             open the full directory overlay, which appeared BEHIND this
             dropdown and left the menu sitting on top of the thing it had just
             opened. Skills flies out; "Manage connectors" is a destination and
             loses its chevron. -->
        <div class="attach-sub">
          <button class=${this.attachSub === "skills" ? "attach-row open" : "attach-row"}
            role="menuitem" aria-haspopup="menu"
            aria-expanded=${this.attachSub === "skills" ? "true" : "false"}
            @mouseenter=${(e: Event) => this.openSub("skills", e, true)}
            @click=${(e: Event) => { e.stopPropagation(); this.openSub("skills", e); }}>
            <nr-icon name="zap" size="small"></nr-icon><span class="attach-label">Skills</span>
            <nr-icon class="go" name="chevron-right" size="small"></nr-icon>
          </button>
          ${this.attachSub !== "skills" ? nothing : this.skillFlyout()}
        </div>
        <!-- The half-written message, made recurring. Reached from the
             composer because that is where the sentence already is: a person
             who has typed "summarise my Linear cycle" and then wants it every
             morning should not have to type it again somewhere else.

             The draft is READ out of the chatbot's shadow root and never
             written to. The component is vendored and is not ours to patch;
             what it offers is this slot, and taking a copy of what is on
             screen is the whole of what this needs. -->
        <button class="attach-row" role="menuitem"
          @mouseenter=${() => { this.attachSub = ""; }}
          @click=${() => {
            const draft = this.draftText();
            this.shutAttach();
            this.taskDraft = draft;
            this.goTasks();
          }}>
          <nr-icon name="clock" size="small"></nr-icon><span class="attach-label">Schedule this</span>
        </button>
        <button class="attach-row" role="menuitem"
          @mouseenter=${() => { this.attachSub = ""; }}
          @click=${() => { this.shutAttach(); this.openSettings("Connectors"); }}>
          <nr-icon name="share" size="small"></nr-icon><span class="attach-label">Manage connectors</span>
        </button>
        ${this.servers.length === 0 ? nothing : html`
          <div class="attach-rule"></div>
          ${this.servers.map((s) => this.attachConnector(s))}`}
      </div>`;
  }

  /* Going to the task page.
   *
   *  A push and not a replace: /tasks is a place, so Back returns to whatever
   *  was on screen — the conversation, usually — exactly as it does for
   *  Settings. The path is pushed only when it is not already the address,
   *  because arriving ON /tasks runs this too and a duplicate entry means one
   *  Back press that appears to do nothing. */
  private goTasks(): void {
    this.view = "tasks";
    if (location.pathname !== "/tasks") { history.pushState({ tasks: true }, "", "/tasks"); }
  }

  /* What is in the composer right now, or "".

     Read through the chatbot's shadow root, the same way `composerCard` finds
     the input card. `document.querySelector` answers null for anything in
     here — every one of these elements lives in a shadow root — and the
     component exposes no property for its draft. Reading is where this stops:
     writing into somebody else's shadow DOM is how a vendored component gets
     patched by accident. */
  private draftText(): string {
    const chat = this.renderRoot.querySelector("nr-chatbot") as Element | null;
    const box = chat?.shadowRoot?.querySelector("[contenteditable]") as HTMLElement | null;
    return (box?.innerText ?? "").trim();
  }

  /* The skills submenu.

     A flyout beside the menu rather than the directory overlay: pinning a
     skill is a one-press decision made while composing, and sending the whole
     screen to a dialog for it loses the message being written. The directory
     is still there for reading what a skill does — that is a different errand
     and it has its own door. */
  private skillFlyout() {
    // Filtered on name AND description: half of what you remember about a
    // skill is what it does rather than what it is called, so "spreadsheet"
    // has to find make-sheet. The same rule the directory's own filter uses.
    const find = this.subFind.trim().toLowerCase();
    const skills = find === ""
      ? this.allSkills
      : this.allSkills.filter((k) =>
          (k.skillName + " " + k.description).toLowerCase().includes(find));
    return html`
      <div class="fly" role="menu"
        style=${`left:${this.subAt.x}px; top:${this.subAt.y}px; width:${this.subW}px`}>
        <!-- Thirteen is past the number you can find one in by reading, and
             the flyout scrolls at eight. -->
        ${this.allSkills.length < 6 ? nothing : html`
          <div class="fly-find">
            <nr-icon name="search" size="small"></nr-icon>
            <input type="text" .value=${this.subFind} placeholder="Find a skill"
              aria-label="Find a skill"
              @click=${(e: Event) => e.stopPropagation()}
              @input=${(e: Event) => {
                this.subFind = (e.target as HTMLInputElement).value; }}>
          </div>`}
        ${this.allSkills.length === 0
          ? html`<p class="fly-none">No skills on this deployment.</p>`
          : skills.length === 0
            ? html`<p class="fly-none">Nothing matches “${this.subFind.trim()}”.</p>`
            : skills.map((k) => html`
              <button class=${this.pinned === k.skillName ? "attach-row on" : "attach-row"}
                role="menuitemcheckbox"
                aria-checked=${this.pinned === k.skillName ? "true" : "false"}
                title=${k.description}
                @click=${() => { void this.pin(k.skillName); this.attachSub = ""; }}>
                <span class="attach-label">${k.skillName}</span>
                ${this.pinned === k.skillName
                  ? html`<nr-icon name="check" size="small"></nr-icon>`
                  : nothing}
              </button>`)}
      </div>`;
  }

  /* Open a submenu, anchored to the row that owns it.

     Fixed to the viewport and positioned from the row's own rect, because the
     dropdown's menu container clips its overflow: an absolutely-positioned
     flyout beside the panel measured correctly, reported itself on screen, and
     was invisible — the box was there and the pixels were cut off. Fixed
     escapes the clip; the coordinates are the price. */
  private openSub(which: string, e: Event, hovering = false): void {
    // Hover opens and never closes ITSELF: a pointer crossing this row on its
    // way down would otherwise flicker the submenu open and shut. What closes
    // it is landing on a DIFFERENT row — each sibling clears `attachSub` on
    // mouseenter — or clicking, or leaving the menu. Without that the flyout
    // stayed open over the rows below it, so the menu showed two levels at
    // once and the pointer was inside neither.
    if (this.attachSub === which) { if (!hovering) { this.attachSub = ""; } return; }
    this.subFind = "";
    const button = e.currentTarget as HTMLElement;
    const row = button.getBoundingClientRect();
    // Beside the PANEL, not beside the row: the row ends inside the menu, so
    // anchoring to it opened the flyout over the connectors underneath. The
    // top still comes from the row, which is what makes it read as belonging
    // to that line rather than to the menu as a whole.
    const panel = button.closest(".attach")?.getBoundingClientRect() ?? row;

    // On a phone there is no room beside anything, so the submenu takes the
    // parent's own footprint and reads as a drill-down. Flipping it to the
    // left instead put a 224px card diagonally across the menu it came from,
    // which is legible but looks like two menus fighting.
    if (window.innerWidth < 560) {
      this.subAt = { x: Math.round(panel.left), y: Math.round(panel.top) };
      this.subW = Math.round(panel.width);
      this.attachSub = which;
      return;
    }

    let x = panel.right + 6;
    const width = 224;
    // Flipped where there is no room to the right — a wide phone in landscape,
    // a narrow window. A submenu that opens off-screen is one nobody can use.
    if (x + width > window.innerWidth - 8) { x = Math.max(8, panel.left - width - 6); }
    this.subW = width;
    this.subAt = { x, y: Math.max(8, row.top - 4) };
    this.attachSub = which;
  }

  /* One connector in the menu: its mark, its name, and a switch.

     A connector that authenticates but has nothing stored gets the warning
     rather than the switch — it is on, it looks configured, and every tool
     call it is asked for will fail. That is the state worth interrupting for,
     and it is the one the reference marks the same way. */
  private attachConnector(s: ServerRow) {
    const entry = CATALOGUE.find((e) => e.endpoint === s.endpoint);
    const held = this.connections.get(s.id);
    const unusable = s.authKind !== "" && s.authKind !== "none"
      && (held?.state ?? "none") === "none";
    return html`
      <div class="attach-row conn-row" role="menuitem"
        @mouseenter=${() => { this.attachSub = ""; }}>
        <span class="attach-mark" style=${entry === undefined ? "" : `color:${entry.tint}`}>
          ${entry === undefined
            ? html`<nr-icon name="plug" size="small"></nr-icon>`
            : brandMark(entry)}
        </span>
        <span class="attach-label">${s.serverName}</span>
        ${unusable
          ? html`<button class="attach-warn" title="Not connected — sign in to use it"
              @click=${() => void this.connectConnector2(s)}>
              <nr-icon name="warning" size="small"></nr-icon></button>`
          : html`<button class=${s.enabled ? "sw on" : "sw"} role="switch"
              aria-checked=${s.enabled ? "true" : "false"}
              aria-label=${(s.enabled ? "Disable " : "Enable ") + s.serverName}
              @click=${() => void this.toggleConnector(s)}><span></span></button>`}
      </div>`;
  }

  /* The component owns the file input; this reaches its button rather than
     building a second one, so there is one upload path and one set of
     accepted types. */
  private pickFile(): void {
    const chat = this.renderRoot.querySelector("nr-chatbot") as Element | null;
    const input = chat?.shadowRoot?.querySelector("input[type=file]") as HTMLInputElement | null;
    input?.click();
  }

  /* Close the composer's attach dropdown.

     The dropdown belongs to nr-chatbot, so there is no element here to hide —
     but it exposes `open` as a property, and setting it is what a host is
     meant to do. Without this, "Manage connectors" opened the directory and
     left the menu sitting on top of it, which is the same complaint the Skills
     row earned before it grew a submenu. */
  private shutAttach(): void {
    this.attachSub = "";
    const chat = this.renderRoot.querySelector("nr-chatbot") as Element | null;
    const dd = chat?.shadowRoot?.querySelector("nr-dropdown") as
      (Element & { open?: boolean }) | null;
    if (dd !== null && dd !== undefined) { dd.open = false; }
  }

  /* Copy, for the buttons a card renders as a string.

     A card is HTML handed to the chatbot as text, so nothing in it can carry
     a Lit handler — there is no element here to bind one to. The click is
     composed, though, so composedPath() carries the button out of two shadow
     roots to this listener, and the passage rides on the button's own
     attribute rather than being read back off the DOM: text extraction
     collapses line breaks and resolves entities its own way, and the whole
     point of the button is that it copies exactly what the card shows.

     Bound once, on the host, rather than per card. */
  private onCopyCard = (e: Event): void => {
    const hit = e.composedPath().find((n) =>
      n instanceof HTMLElement && n.hasAttribute("data-copy-card")) as HTMLElement | undefined;
    if (hit === undefined) { return; }
    e.preventDefault();
    e.stopPropagation();
    const text = hit.getAttribute("data-copy-card") ?? "";
    const fallback = (t: string) => AgentConsole.copyTheOldWay(t);
    const said = (word: string) => {
      const was = hit.textContent;
      hit.textContent = word;
      window.setTimeout(() => { hit.textContent = was; }, 1400);
    };
    // navigator.clipboard is UNDEFINED on an insecure origin, not merely
    // refusing — so calling it throws where a rejected promise was expected,
    // and the button did nothing at all with no error a person could see.
    // joule.sh is https and has it; a LAN address or a plain-http preview does
    // not, and those are exactly where this gets tested.
    const api = navigator.clipboard;
    if (api !== undefined && typeof api.writeText === "function") {
      void api.writeText(text).then(() => said("Copied"), () => said(fallback(text) ? "Copied" : "Press ⌘C"));
      return;
    }
    said(fallback(text) ? "Copied" : "Press ⌘C");
  };

  /* The copy that works without the Clipboard API.
   *
   *  A hidden textarea and execCommand("copy"). Deprecated, and the only thing
   *  available on an insecure origin — which is every LAN address and every
   *  plain-http preview of this console. Returns whether it took. */
  private static copyTheOldWay(text: string): boolean {
    try {
      const pad = document.createElement("textarea");
      pad.value = text;
      // Off-screen rather than hidden: display:none and visibility:hidden are
      // both unselectable, and selection is the whole mechanism.
      pad.setAttribute("readonly", "");
      pad.style.position = "fixed";
      pad.style.top = "-1000px";
      pad.style.opacity = "0";
      document.body.appendChild(pad);
      pad.select();
      const took = document.execCommand("copy");
      document.body.removeChild(pad);
      return took;
    } catch { return false; }
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
    // `?? null` for the reason composerCard() spells out: the optional chain
    // yields undefined and the cast claims null, so a caller's `=== null`
    // check passes something that is not an element.
    return (chat?.shadowRoot?.querySelector(".input-box__input") as HTMLElement | null) ?? null;
  }

  /** The composer's own bordered box — `.input-container`, the element that
   *  draws the rounded outline a person sees. `.input-box` is its outer
   *  wrapper and carries padding, which is why joining to that one left a
   *  band of empty space while every measurement said the edges met. The
   *  completion rows are appended INTO this, so the card encloses them. */
  private composerCard(): HTMLElement | null {
    const chat = this.renderRoot.querySelector("nr-chatbot") as Element | null;
    // `?? null`, and it is load-bearing. An optional chain that short-circuits
    // yields UNDEFINED; the cast on the end says null. Every caller checks
    // `=== null`, so undefined walks past all of them and the next line reads
    // a property off it.
    //
    // There is no chatbot exactly when the centre column is something else —
    // the Knowledge page and the Starting points page — so this fires on those
    // two screens and nowhere else, from `updated`, several times per visit.
    // The screens look fine while filling the console with uncaught errors.
    //
    // This has now been fixed twice: once when joinHints threw on it, and
    // again after the function was edited for `.input-container` and the cast
    // came back with the edit. If it is touched a third time, keep the `??`.
    return (chat?.shadowRoot?.querySelector(".input-container") as HTMLElement | null) ?? null;
  }


  /* The completion list, INSIDE the composer's own box.
   *
   * Not a panel under it. The design this follows is one card that grows: the
   * field, a full-width hairline, then the suggestions — one border around
   * all of it, no second rounded box, no seam to align. Every version of this
   * that positioned a separate element next to the composer was two boxes
   * pretending, and it read as two boxes however carefully the edges were
   * measured, because it was two boxes.
   *
   * So the rows are appended into `.input-container` in nr-chatbot's shadow
   * root — the element that draws the border — and the card encloses them
   * because they are its children. Built with DOM calls rather than a Lit
   * template: this is somebody else's shadow root, Lit renders into roots it
   * owns, and a template here would need its own render target inside a tree
   * the component rebuilds. `textContent` for every string, so a suggestion
   * cannot carry markup even though it comes from our own index.
   *
   * Rebuilt only when the rows or the cursor actually change — `updated` runs
   * on every render, and rebuilding this on each keystroke would take the
   * focus out of the field mid-word. */
  private hintsDrawn = "";
  private drawHints(): void {
    const card = this.composerCard();
    if (card === null) { return; }
    // The column that holds the wordmark and the composer. `main.empty` is a
    // centred flex, so anything that grows inside it moves everything above
    // it upward — see the pin below.
    const column = this.renderRoot.querySelector("main") as HTMLElement | null;

    const held = card.querySelector(".joule-hints") as HTMLElement | null;
    const want = this.hints.length === 0 ? "" : `${this.hintAt}:${this.hints.join("\u0000")}`;
    if (want === this.hintsDrawn && (want === "") === (held === null)) { return; }
    this.hintsDrawn = want;

    if (this.hints.length === 0) {
      held?.remove();
      // Give the column back to the layout.
      card.style.transform = "";
      if (column !== null) {
        column.style.justifyContent = "";
        column.style.paddingTop = "";
      }
      return;
    }

    /* Hold the whole column still, not just the card.
     *
     * `main.empty` centres the wordmark and the composer as one group, so a
     * card that grows pushes BOTH up by half its growth — the wordmark drifts
     * toward the top of the window and the line being typed slides out from
     * under the cursor. An earlier version pinned the card alone with a
     * transform, which fixed the field and left the wordmark moving: the same
     * bug, half solved, and more obvious for it.
     *
     * So the centring is swapped for the offset it had produced, measured the
     * moment the list opens and held for as long as it is open. Everything
     * above the card stays exactly where it was and the card grows downward
     * into the space below, which is what centring was going to leave empty
     * anyway. */
    if (column !== null && held === null) {
      const free = Math.round(
        (column.firstElementChild?.getBoundingClientRect().top ?? 0)
        - column.getBoundingClientRect().top);
      if (free > 0) {
        column.style.justifyContent = "flex-start";
        column.style.paddingTop = `${free}px`;
      }
    }

    const box = held ?? document.createElement("div");
    box.className = "joule-hints";
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", "Suggestions");
    box.textContent = "";

    const typed = (this.composerBox()?.textContent ?? "").trim();
    for (const [i, said] of this.hints.entries()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = i === this.hintAt ? "joule-hint on" : "joule-hint";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === this.hintAt ? "true" : "false");

      const mark = document.createElement("span");
      mark.className = "joule-hint-mark";
      mark.textContent = "\u2315"; // a magnifier, drawn as text: no icon set reaches in here
      row.append(mark);

      const text = document.createElement("span");
      text.className = "joule-hint-text";
      // What was typed, held back; the completion in the reading weight. Two
      // spans and textContent, so the split can never become markup.
      if (typed !== "" && said.toLowerCase().startsWith(typed.toLowerCase())) {
        const had = document.createElement("span");
        had.className = "joule-hint-had";
        had.textContent = said.slice(0, typed.length);
        const rest = document.createElement("b");
        rest.textContent = said.slice(typed.length);
        text.append(had, rest);
      } else {
        text.textContent = said;
      }
      row.append(text);

      // The pointer chooses AND sends — see takeHint. mousedown is prevented
      // so the field does not lose focus before the click lands.
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => { void this.takeHint(said, true); });
      box.append(row);
    }

    if (held === null) { card.append(box); }

    /* How tall the list may be, measured against what is actually visible.
     *
     * The card grows to hold its rows, and on a phone six rows plus the field
     * and the tool row is taller than the screen — so the card outgrew the
     * viewport and pushed the very field being typed in off the top. A
     * suggestion list that hides the words it is completing is worse than no
     * list.
     *
     * `visualViewport` and not `vh`: with a keyboard up, vh is still the
     * whole screen and the space a person can see is roughly half of it. What
     * is left for the list is whatever the visible viewport has after the
     * field, the tool row and a margin — floored, so it never collapses to
     * nothing, and only applied when it actually bites. */
    const view = window.visualViewport?.height ?? window.innerHeight;
    const above = card.getBoundingClientRect().top;
    const room = Math.round(view - above - 140);
    box.style.maxHeight = `${Math.max(132, room)}px`;

    // And if the card still runs past the bottom — a docked composer in a
    // conversation grows upward, but a centred one on the home screen grows
    // both ways — bring it back into view rather than leaving the person
    // typing at an edge they cannot see.
    // And if the card still runs past an edge — a phone with the keyboard up
    // has little room either way — bring it back rather than leaving somebody
    // typing at an edge they cannot see.
    const after = card.getBoundingClientRect();
    if (after.bottom > view || after.top < 0) {
      card.scrollIntoView({ block: "nearest" });
    }
  }

  private slashMenu() {
    if (this.slash === null) return nothing;
    const rows = this.slashMatches();
    if (rows.length === 0) return nothing;
    // Sat above the composer, measured rather than assumed.
    //
    // It was `bottom: 132px` against the viewport, which is right in a
    // conversation — the composer is docked at the bottom — and wrong on the
    // empty screen, where the composer is centred and the menu appeared far
    // below it with the page showing through the gap.
    const box = this.composerBox()?.getBoundingClientRect();
    const above = box === undefined
      ? ""
      : `bottom:${Math.max(12, Math.round(window.innerHeight - box.top + 12))}px`;
    return html`
      <div class="slash" role="listbox" aria-label="Skills" style=${above}>
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
  /* Read a skill: its briefing, and the scripts it stages into a run. The
     files are fetched per skill and not held — a skill is edited in place, so
     a cached copy is a copy that can be wrong, and this is one small request
     behind a deliberate press. */
  private async showSkill(name: string): Promise<void> {
    // A gallery row carries the skill's NAME — it is what pin() speaks and
    // what use_skill resolves — while files hang off the id, so the row has
    // to be found before anything can be asked for.
    const row = this.allSkills.find((s) => s.skillName === name);
    this.skillOpen = name;
    this.skillFiles = [];
    if (!row) return;
    this.skillFiles = await listSkillFiles(row.id).catch(() => []);
  }

  /* The open skill's own row, or null. */
  private openSkillRow(): SkillRow | null {
    return this.allSkills.find((s) => s.skillName === this.skillOpen) ?? null;
  }

  /* What a skill IS: the briefing the model is handed, and the scripts staged
     into its runs at /skills/<name>/. Read-only on purpose — editing lives in
     Settings, and a reader who opened this wanted to know what the thing does
     before pinning it. */
  private skillDetail() {
    const row = this.openSkillRow();
    if (row === null) return nothing;
    return html`
      <div class="skill-open">
        <div class="skill-open-head">
          <button class="icon" title="Back" @click=${() => { this.skillOpen = ""; }}>
            <nr-icon name="chevron-left" size="medium"></nr-icon>
          </button>
          <span class="skill-open-name">${row.skillName}</span>
          <button class="pin-now" @click=${() => { void this.pin(row.skillName); this.skillOpen = ""; this.gallery = ""; }}>
            ${this.pinned === row.skillName ? "Pinned" : "Use in this chat"}
          </button>
        </div>
        <div class="skill-open-body">
          <p class="skill-open-why">${row.description}</p>
          <div class="skill-open-label">Instructions</div>
          <pre class="skill-open-text">${row.body ?? ""}</pre>
          ${this.skillFiles.length === 0 ? nothing : html`
            <div class="skill-open-label">
              Scripts<span class="gallery-count">${this.skillFiles.length}</span>
            </div>
            ${this.skillFiles.map((f) => html`
              <details class="skill-file">
                <summary>${f.path}</summary>
                <pre class="skill-open-text">${f.body}</pre>
              </details>`)}`}
        </div>
      </div>`;
  }

  /** Which tab the Settings overlay opens on. */
  @state() private settingsTab = "Preferences";

  /* Set by pages/settings/[[tab]].ts, which is the /settings route. A
     property rather than a router read: the console is mounted by three
     different pages and none of the others should have to know this exists.
     Empty — every other page — leaves Settings closed, as before. */
  @property({ attribute: false }) openSettingsAt = "";

  /* Arriving ON an article's own address, handed in by pages/discover/[id].ts.
   * A property rather than a router read, for the reason `openSettingsAt`
   * carries: the console is mounted by several pages and none of the others
   * should have to know this exists. Empty — every other page — leaves the
   * console where it was. */
  @property({ attribute: false }) openArticleAt = "";

  /* Which screen this page IS, decided by the route rather than by a click.
   *
   * A property and not a `location.pathname` read, and that difference is
   * what makes these routes server-render at all: `connectedCallback` never
   * runs on the server, so a view chosen there is a view the first paint does
   * not have. `willUpdate` runs in both places, reads this, and the server
   * emits the real screen instead of an empty shell that fills in a beat
   * later. Empty — the conversation routes — leaves the console on chat. */
  @property({ attribute: false }) startView = "";

  /** The Discover feeds, read by the route's loader. Same bargain as
   *  `seedTurns`: on screen in the first frame, then refreshed by the element
   *  itself so a page held open does not go stale. */
  @property({ attribute: false }) seedFeeds: unknown = null;

  /** One article, likewise. */
  @property({ attribute: false }) seedArticle: unknown = null;

  /* Open Settings, and put it in the address bar.
   *
   * The directory overlay (the Skills/Agents/Connectors tabs) is for picking
   * something mid-sentence — it hands the conversation a skill or an agent
   * and closes. Settings is where those things are MANAGED, and the two had
   * drifted into answering the same questions from two different surfaces:
   * the rail's Agents row opened the picker, so "change what this agent can
   * reach" needed a different door than the one you had just used.
   *
   * So the rail goes to Settings, and Settings has an address: /settings and
   * /settings/<tab>. A panel worth linking to is worth a URL — and the back
   * button then closes it, which is what every person tries first. */
  private openSettings(tab: string) {
    this.settingsTab = tab;
    this.settings = true;
    this.gallery = "";
    const path = tab === "Preferences" ? "/settings" : `/settings/${tab.toLowerCase()}`;
    if (location.pathname !== path) {
      history.pushState({ settings: tab }, "", path);
    }
  }

  /** Close Settings and give the address back to the conversation. */
  private closeSettings() {
    this.settings = false;
    if (location.pathname.startsWith("/settings")) {
      const back = this.threadId === "" ? "/" : `/c/${this.threadId}`;
      history.pushState({}, "", back);
    }
  }

  /* Open an article, and put it in the address bar.
   *
   * Settings' bargain, for the same reason: a story is a thing people send
   * each other, so it needs a URL, and once it has one Back has to close it.
   * `/discover/<id>` is served by a route of its own (pages/discover/[id].ts)
   * so a cold link lands here rather than on a 404 — but a click from the
   * feed never navigates, it pushes. */
  private openArticle(id: string) {
    this.articleId = id;
    this.view = "article";
    this.nav = false;
    const path = `/discover/${encodeURIComponent(id)}`;
    if (location.pathname !== path) {
      history.pushState({ article: id }, "", path);
    }
  }

  /* Switch to a screen AND put it in the address bar.
   *
   * The rail used to flip `view` and leave the URL alone, so every standalone
   * screen was a place you could be and not a place you could link to — Back
   * left the app, a reload lost where you were, and /tasks answered the chat
   * home. One call does both now, and the route files under pages/ answer the
   * same addresses cold. */
  private go(view: string, path: string) {
    this.view = view as typeof this.view;
    if (location.pathname !== path) { history.pushState({ view }, "", path); }
  }

  /** Back to the feed, and give the address back to it. */
  private closeArticle() {
    this.view = "discover";
    this.articleId = "";
    if (location.pathname.startsWith("/discover/")) {
      history.pushState({}, "", "/discover");
    }
  }

  private openShelf(shelf: Shelf) {
    this.galleryFind = "";
    this.skillOpen = "";
    this.gallery = shelf;
    // The drawer is a layer, and so is this. On a phone the two stacked, so
    // the panel a person had just asked for opened UNDER the menu they asked
    // from and looked like nothing had happened. Every door into a panel
    // closes the drawer behind it; the desktop rail is not a drawer, so
    // clearing the flag there costs nothing and means nothing.
    this.nav = false;
    // Which connectors this person is signed in to, asked whenever the shelf
    // that draws it is opened rather than on every page load: it is one
    // request, and it is only ever read here.
    if (shelf === "connectors") { void this.loadConnections(); }
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
      this.cardPlugins = await listCardPlugins().catch(() => []);
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
    // Both kinds, in one shelf. A card plugin says so in its provenance line
    // rather than in a fifth tab: what a person wants from this list is "what
    // did I install", and splitting that by which table it landed in is the
    // implementation talking.
    const cards: GalleryRow[] = this.cardPlugins.map((p) => ({
      key: p.id, name: p.pluginName, why: p.description,
      on: false, icon: "credit-card", source: "repo", id: p.id,
      from: (p.enabled ? "Cards" : "Cards · off")
        + (p.version === "" ? "" : " · v" + p.version),
    }));
    return cards.concat(this.plugins.map((p) => ({
      key: p.id, name: p.pluginName, why: p.description, on: false,
      icon: "cube", source: "repo", id: p.id,
      from: p.version === "" ? "Installed" : "Installed · v" + p.version,
    })));
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
      <div class="scrim shelves" @click=${() => { this.gallery = ""; this.skillOpen = ""; }}></div>
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
                @click=${() => { this.galleryFind = ""; this.skillOpen = ""; this.gallery = t; }}>
                ${t === "skills" ? "Skills" : t === "agents" ? "Agents"
                  : t === "connectors" ? "Connectors" : "Plugins"}
                <span class="gallery-count">${this.shelfRows(t).length}</span>
              </button>`)}
          </div>
          <button class="icon" title="Close" @click=${() => { this.gallery = ""; }}>
            <nr-icon name="x" size="medium"></nr-icon>
          </button>
        </div>
        ${this.skillOpen !== "" && shelf === "skills" ? this.skillDetail() : html`
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
        ${shelf === "connectors"
          ? this.connectorsShelf()
          : rows.length === 0
            ? html`<p class="gallery-none">${empty}</p>`
            : shown.length === 0
              ? html`<p class="gallery-none">Nothing matches
                  “${this.galleryFind.trim()}”.</p>`
              : html`${this.galleryGroups(shown, shelf)}`}`}
      </div>`;
  }

  /* Connectors: the ones you have, then the ones you can sign in to.
     One scrolling column holding two grids, and neither grid scrolls — the
     rule the skills shelf already follows, and the reason is the same. A
     `.gallery-list` is itself the scroller, so a second block placed after one
     competes with it for the panel's height: the first grid was squeezed to
     52px and its cards were clipped mid-card by the overflow that makes it
     scroll. Under a heading the column is the scroller and both grids are
     `flat`. */
  private connectorsShelf() {
    return html`
      <div class="gallery-scroll">
        ${this.servers.length === 0
          ? nothing
          : html`
            <div class="gallery-group">Yours
              <span class="gallery-count">${this.servers.length}</span></div>
            <div class="conn-list">${this.servers.map((s) => this.connectorRow(s))}</div>`}
        <div class="gallery-group">Ready to connect</div>
        <mcp-gallery
          .taken=${this.servers.map((s) => s.endpoint)}
          .status=${this.connectorStatus()}
          @add-server=${(e: CustomEvent) => void this.addConnector(e.detail)}
          @connect-entry=${(e: CustomEvent) => void this.connectConnector(e.detail as CatalogueEntry)}
        ></mcp-gallery>
        ${this.connectProblem === "" ? nothing
          : html`<p class="shelf-problem">${this.connectProblem}</p>`}
      </div>`;
  }

  /* The brand mark for a configured connector, matched to the catalogue on
     address. The endpoint and not the name: a person may rename a connector,
     and what decides whether this row and that card are the same service is
     where they point. */
  private markFor(shelf: Shelf, r: GalleryRow) {
    if (shelf === "connectors") {
      const server = this.servers.find((s) => s.id === r.key || s.serverName === r.name);
      const entry = server === undefined ? undefined
        : CATALOGUE.find((e) => e.endpoint === server.endpoint);
      if (entry !== undefined) {
        return html`<span class="pick-tile brandy" style=${`color:${entry.tint}`}
          >${brandMark(entry)}</span>`;
      }
    }
    return html`<span class="pick-tile"><nr-icon name=${r.icon} size="small"></nr-icon></span>`;
  }

  /* One connector, with the two switches that decide what it costs.

     A connector is off, on, or on-with-some-tools-off, and the last is not a
     refinement — it is what makes a big connector usable at all. Linear offers
     52 tools and each one's JSON Schema goes into every prompt: mounted whole,
     they put more in front of Qwen 3 8B than it can hold, and it refused the
     request outright rather than answering worse. So the tool list is not an
     advanced screen tucked away somewhere; it is on the row, one press down. */
  private connectorRow(s: ServerRow) {
    const entry = CATALOGUE.find((e) => e.endpoint === s.endpoint);
    const held = this.connections.get(s.id);
    const open = this.toolsOpen === s.id;
    const listed = this.toolList.get(s.id);
    return html`
      <div class="conn">
        <div class="conn-top">
          <span class="conn-mark" style=${entry === undefined ? "" : `color:${entry.tint}`}>
            ${entry === undefined
              ? html`<nr-icon name="plug" size="small"></nr-icon>`
              : brandMark(entry)}
          </span>
          <span class="conn-name">${s.serverName}</span>
          ${s.authKind !== "oauth" ? nothing
            : (held?.state ?? "none") === "none"
              ? html`<button class="conn-connect"
                  @click=${() => void this.connectConnector2(s)}>Connect</button>`
              : (held?.state === "stale"
                ? html`<button class="conn-connect"
                    @click=${() => void this.connectConnector2(s)}>Reconnect</button>`
                : html`<span class="conn-ok">signed in</span>`)}
          <!-- The connector's own switch. Off means the agent is never told it
               exists, which is the honest meaning of "disabled" and the reason
               it is a switch rather than a delete: turning it back on should
               not mean signing in again. -->
          <button class=${s.enabled ? "sw on" : "sw"} role="switch"
            aria-checked=${s.enabled ? "true" : "false"}
            aria-label=${(s.enabled ? "Disable " : "Enable ") + s.serverName}
            @click=${() => void this.toggleConnector(s)}><span></span></button>
        </div>
        <div class="conn-sub">
          <span class="conn-where">${s.endpoint}</span>
          ${!s.enabled ? nothing : html`
            <button class="conn-tools" @click=${() => void this.openTools(s.id)}>
              ${listed === undefined ? "Tool access"
                : listed.length === 0 ? "Tool access"
                : `${listed.filter((t) => t.on).length} of ${listed.length} tools`}
              <nr-icon name=${open ? "chevron-up" : "chevron-down"} size="small"></nr-icon>
            </button>`}
        </div>
        ${!open ? nothing : html`
          <div class="tool-list">
            ${listed === undefined
              ? html`<p class="tool-none">Asking ${s.serverName} what it offers…</p>`
              : listed.length === 0
                // "offered no tools" is what this said to anyone who was not
                // signed in to the connector — a guest, or a person who had
                // simply not connected it — which reads as the connector being
                // empty when the truth is that nobody asked it as anybody. The
                // tools are per-caller because the token is.
                ? html`<p class="tool-none">${
                    (this.connections.get(s.id)?.state ?? "none") === "none"
                      ? html`You are not signed in to ${s.serverName}, so it has
                          nothing to show you. Press Connect above.`
                      : html`${s.serverName} offered no tools.`}</p>`
                : listed.map((t) => html`
                    <label class="tool">
                      <input type="checkbox" .checked=${t.on}
                        @change=${(e: Event) => void this.toggleTool(
                          s.id, t.name, (e.target as HTMLInputElement).checked)}>
                      <span class="tool-name">${t.name}</span>
                      <span class="tool-why">${t.description}</span>
                    </label>`)}
          </div>`}
      </div>`;
  }

  private async toggleConnector(s: ServerRow) {
    this.connectProblem = "";
    try {
      await updateServer({ ...s, enabled: !s.enabled });
      this.servers = await listServers();
    } catch (e) {
      this.connectProblem = e instanceof Error ? e.message : String(e);
    }
  }

  private async connectConnector2(s: ServerRow) {
    this.connectProblem = "";
    const done = await connectServer(s.id, this.servers);
    this.servers = done.servers;
    this.connectProblem = done.problem;
    await this.loadConnections();
  }

  /* The tool list, fetched when it is first opened rather than with the shelf.
     It is a live call to the connector — the roster is the connector's to
     change, so there is nothing here to cache and asking twelve of them on
     every open would be twelve tailnet round trips nobody asked for. */
  private async openTools(id: string) {
    if (this.toolsOpen === id) { this.toolsOpen = ""; return; }
    this.toolsOpen = id;
    if (this.toolList.has(id)) { return; }
    try {
      const answer = await serverTools(id);
      const held = new Map(this.toolList);
      held.set(id, answer.tools);
      this.toolList = held;
      if (answer.problem !== "") { this.connectProblem = answer.problem; }
    } catch (e) {
      this.connectProblem = e instanceof Error ? e.message : String(e);
    }
  }

  private async toggleTool(id: string, tool: string, on: boolean) {
    // Drawn immediately and written behind it: a checkbox that waits for a
    // round trip feels broken, and the failure path puts it back.
    const before = this.toolList.get(id) ?? [];
    const held = new Map(this.toolList);
    held.set(id, before.map((t) => (t.name === tool ? { ...t, on } : t)));
    this.toolList = held;
    try {
      await setServerTool(id, tool, on);
    } catch (e) {
      const back = new Map(this.toolList);
      back.set(id, before);
      this.toolList = back;
      this.connectProblem = e instanceof Error ? e.message : String(e);
    }
  }

  /* Keyed by endpoint, because that is the honest join between a card and a
     row: a person may rename a connector, and the address is what decides
     whether the two are about the same service. */
  private connectorStatus(): Map<string, EntryStatus> {
    const out = new Map<string, EntryStatus>();
    for (const s of this.servers) {
      out.set(s.endpoint, { serverId: s.id, state: this.connections.get(s.id)?.state ?? "none" });
    }
    return out;
  }

  private async addConnector(ask: { serverName: string; transport: string; endpoint: string; authKind: string; authHeader: string; enabled: boolean }) {
    this.connectProblem = "";
    try {
      const ids = new Set(this.servers.map((s) => s.id));
      let id = ask.serverName;
      let k = 2;
      while (ids.has(id)) { id = ask.serverName + "-" + String(k); k = k + 1; }
      await createServer({ id, ...ask });
      this.servers = await listServers();
    } catch (e) {
      this.connectProblem = e instanceof Error ? e.message : String(e);
    }
  }

  private async connectConnector(entry: CatalogueEntry) {
    this.connectProblem = "";
    const done = await connectEntry(entry, this.servers);
    this.servers = done.servers;
    this.connectProblem = done.problem;
    await this.loadConnections();
  }

  private async loadConnections() {
    const rows = await listConnections().catch(() => [] as ConnectionRow[]);
    const held = new Map<string, ConnectionRow>();
    for (const r of rows) { held.set(r.serverId, r); }
    this.connections = held;
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
                    if (shelf === "skills") { void this.showSkill(r.key); }
                    else if (shelf === "agents") { this.agentId = r.key; this.gallery = ""; }
                  }}>
                  <span class="pick-top">
                    <!-- A connector this shelf knows wears its own mark; a
                         plug icon on a row of Linear, Notion and Sentry says
                         only "these are all connectors", which the heading
                         above them already said. Anything unrecognised keeps
                         the icon, because there is nothing truer to draw. -->
                    ${this.markFor(shelf, r)}
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
    /* The same page furniture as the artifacts library, deliberately.
     *
     * These are the console's two browse-and-search pages and they were built
     * a month apart into two different shapes: this one had a bare heading,
     * cards the size of a chip, no way to search, and the agent's ROW ID
     * printed under each title — "a-docflow-gemini", a database key sitting
     * where a person's eye goes for "who made this". Same job, same
     * furniture.
     *
     * The agent is resolved to its name here rather than inside the card:
     * the list is already loaded, and a card that looks something up renders
     * empty on first paint. */
    const named = (id: string) => {
      const held = this.agents.find((a) => a.id === id);
      return held === undefined || held.agentName === "" ? "" : held.agentName;
    };
    const q = this.startsFind.trim().toLowerCase();
    const shown = q === ""
      ? this.offers
      : this.offers.filter((o) =>
          (o.title + " " + named(o.agentId)).toLowerCase().includes(q));

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

        ${this.offers.length < 5 ? nothing : html`
          <label class="starts-find">
            <nr-icon name="search" size="small"></nr-icon>
            <input type="text" .value=${this.startsFind}
              placeholder="Search starting points…" aria-label="Search starting points"
              @input=${(e: Event) => {
                this.startsFind = (e.target as HTMLInputElement).value; }}>
          </label>`}

        ${this.offers.length === 0
          ? html`<p class="empty">Nothing is on offer yet. Open a conversation you
              are pleased with and press the share button in its header.</p>`
          : shown.length === 0
            ? html`<p class="empty">Nothing matches “${this.startsFind.trim()}”.</p>`
            : html`<div class="offer-grid">
              ${shown.map((o) => html`
                <!-- The CARD opens it; Remix is the second, quieter act. Two
                     buttons of equal weight made a person choose between two
                     verbs before they knew what they were choosing — and the
                     heavier of the two was the one that only reads. -->
                <div class="offer" role="button" tabindex="0"
                  title=${o.title === "" ? "Untitled conversation" : o.title}
                  @click=${() => { void this.openOffered(o.id); }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void this.openOffered(o.id);
                    }
                  }}>
                  <!-- A card with a blank name is a card nobody can choose. An
                       offered conversation usually has a title by now (the
                       engine names one from its first message), but one whose
                       naming call never landed still has to read as
                       something. -->
                  <div class="offer-name">${o.title === "" ? "Untitled conversation" : o.title}</div>
                  <div class="offer-meta">
                    ${named(o.agentId) === ""
                      ? html`<span>Shared conversation</span>`
                      : html`<span>${named(o.agentId)}</span>`}
                  </div>
                  <div class="offer-acts">
                    <button class="offer-remix" @click=${(e: Event) => {
                      // The card behind this one opens; this copies. Without
                      // stopping the bubble a Remix would do both.
                      e.stopPropagation();
                      void this.remix(o.id);
                    }}>Remix</button>
                  </div>
                </div>`)}
            </div>`}
      </div>`;
  }

  private async openStarts(): Promise<void> {
    // Address as well as view — /starting-points is a route now, so a link to
    // it lands here and Back leaves it.
    /* `/starts` and not `/starting-points`: the hyphenated path answered 404
       at the EDGE while the container served it 200, so something in front of
       this app does not pass it. Single-segment paths all pass, and the name
       is no worse. */
    this.go("starts", "/starts");
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

    /* A control ON a card, asking for something to be done.
     *
     * The card COMPOSES A TURN rather than calling anything: pressing "Move
     * to In Progress" sends the sentence a person would have typed, and the
     * model calls the tool. Chosen over letting a card reach the connector
     * directly, and the reason is what each option costs. A direct call needs
     * the sandbox to have network and a credential — the two things the
     * sandbox exists to deny. A card→engine write path avoids that but
     * changes state with no conversation around it: nothing in the transcript
     * records that the issue moved, and the record IS the point of doing this
     * in a chat rather than in Linear.
     *
     * Going through the composer means an action from a card is
     * indistinguishable from one a person asked for — same tools, same
     * grant, same steps card, same audit trail. It costs a model round trip
     * for what looks like a dropdown, and that is the honest price.
     *
     * The text is the plugin's, and it is a MESSAGE, never markup: it goes
     * through the same send path as typing, so nothing here can inject
     * anything the composer could not. */
    const acts = path.find((el) => el?.getAttribute?.("data-card-send"));
    if (acts) {
      const said = acts.getAttribute("data-card-send") ?? "";
      if (said.trim() !== "") { await this.session.sendMessage(said.trim()); }
      return;
    }

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
      <!-- Three reasons the overlay rises, in rank order. A real 401 is the
           hard door and dismisses nothing; the quota wall and a chosen
           sign-in are both soft — thread readable behind, backdrop and "Not
           now" close them — and differ only in what the card says. Login
           itself is one path for all three: the form POSTs, the page reloads,
           and the fresh cookie outranks the guest one on the next request. -->
      ${this.signedOut ? html`<login-overlay></login-overlay>`
        : this.quotaWall ? html`<login-overlay soft .note=${this.quotaNote()}
            @dismiss=${() => { this.quotaWall = false; }}></login-overlay>`
        : this.signIn ? html`<login-overlay soft
            @dismiss=${() => { this.signIn = false; }}></login-overlay>`
        : ""}
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
           "Admin console" navigates to /admin from the rail itself. It
           was briefly one event doing the second job, which is why pressing
           Preferences opened the operator's page.

           And this comment lives HERE, above the tag, because a comment among
           the attributes is not a comment: lit parses the template as HTML, an
           HTML comment cannot open inside a start tag, and every binding after
           it silently stops being an attribute. That is what "left menu link
           stop working" was — one comment, six dead event handlers. -->
      ${!this.indexOpen ? nothing : html`
      <div class="scrim index" @click=${() => { this.indexOpen = false; }}></div>
      <div class="index-layer" role="dialog" aria-label="The Joule index">
        <button class="icon index-close" title="Close"
          @click=${() => { this.indexOpen = false; }}>
          <nr-icon name="x" size="small"></nr-icon>
        </button>
        <search-dash mode="public"></search-dash>
      </div>`}

      <console-sidebar
        @mouseleave=${() => { this.railPeek = false; }}
        .threads=${this.threads}
        .activeId=${this.threadId}
        .me=${this.me}
        @pick-thread=${(e: CustomEvent) => { this.view = "chat"; this.nav = false; this.open(e.detail.id); }}
        @new-thread=${() => { this.view = "chat"; this.nav = false; this.fresh(); }}
        @collapse=${() => { this.toggleRail(); }}
        @open-settings=${() => { this.nav = false; this.openSettings("Preferences"); }}
        @open-signin=${() => { this.nav = false; this.signIn = true; }}
        @open-knowledge=${() => { this.nav = false; this.go("knowledge", "/knowledge"); }}
        @open-library=${() => { this.nav = false; this.go("library", "/artifacts"); }}
        @open-discover=${() => { this.nav = false; this.articleId = ""; this.go("discover", "/discover"); }}
        @open-canvas=${() => { this.view = "canvas"; }}
        @open-starts=${() => { this.nav = false; void this.openStarts(); }}
        @open-tasks=${() => { this.nav = false; this.taskDraft = ""; this.goTasks(); }}
        @open-agents=${() => { this.nav = false; this.openSettings("Agents"); }}
        @open-connectors=${() => { this.nav = false; this.openSettings("Connectors"); }}
      ></console-sidebar>

      <!-- The two Discover events are caught HERE rather than on each
           element, because they travel between two sibling views: the feed
           raises "open-article" and is then replaced by the article, which
           raises "close-article" and is replaced by the feed. A listener on
           either one would be listening on the element that is going away. -->
      <!-- The way back, when the rail is hidden.
           The rail's own collapse button lives inside the rail, so once the
           rail is gone so is it; and the header's toggle is inside the CHAT
           branch, so Discover, Tasks, Artifacts and Knowledge never had one at
           all. A person who collapsed the rail on any of those screens had no
           control anywhere on the page to bring it back. This one sits on the
           shell, outside every branch, and exists only while there is
           something to undo. -->
      ${this.railed ? "" : html`
        <button class="unrail" title="Sidebar"
          @mouseenter=${() => { this.railPeek = true; }}
          @focus=${() => { this.railPeek = true; }}
          @click=${() => { this.railPeek = false; this.toggleRail(); }}>
          <nr-icon name="panel-left" size="small"></nr-icon>
        </button>`}

      <div class="center"
        @open-article=${(e: CustomEvent) => this.openArticle(e.detail.id as string)}
        @close-article=${() => this.closeArticle()}>
        ${this.view === "article" ? html`<discover-article
              .storyId=${this.articleId}
              .seed=${this.seedArticle}
              .agentId=${this.agentId}
              .choiceId=${this.choiceId}></discover-article>`
          : this.view === "discover" ? html`<discover-page .seed=${this.seedFeeds}></discover-page>`
          : this.view === "tasks" ? html`<console-tasks .draft=${this.taskDraft}></console-tasks>`
          : this.view === "library" ? html`<artifact-library></artifact-library>`
          : this.view === "knowledge" ? html`<knowledge-page></knowledge-page>`
          : this.view === "canvas" ? html`<agent-canvas .focusAgent=${this.canvasFocus}></agent-canvas>`
          : this.view === "starts" ? this.startsPage() : html`
        <header>
          <button class="icon nav" title="Conversations"
            @click=${() => { this.toggleRail(); }}>
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
          ${this.threadId === "" ? nothing : html`
          <button class="icon" title="New conversation"
            @click=${() => { this.view = "chat"; this.nav = false; this.fresh(); }}>
            <nr-icon name="square-pen" size="medium"></nr-icon>
          </button>
          <span class="title">${this.threadTitle()}</span>`}
          <!-- Always present, even when the title above is not: the title was
               the header's only flexible element, so on the home screen —
               where there is no conversation to name — everything after it
               packed against the drawer toggle and the artifacts folder sat
               mid-header. The spacer owns the stretch; the title goes back to
               being a label. -->
          <span class="bar-space"></span>
          ${this.guestStrip()}
          <!-- No agent chip. Who answers is said three times already — the
               composer's "Ask <agent>" placeholder, the directory's Agents
               tab, the slash menu — and the bolt glyph beside a name in the
               header read as a stray Z in a place that is about the
               conversation, not its wiring. -->
          <!-- Offer this conversation as a starting point. Only on a
               conversation that exists — there is nothing to offer before the
               first message — and pressed when it is already on offer, so the
               control reports the state rather than only changing it. -->
          ${this.threadId === "" ? nothing : html`
            <!-- A three-dot menu, not a bare share button. A share arrow loose
                 in the header read as an upload control that did nothing;
                 named in a menu, the same action says what it is. The share
                 GLYPH stays — inside the row, where it is the same mark the
                 rail's Starting points row wears, which is the pairing that
                 makes both legible. -->
            <button class="icon" title="More" aria-expanded=${this.hmenu}
              @click=${() => { this.hmenu = !this.hmenu; }}>
              <nr-icon name="more-vertical" size="medium"></nr-icon>
            </button>`}
          <!-- The operator's way in, and only theirs.
               isAdmin reads null as "community deployment, everyone is the
               operator", which is the same reading the rail's Deployment row
               makes — so this appears on a box with no sign-in at all, and
               that is correct: there is nobody to hide it from.

               A cpu glyph, not a cog. The cog is Settings — the row in the
               account menu, a different place — and two cogs in one header
               would be two names for one idea. This is the machine the
               deployment runs as, which is what is behind the door.

               Checked against icon-paths before it was used, and it is the
               second name tried: "sliders" reads as the obvious choice and is
               not in the set, which nr-icon renders by printing that WORD
               where the mark should be. -->
          ${!isAdmin(this.me) ? nothing : html`
            <button class="icon" title="Deployment" aria-expanded=${this.amenu}
              @click=${() => { this.amenu = !this.amenu; this.hmenu = false; }}>
              <nr-icon name="cpu" size="medium"></nr-icon>
            </button>`}
          <!-- Settings, on a phone only.
               The note above says two cogs in one header would be two names
               for one idea, and it is right — on a DESKTOP, where the cog is
               a row in the account menu at the bottom of a rail that is
               always on screen. Below 1025px that rail is an off-canvas
               drawer, so the same row costs opening the drawer, finding the
               account block and reading a menu: three moves to reach the
               place a person goes to change how their console behaves. The
               header is the only chrome a phone keeps, so this is where it
               belongs there — and it is hidden at widths where the rail is a
               column, which is what keeps it from being the second cog. -->
          <button class="icon settings-here" title="Settings"
            @click=${() => { this.hmenu = false; this.openSettings("Preferences"); }}>
            <nr-icon name="settings" size="medium"></nr-icon>
          </button>
          <!-- The count comes from cards(), which is the same join the cards
               under the messages are drawn from — one entry per artifact at
               its newest version, so a file saved eight times counts once.
               No badge at zero: an empty conversation should not wear a 0. -->
          <button class="icon count" title=${this.cards().length === 0 ? "Artifacts"
              : `Artifacts (${this.cards().length})`}
            aria-pressed=${this.rail === "artifacts"}
            @click=${() => this.show("artifacts")}><nr-icon name="folder" size="medium"></nr-icon>${
            this.cards().length === 0 ? nothing
              : html`<span class="badge" aria-hidden="true">${
                  this.cards().length > 99 ? "99+" : this.cards().length}</span>`}</button>
          ${!this.amenu ? nothing : html`
            <div class="hmenu-scrim" @click=${() => { this.amenu = false; }}></div>
            <!-- Every tab of the deployment area, at its own address. The
                 first row is the area itself and the rest are the nested
                 routes under it, so this menu is a shortcut past a screen
                 rather than a second navigation to keep in step — the rail
                 inside /admin is still the way around once you are there.

                 Grouped exactly as that rail groups them (src/settings.ts's
                 TABS), because a person who learns the order in one place
                 should not have to learn it again in the other. -->
            <div class="hmenu amenu" role="menu">
              ${ADMIN_LINKS.map((row) => row.head !== undefined
                ? html`<div class="amenu-head">${row.head}</div>`
                : html`
                  <button role="menuitem"
                    @click=${() => { this.amenu = false; location.assign(row.href!); }}>
                    <nr-icon name=${row.icon!} size="small"></nr-icon>${row.label}
                  </button>`)}
            </div>`}
          ${!this.hmenu ? nothing : html`
            <div class="hmenu-scrim" @click=${() => { this.hmenu = false; }}></div>
            <div class="hmenu" role="menu">
              <button role="menuitem"
                @click=${() => { this.hmenu = false; void this.toggleOffer(); }}>
                <nr-icon name="share" size="small"></nr-icon>
                ${this.offered ? "Withdraw starting point" : "Offer as starting point"}
              </button>
            </div>`}
        </header>
        <!-- After the header, not before it: the slot is zero-height and the
             card inside is absolute, so the announcement hangs below the bar
             without moving it or anything under it. -->
        ${this.banner === "" ? nothing : html`
        <div class="notice-slot">
          <div class="notice" role="status">
            <span>${this.banner}</span>
            <button class="icon" title="Dismiss"
              @click=${() => { sessionStorage.setItem("joule-banner-seen", this.banner); this.banner = ""; }}>
              <nr-icon name="x" size="small"></nr-icon>
            </button>
          </div>
        </div>`}
        <main class=${[
          this.session.getState().messages.length === 0
            ? (this.starts.length > 0 ? "empty has-starts" : "empty") : "",
          // A conversation begun here keeps the card. The answers extend the
          // composer upward instead of replacing the page with a transcript —
          // the suggestion list drops down, the conversation grows up, and the
          // two are the same object. Dropped the moment an OLD conversation is
          // opened from the rail: that is a transcript somebody came to read,
          // not a sentence they are still in the middle of.
          this.compact && this.session.getState().messages.length > 0 ? "compact" : "",
          // The composer is suggesting, so the layout under it gets out of
          // the way — see `main.hinting .caps`.
          this.hints.length > 0 ? "hinting" : "",
        ].filter((c) => c !== "").join(" ")}>
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
          <!-- messageCollapseThreshold is effectively off: the component
               folds a message past 600 chars behind a fade and a Show more,
               and a link in the faded tail cost every reader a ghost first
               tap — the tap expanded the fold (visibly almost nothing) and
               only the second reached the link. A search answer with
               citations is always past 600 chars, so "all links need two
               taps" was this fold. -->
          <!-- invertedScroll is column-reverse inside the message list, so in
               compact mode the newest line sits against the composer and the
               older ones travel upward. The component's own property; the
               card's ceiling is a max-height on its messages part. -->
          <nr-chatbot class=${this.session.getState().messages.length > 0 ? "talking" : ""}
            @click=${(e: Event) => { void this.chipClick(e); }}
            @nr-chatbot-message-sent=${() => { this.dropKeyboard(); }}
            @nr-dropdown-item-click=${(e: Event) => { void this.onAttachPick(e); }}
            @input=${() => { this.onComposerInput(); }}
            .controller=${this.session}
            .isBotTyping=${this.busy}
            .isQueryRunning=${this.busy}
            enable-file-upload
            boxed
            .invertedScroll=${this.compact && this.session.getState().messages.length > 0}
            welcome-message=${WORDMARK}
            placeholder="Ask ${this.agentName()}…"
            attach-icon="plus"
            .i18n=${{ input: { attachButton: "" },
                      send: { sendButton: "", stopButton: "" } }}
            .messageCollapseThreshold=${1000000}
            .attachItems=${this.attachMenu()}
            custom-attach-menu
          >${this.attachPanel()}</nr-chatbot>
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

      <!-- The files panel belongs to a CONVERSATION and to nothing else.
           It draws this conversation's artifacts, so on the artifacts library
           — a page about every conversation — it was a second, narrower list
           of one thread's files beside a grid of all of them, with no way to
           tell which thread it belonged to. The same holds for Knowledge and
           the agent graph: those views replace the conversation column, and a
           panel about a conversation that is not on screen is a panel about
           nothing. -->
      ${this.rail === "artifacts" && this.view === "chat"
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
      <!-- Settings is an OVERLAY and deliberately not a page. It is somewhere
           you go, change one thing and leave; it has no content of its own to
           link to, and giving it an address made Back mean two different
           things depending on how you got there. The app stays behind it,
           blurred by the scrim, which is what says "you are still here". -->
      ${this.settings ? html`<console-settings .me=${this.me} .tab=${this.settingsTab as never}
        @close=${() => {
          this.closeSettings();
          // A rename or a disable was invisible here until a reload: the
          // header, the agent picker and the placeholder all read a list
          // fetched once at startup.
          void this.reloadAgents();
        }}></console-settings>` : ""}

    `;
  }
}

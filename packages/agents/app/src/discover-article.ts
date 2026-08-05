// One story from Discover, opened, with a way to ask about it.
//
// The feed answers "what happened"; this answers "what does the crawl
// actually say", and then lets somebody put a question to it without leaving
// the page they are reading. Those two halves are one screen deliberately: a
// question about an article asked from a blank composer is a question with
// the article's name in it and none of its text, which is the version that
// gets a vague answer.
//
// WHAT IS ON THE PAGE IS NOT THE ARTICLE. It is what a crawler fetched from
// the sources — excerpts, under each source's own name, next to a link to the
// source. That distinction is drawn in the markup rather than assumed: each
// section is headed by the host it came from and footed by "Read on <host>",
// because an aggregator that lays crawled text out as though it wrote it is
// doing something else.
//
// The body is not fetched from the index here, and cannot be. `/search`,
// `/retrieve` and `/doc/<hash>` are operator-only in the console's index
// proxy and Discover is a public page, so the text arrives already written,
// out of the row the background digest stored. See discover.ts in the engine.
//
// The conversation is a REAL one. `POST /threads/from-story` opens a thread,
// titles it from the headline and attaches the article as retrieved context;
// everything after is an ordinary turn, so the exchange started here has a
// sidebar row, an address, steps, artifacts and a model picker waiting for it
// in the console. What the article view does NOT do is reimplement any of
// that — the box below is a textarea and a send button, and the moment
// somebody wants more than that there is a link to the place that has it.

import { LitElement, css, html, nothing } from "lit";
import "./ui.js";
import "./ask-dock.js";
import { customElement, property, state } from "lit/decorators.js";
import { DiscoverArticle, readArticle, threadFromStory, modelChoices, type ModelChoice } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { ChatSession } from "./chat-session.js";

/* Escaped before it is rendered, and that ordering is the contract
 * `renderMarkdown` states: it takes text that is ALREADY html-escaped and
 * turns markdown syntax into markup, so anything reaching it unescaped is a
 * tag the page will run. Two sources feed it here and both are somebody
 * else's words — a crawled page's text, and a model's answer about it.
 *
 * A private copy rather than an import: the one in chat-session.ts is not
 * exported, and a shared two-line string helper is worth a deliberate home
 * rather than being exported as a side effect of this change. */
function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

/** The host a url belongs to, as a person reads it. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** How long ago, in the words a person uses. Same shape the feed uses — the
 *  two pages must not disagree about when something was fetched. */
function ago(stamp: string): string {
  const ms = Date.parse(stamp);
  if (!isFinite(ms)) return "";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

@customElement("discover-article")
export class DiscoverArticleView extends LitElement {
  static styles = css`
    /* A flex-grow of 1 as well as a height of 100%, and that pair is the fix
       rather than belt-and-braces. This element is a flex ITEM in the console's own
       column, and a flex item's base size comes from its content — so once it
       gained an nr-chatbot child, which sizes itself to whatever it is given
       rather than to anything intrinsic, the two resolved each other to
       nothing: the host measured 0x0 and the chatbot painted its empty state
       out of the collapsed box, over the page, looking exactly like the
       console's home screen. It is the third time this shape has been hit in
       this codebase; artifact-library carries the other two. */
    /* Relative, because the ask layer is positioned against it rather than
       taking a row of its own — see .ask. */
    :host { display: flex; flex-direction: column; position: relative;
            flex: 1; height: 100%; min-height: 0;
            background: var(--bg-chat, var(--bg)); }

    .top { display: flex; align-items: center; gap: 10px;
           padding: 12px 24px; border-bottom: 1px solid var(--border); }
    .back { display: inline-flex; align-items: center; gap: 6px;
            font: inherit; font-size: 13.5px; cursor: pointer;
            border: 0; background: none; color: var(--muted);
            padding: 6px 10px; border-radius: 8px;
            transition: color .15s cubic-bezier(.23,1,.32,1),
                        background-color .15s cubic-bezier(.23,1,.32,1); }
    .back:hover { color: var(--fg); background: var(--bg-sunken); }
    .crumb { font-size: 13px; color: var(--faint); }

    /* The reading column runs the full height and the article scrolls UNDER
       the floating layer. The bottom padding is what keeps the last paragraph
       reachable — without it the final lines sit permanently behind the
       bubbles and cannot be scrolled clear. */
    .scroll { flex: 1; min-height: 0; overflow-y: auto;
              padding: 30px 24px calc(24px + var(--ask-space, 190px)); }
    /* One column, at a reading width. The ask box below matches it so the two
       read as one page rather than as a page with a widget under it. */
    .col { max-width: 720px; margin: 0 auto; }

    /* The picture, when there is one — and about nineteen stories in twenty
       have none, so nothing here is laid out around its presence: no
       placeholder, no reserved band, no grey rectangle standing in for a
       photograph. An article with a picture gets one; an article without is
       not an article with a hole in it.
       Served from /img/story/<id> and never from the publisher, so the
       reader's browser only ever talks to this origin — see
       server/image-proxy.ts. A fixed aspect ratio with object-fit cover,
       because what comes back is whatever shape a stranger's social-card
       image happens to be. */
    .shot { width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
            border-radius: 14px; margin-bottom: 22px; display: block;
            background: var(--bg-sunken); }

    h1 { margin: 0 0 12px; font: 600 clamp(26px, 3vw, 38px)/1.12 var(--display);
         letter-spacing: -.022em; text-wrap: balance; }
    .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
            font-size: 12.5px; color: var(--faint); margin-bottom: 22px; }
    .sep { opacity: .5; }
    .why { color: var(--muted); }

    /* The digest's own two sentences, set apart from the crawled text under
       it. They are the one thing on the page this deployment wrote. */
    .standfirst { margin: 0 0 26px; font-size: 18px; line-height: 1.6;
                  color: var(--fg); border-left: 2px solid var(--border);
                  padding-left: 16px; }

    .body { font-size: 15.5px; line-height: 1.72; color: var(--fg); }
    .body h2 { margin: 30px 0 4px; font: 600 13px/1.3 var(--display);
               letter-spacing: .06em; text-transform: uppercase;
               color: var(--faint); }
    .body p { margin: 0 0 16px; }
    .body a { color: var(--fg); text-decoration: none;
              border-bottom: 1px solid var(--border); }
    .body a:hover { border-bottom-color: var(--muted); }
    .body ul, .body ol { margin: 0 0 16px; padding-left: 22px; }
    .body code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
                 background: var(--bg-sunken); padding: 1px 5px; border-radius: 5px; }
    .body pre { overflow-x: auto; background: var(--bg-sunken);
                padding: 12px 14px; border-radius: 10px; }

    /* What this is, said once, at the foot of the text rather than the top.
       At the top it is a disclaimer nobody reads; here it is the answer to
       the question the text has just raised. */
    .provenance { margin: 28px 0 0; padding-top: 16px;
                  border-top: 1px solid var(--border);
                  font-size: 12.5px; line-height: 1.6; color: var(--faint); }
    .provenance a { color: var(--muted); }

    .none { color: var(--muted); font-size: 15px; line-height: 1.6;
            max-width: 60ch; }
    .none b { color: var(--fg); font-weight: 600; }

    /* --- asking ------------------------------------------------------- */

    /* The panel is <ask-dock> (src/ask-dock.ts): bubbles over the article, a
       bare input box under them, the reading column running underneath. It
       floats — positioned against this host, not a row in the flex column —
       because a card that sits in a row of its own has blank page behind it
       and is a card pretending to float.
       What THIS surface decides about it is one line: how much of the article
       a conversation may take before it starts scrolling inside its own box.
       Short, because this page is an article with a question box on it, not a
       chat with an article above. */
    ask-dock { --ask-max: min(26vh, 220px); }

    /* Everything the old hand-written composer needed — a strip of said
       things, a textarea, a send button, a working row — went with it when
       nr-chatbot took over. The rules for it went too rather than sitting here
       matching nothing, which is how a stylesheet ends up twice the size of
       the markup it dresses. */

    @media (max-width: 720px) {
      .scroll { padding: 20px 16px 16px; }
      .top { padding: 10px 16px; }
      /* Less on a phone, and for a reason a screenshot caught: unbounded, the
         answer grew until it covered the article it was about, with no way
         back to either. */
      ask-dock { --ask-max: 33vh; }
    }
  `;

  /** Which story. Set by the console from the address. */
  @property({ type: String }) storyId = "";

  /* What the route's loader already read.
   *
   * The point is the first paint. An article is what a link lands on and what
   * a crawler reads, and both used to get "Opening…" while the browser asked
   * for a story the server had already been told to serve. The loader reads
   * the same public route this element would, so the server renders the real
   * article and this element only refreshes it. */
  @property({ attribute: false }) seed: DiscoverArticle | null = null;
  /** Which agent answers, and on which model. Both are the console's — the
   *  article does not run its own picker, it inherits what the person had. */
  @property({ type: String }) agentId = "";
  @property({ type: String }) choiceId = "";

  @state() private article: DiscoverArticle | null = null;
  /* Guarded, because `willUpdate` runs on every property change and a re-seed
     would put the opening article back after the reader had moved on. */
  private tookSeed = false;
  @state() private loading = true;
  @state() private gone = false;
  @state() private busy = false;
  @state() private threadId = "";
  @state() private draft = "";

  /* THE CONSOLE'S OWN CONVERSATION OBJECT, not a private imitation.
   *
   * This view began with a textarea, a `say()` call and its own list of what
   * had been said — and it was wrong in exactly the ways a second
   * implementation is always wrong. It printed the [FOLLOWUPS] block as prose
   * because it did not run the parser the composer runs. It had no queueing,
   * so a second question asked while the first was running was dropped. It
   * had no working state past a row of dots, no refusal handling, no
   * artifacts, no cards.
   *
   * ChatSession is the thing that knows all of that, and nr-chatbot is the
   * input built for it. Both are used here as they are used on the
   * conversation screen; what differs is `show-messages`, which is the
   * component's own documented input-only mode, because the transcript above
   * belongs to an article rather than to a chat.
   *
   * The bridge is the four functions the session asks for. The agent and the
   * model are the CONSOLE's — passed in as properties — so an article
   * inherits whatever the person last chose rather than running a picker of
   * its own. */
  private session = new ChatSession({
    agentId: () => this.agentId,
    modelChoiceId: () => this.choiceId,
    onThreadOpened: (id: string) => { this.threadId = id; },
    onTurnDone: () => { this.requestUpdate(); },
  });
  private unlisten: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    // The session drives what is on screen, so a re-render follows every
    // change it reports — the same wiring the console does.
    this.unlisten = this.session.on("state:changed", () => {
      this.busy = this.session.isTyping();
      this.requestUpdate();
    });
    void this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.();
    this.unlisten = null;
  }

  willUpdate(): void {
    if (this.tookSeed || this.seed === null) { return; }
    this.tookSeed = true;
    this.article = this.seed;
    this.loading = false;
  }

  updated(changed: Map<string, unknown>) {
    // The console keeps this element alive between articles, so a new id has
    // to reload rather than wait for a fresh element. The conversation is
    // dropped with it: it was about the article that is no longer on screen.
    /* Load whenever the id changes to a real one — including the FIRST time
       it is set, which is the case this guard used to miss.
       It read `changed.get("storyId") !== undefined`, i.e. "there was a
       previous id", and on a cold load there never is: lit inserts the element
       (connectedCallback runs, storyId still unset, load() returns at its own
       empty check) and commits the property afterwards, so the only signal is
       an update whose old value is undefined. Every link straight to an
       article therefore sat on "Opening…" forever, while the same article
       opened from the feed worked — because there the element already held a
       previous id. */
    if (changed.has("storyId") && this.storyId !== "") {
      // `this.said = []` stood here and did nothing: no such field was ever
      // declared, so it created an expando property and cleared no messages.
      // It was harmless while this view kept its own list and drew it by hand.
      // It stopped being harmless the moment the composer became nr-chatbot
      // reading the session directly — without this reset, opening a second
      // article showed the first one's conversation still sitting above the
      // question box.
      this.session.fresh();
      this.threadId = "";
      void this.load();
    }
  }

  /* The model menu, and the picker that shows it.
   *
   *  Fetched here rather than handed down, because this view is reached
   *  directly by URL as well as from the feed and a property nobody set is a
   *  picker that silently offers nothing. */
  @state() private choices: ModelChoice[] = [];

  private async loadChoices(): Promise<void> {
    this.choices = await modelChoices().catch(() => []);
  }

  private async load() {
    if (this.storyId === "") return;
    void this.loadChoices();
    this.loading = true;
    this.gone = false;
    try {
      this.article = await readArticle(this.storyId);
    } catch {
      // Every failure reads the same way to somebody looking at it, and the
      // overwhelmingly likely one is that the story rolled off its feed.
      this.article = null;
      this.gone = true;
    }
    this.loading = false;
  }

  private sources(): string[] {
    const raw = this.article?.story.sources ?? "";
    return raw.split("\n").map((u) => u.trim()).filter((u) => u !== "");
  }

  /* Ask.
   *
   * The thread is opened on the FIRST question, by the route that seeds the
   * article into it, and the session is pointed at it before anything is
   * sent. Every question after that is an ordinary send on an ordinary
   * conversation — which is what makes "the same context" true for turn three
   * as well as turn two, and what puts this exchange in the sidebar, at
   * /c/<id>, with its steps and its artifacts.
   *
   * `session.open` rather than a private field, because opening is what loads
   * the transcript and starts the live feed. The seeded article turn is
   * stored as CHUNK_ROLE, so the engine's reader never sends it and the
   * transcript here never shows it. */
  private async ask(text: string) {
    const said = text.trim();
    if (said === "" || this.article === null) return;
    if (this.threadId === "") {
      try {
        const made = await threadFromStory(this.storyId, this.agentId, this.choiceId);
        this.threadId = made.id;
        await this.session.open(made.id);
      } catch {
        // Leave the thread unopened: `sendMessage` will open a plain one, and
        // an answer without the article beats no answer at all.
      }
    }
    await this.session.sendMessage(said);
  }

  private article_() {
    const a = this.article;
    if (a === null) return nothing;
    const s = a.story;
    const urls = this.sources();
    return html`
      ${s.image === "" ? nothing : html`<img class="shot"
          src=${`/img/story/${encodeURIComponent(s.id)}`} alt="" loading="lazy"
          @error=${(e: Event) => { (e.target as HTMLElement).style.display = "none"; }}>`}
      <h1>${s.headline}</h1>
      <div class="meta">
        <span>${ago(s.fetchedAt)} · fetched</span>
        ${s.readMinutes <= 0 ? nothing : html`
          <span class="sep">·</span><span>${s.readMinutes} min read</span>`}
        ${s.why.trim() === "" ? nothing : html`
          <span class="sep">·</span><span class="why">${s.why}</span>`}
      </div>
      <p class="standfirst">${s.summary}</p>
      ${s.body.trim() === ""
        ? html`<p class="none">The crawl has this story's sources but no text
            for them yet. The links below are the whole of it.</p>`
        : html`<div class="body" .innerHTML=${renderMarkdown(escapeHtml(
            // The reflowed body when the engine has one, the raw text when it
            // does not. Never both, and never a choice a reader has to make:
            // the raw version is evidence kept on the row, not a view.
            (s.bodyMd !== undefined && s.bodyMd !== "") ? s.bodyMd : s.body))}></div>`}
      <p class="provenance">
        What you have read above is what a web crawler fetched from
        ${urls.length === 1 ? "this source" : "these sources"}, not the
        published ${urls.length === 1 ? "article" : "articles"} — excerpts,
        under the name of the site each came from. The summary at the top was
        written by Joule from those excerpts.
        ${urls.length === 0 ? nothing : html`<br>
          ${urls.map((u, i) => html`${i === 0 ? "" : " · "}<a href=${u}
            target="_blank" rel="noopener noreferrer">${host(u)}</a>`)}`}
      </p>`;
  }

  render() {
    return html`
      <div class="top">
        <button class="back" @click=${() => {
          this.dispatchEvent(new CustomEvent("close-article", { bubbles: true, composed: true }));
        }}>
          <!-- chevron-left, not arrow-left: the set has no arrow-left, and nr-icon
               prints the NAME when it has no glyph — so the button read
               "arrow-left Discover" on a phone. -->
          <nr-icon name="chevron-left" size="small"></nr-icon>Discover
        </button>
        ${this.article === null ? nothing
          : html`<span class="crumb">${this.article.topic}</span>`}
      </div>

      <div class="scroll">
        <div class="col">
          ${this.loading ? html`<p class="none">Opening…</p>`
            : this.gone || this.article === null
              ? html`<p class="none">That story has rolled off its feed.
                  Discover is rewritten by a background pass every half hour and
                  keeps only what is current, so an older link points at
                  something that is no longer there — <b>the feed has what
                  replaced it</b>.</p>`
              : this.article_()}
        </div>
      </div>

      <!-- The panel, floating over the article: follow-up pills, the bubbles,
           the input box and the model picker, all of it ask-dock's. What is
           passed is what this surface knows — the conversation, whether a turn
           is running, and where the exchange can be opened in full. What comes
           back is one event: the words somebody typed, which this element
           turns into a thread seeded with the article. -->
      ${this.loading || this.article === null ? nothing : html`
        <ask-dock
          .session=${this.session}
          .busy=${this.busy}
          placeholder="Ask about this story…"
          note="Answers use what the crawl holds on this story."
          href=${this.threadId === "" ? "" : `/c/${this.threadId}`}
          hrefText="Open in the console →"
          .choices=${this.choices}
          .choiceId=${this.choiceId}
          @pick-choice=${(e: CustomEvent) => { this.choiceId = e.detail.id as string; }}
          @ask=${(e: CustomEvent) => { void this.ask(e.detail.text as string); }}
        ></ask-dock>`}
    `;
  }
}

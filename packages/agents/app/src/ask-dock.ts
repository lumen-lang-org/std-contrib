// The floating ask panel: a conversation that hovers over a page rather than
// taking one.
//
// It was written for the Discover article — bubbles over the text you are
// reading, a bare input box under them, the page scrolling underneath — and
// the Tasks page wants exactly the same object for a different reason: there,
// what floats over the list is the way to make a task by describing it instead
// of filling in the form beside it. Two surfaces, one panel, and that is the
// whole reason this file exists. The alternative was a second copy of eleven
// carefully-tuned selectors, and the copy would have drifted the first time
// either page was touched.
//
// WHAT IT IS NOT: a chat implementation. Everything about a turn — queueing,
// the working state, parsing a reply's follow-ups, artifacts, refusals — is
// ChatSession's, and the input is nr-chatbot's. This draws the panel and the
// bubbles inside it, and hands what somebody typed to whoever put it on the
// page, because opening the right conversation is the host's business and
// differs per surface: the article opens a thread seeded with the article, the
// task page opens a plain one.
//
// The bubbles are drawn here rather than left to the component, which is the
// one narrow exception to that rule and is forced: `.message.bot
// .message__content` is `border-radius: 0` in the vendored build, hard-coded
// rather than tokenised and behind no part, so a rounded assistant bubble
// cannot be reached from outside — and a square-cornered slab floating over a
// page is worse than no bubble at all. The TEXT is still the session's.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./ui.js";
import "./model-picker.js";
import type { ModelChoice } from "./api.js";
import type { ChatSession } from "./chat-session.js";

@customElement("ask-dock")
export class AskDock extends LitElement {
  static styles = css`
    /* Floated, and floating means OVER something: the host is absolutely
       positioned against whichever page put it there, and that page's own
       content runs underneath. A page using this needs two things and no
       more — position:relative on itself, and bottom padding of
       var(--ask-space) on whatever scrolls, which is measured and published
       from here. */
    :host { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
            padding: 0 24px 16px; background: transparent;
            pointer-events: none; --ask-max: min(26vh, 220px);
            font: inherit; color: var(--fg); }

    /* One small panel, not a scatter of loose objects.
     *
     * Without it the bubbles float individually and the page shows THROUGH the
     * gaps between them — on a phone the prose ran straight across the space
     * between a chip and a bubble and collided with both. A wrapper gives the
     * layer one edge and one surface: the page passes behind the panel instead
     * of between its parts.
     *
     * Translucent with a blur rather than opaque, because the point is still
     * to float over what is underneath rather than to cover it. */
    /* The panel, with room at the top right for the handle that shuts it. */
    .askcol { position: relative; pointer-events: auto;
              max-width: var(--ask-width, 720px); margin: 0 auto;
              display: flex; flex-direction: column; gap: 8px;
              padding: 10px 10px 8px; border-radius: 22px;
              border: 1px solid var(--border);
              background: color-mix(in srgb, var(--bg-raised, var(--bg)) 86%, transparent);
              backdrop-filter: blur(14px) saturate(1.4);
              -webkit-backdrop-filter: blur(14px) saturate(1.4);
              box-shadow: 0 14px 40px rgba(0,0,0,.20); }

    /* Shut it.
     *
     * A phone is where this earns its place: a two-turn conversation and the
     * panel is most of the screen, over a page somebody opened to look at. So
     * the conversation folds away and the input box stays — which is the state
     * the panel starts in anyway, and the one thing that must never be hidden,
     * because a panel with no way to type in it is a panel with no way back.
     *
     * The handle sits ON the panel rather than above it: a control outside the
     * surface is a second floating object, which is the thing the wrapper was
     * added to stop. */
    .handle { position: absolute; top: -13px; right: 10px; z-index: 1;
              width: 30px; height: 26px; border-radius: 999px;
              display: grid; place-items: center; cursor: pointer;
              border: 1px solid var(--border); color: var(--muted);
              background: var(--bg-raised, var(--bg));
              box-shadow: 0 4px 12px rgba(0,0,0,.12);
              transition: color .15s cubic-bezier(.23,1,.32,1); }
    .handle:hover { color: var(--fg); }
    .handle .count { font-size: 11px; font-variant-numeric: tabular-nums; }
    @media (prefers-reduced-motion: reduce) { .handle { transition-duration: .01ms; } }

    /* The composer. Every selector below is a part the component publishes;
       nothing reaches into its internals. The host sizes to its content, and
       the message list — which this does not use — is off. */
    .ask-chat { flex: 0 0 auto; height: auto; width: 100%;
                --chatbot-radius: 16px;
                --nuraly-color-user-bubble-bg: var(--bg-user, rgba(127,127,127,.14));
                --nuraly-color-user-bubble-fg: var(--fg);
                --nuraly-color-bot-bubble-bg: transparent;
                --nuraly-color-bot-bubble-fg: var(--fg);
                --nuraly-color-divider: transparent; }

    /* Oldest at the top, newest against the input box — the reading order of
       every messaging app there is. It was column-reverse once, which put the
       newest turn at the TOP and read as the conversation running backwards. */
    .bubbles { display: flex; flex-direction: column; gap: 8px;
               max-height: var(--ask-max); overflow-y: auto;
               padding: 4px 2px 10px; width: 100%; }
    .bubble { max-width: 82%; padding: 9px 14px; border-radius: 18px;
              font-size: 14px; line-height: 1.55; overflow-wrap: anywhere;
              box-shadow: none; }
    .bubble.mine { align-self: flex-end; border-bottom-right-radius: 6px;
                   background: var(--bg-user, rgba(127,127,127,.16));
                   color: var(--fg); }
    .bubble.theirs { align-self: flex-start; border-bottom-left-radius: 6px;
                     background: var(--bg-raised, var(--bg)); color: var(--fg);
                     border: 1px solid var(--border); }
    .bubble p { margin: 0 0 8px; }
    .bubble p:last-child { margin: 0; }
    /* The follow-up chips arrive inside the reply's own HTML as well as in the
       session's suggestions, which the row below already draws with handlers
       on it. Rendered twice they overlapped each other and the page. */
    .bubble button, .bubble .followups { display: none; }
    .bubble.working { display: flex; gap: 4px; align-items: center; }
    .bubble.working i { width: 5px; height: 5px; border-radius: 50%;
                        background: var(--muted); animation: blip 1.1s infinite; }
    .bubble.working i:nth-child(2) { animation-delay: .15s; }
    .bubble.working i:nth-child(3) { animation-delay: .3s; }
    @keyframes blip { 0%,80%,100% { opacity: .25 } 40% { opacity: 1 } }
    @media (prefers-reduced-motion: reduce) { .bubble.working i { animation: none; } }

    /* Two rows of pills and one rule for both: what the model offered next,
       and what a surface offers before anything has been said. */
    .chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end;
             width: 100%; }
    .chips.starters { justify-content: flex-start; }
    .chip { border: 1px solid var(--border); border-radius: 999px;
            padding: 6px 13px; font: inherit; font-size: 12.5px;
            background: var(--bg-raised, var(--bg)); color: var(--muted);
            cursor: pointer;
            transition: color .15s cubic-bezier(.23,1,.32,1),
                        border-color .15s cubic-bezier(.23,1,.32,1); }
    .chip:hover { color: var(--fg); border-color: var(--fg); }
    @media (prefers-reduced-motion: reduce) { .chip { transition-duration: .01ms; } }

    /* The note under the composer, inside the panel rather than loose on the
       page — where it printed straight over whatever was behind it. */
    .foot { display: flex; align-items: baseline; gap: 8px; padding: 0 6px 2px;
            font-size: 12px; color: var(--muted); }
    .foot .grow { flex: 1; }
    .foot a { color: var(--muted); }

    /* Nothing here draws a container: the panel above is the only surface. */
    .ask-chat::part(boxed-area) { border: 0; background: transparent;
                                  box-shadow: none; border-radius: 0;
                                  width: 100%; }
    .ask-chat::part(content) { flex: 0 0 auto; min-height: 0; }
    .ask-chat::part(messages) { max-height: var(--ask-max); overflow-y: auto;
                                background: transparent; border: 0;
                                padding: 0 0 10px; }
    /* The one floating object inside the panel. */
    .ask-chat::part(input-container) { border: 1px solid var(--border);
                                       border-radius: 22px; padding: 4px 6px;
                                       background: var(--bg-raised, var(--bg));
                                       box-shadow: none; }
    .ask-chat::part(input) { min-height: 0; }
    .ask-chat::part(input-box) { min-height: 0; }
    /* The component draws its OWN follow-up row when it is showing no
       messages, from the same state the row above is drawn from — so the
       suggestions appeared twice, overlapping each other and the page. The row
       kept is this element's, because that is the one with handlers on it. */
    .ask-chat::part(input-only-suggestions) { display: none; }
    /* No empty state: the invitation is the placeholder in the box. */
    .ask-chat::part(empty-state) { display: none; }
    .ask-chat::part(empty-state-content) { display: none; }

    @media (max-width: 720px) {
      :host { padding: 10px 16px 14px; }
      .chip { max-width: 220px; }
    }
  `;

  /** The conversation. Opened, replayed and driven by whoever put this here —
   *  this element only reads it and hands it what was typed. */
  @property({ attribute: false }) session: ChatSession | null = null;
  /** Whether a turn is running. The host's read of the session, passed down
   *  rather than taken here, because a host may be waiting on something of its
   *  own before the turn even starts. */
  @property({ type: Boolean }) busy = false;
  @property({ type: String }) placeholder = "Ask…";
  /** The sentence under the box, and the link at the end of that line. */
  @property({ type: String }) note = "";
  @property({ type: String }) href = "";
  @property({ type: String }) hrefText = "";
  /** Offered before anything has been said. The model's own follow-ups take
   *  over the moment there are any. */
  @property({ attribute: false }) starters: string[] = [];
  /** The model menu. Empty hides the picker entirely — a surface that has not
   *  fetched one shows no control rather than an empty one. */
  @property({ attribute: false }) choices: ModelChoice[] = [];
  @property({ type: String }) choiceId = "";

  /** Folded away: the input box alone, the conversation out of the way.
   *  Somebody's own decision and it stays made — an answer arriving does not
   *  unfold it, because that would undo the thing they just did. */
  @state() private shut = false;
  @state() private tick = 0;
  private unlisten: (() => void) | null = null;
  private sizer: ResizeObserver | null = null;
  private picker: HTMLElement | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.listen();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.();
    this.unlisten = null;
    this.sizer?.disconnect();
    this.sizer = null;
  }

  /* The session drives what is on screen, so a re-render follows every change
     it reports. Re-subscribed when the session itself is replaced, which is
     what a host does when it moves to another article. */
  private listen(): void {
    if (this.session === null || this.unlisten !== null) { return; }
    this.unlisten = this.session.on("state:changed", () => {
      this.tick = this.tick + 1;
    });
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("session")) {
      this.unlisten?.();
      this.unlisten = null;
      this.listen();
    }
    // Every pass: the composer's action row is written by the component, and
    // it is rebuilt whenever the send button appears or goes away.
    void this.dockPicker();
    this.watchPanel();
  }

  /* How much room the panel needs at the foot of the page under it.
   *
   *  Measured, not assumed. A flat reserve is right for an empty composer and
   *  wrong the moment a conversation is in it: the panel grows to its ceiling,
   *  the reserve does not, and the page's last lines end up permanently behind
   *  it with no way to scroll them clear.
   *
   *  Published as `--ask-space` on the host that owns this element's shadow
   *  root — so a page opts in by using the property in its own padding and
   *  wires nothing. A ResizeObserver rather than a read after each render,
   *  because the panel also changes height for reasons neither element
   *  renders: a reply streaming in, a textarea growing under the caret, the
   *  viewport being resized. */
  private watchPanel(): void {
    if (this.sizer !== null) { return; }
    const panel = this.renderRoot.querySelector(".askcol");
    if (panel === null) { return; }
    const root = this.getRootNode() as ShadowRoot | Document;
    const page = (root as ShadowRoot).host as HTMLElement | undefined;
    this.sizer = new ResizeObserver((seen) => {
      const box = seen[0]?.contentRect;
      if (box === undefined) { return; }
      // The panel's own height plus the gap it sits in, so the last line
      // underneath clears its top edge rather than touching it.
      const space = `${Math.round(box.height) + 34}px`;
      page?.style.setProperty("--ask-space", space);
      this.dispatchEvent(new CustomEvent("dock-space", {
        detail: { space }, bubbles: true, composed: true }));
    });
    this.sizer.observe(panel);
  }

  /* Carry the picker into the composer's action row.
   *
   *  Awaited on the component, not on this element: on the pass after ours
   *  nr-chatbot has not rendered yet, so a synchronous query finds no row at
   *  all. Docked once — `parentNode === right` is the guard — and marked with a
   *  bare attribute so it never paints where lit first put it. */
  private async dockPicker(): Promise<void> {
    if (this.choices.length === 0) { return; }
    if (this.picker === null) { this.picker = this.renderRoot.querySelector("model-picker"); }
    const picker = this.picker;
    if (picker === null) { return; }
    const chat = this.renderRoot.querySelector("nr-chatbot") as
      (Element & { updateComplete?: Promise<unknown> }) | null;
    if (chat === null) { return; }
    await chat.updateComplete;
    const right = chat.shadowRoot?.querySelector(".action-buttons-right") ?? null;
    if (right === null || picker.parentNode === right) { return; }
    right.insertBefore(picker, right.firstChild);
    picker.setAttribute("docked", "");
  }

  /** What somebody typed, handed up. The host opens the right conversation and
   *  sends it — which differs per surface and is not this element's business. */
  private say(text: string): void {
    const said = text.trim();
    if (said === "") { return; }
    this.dispatchEvent(new CustomEvent("ask", {
      detail: { text: said }, bubbles: true, composed: true }));
  }

  render() {
    const state = this.session?.getState();
    const msgs = state?.messages ?? [];
    const followups = (state?.suggestions ?? []).map((s: { text: string }) => s.text);
    // The model's own next questions once there are any, this surface's
    // openers before that. Never both: two rows of pills over a page is the
    // thing the panel exists to stop.
    const chips = followups.length > 0 ? followups
      : (msgs.length === 0 ? this.starters : []);
    const hiding = msgs.length + (chips.length === 0 || this.busy ? 0 : 1);
    return html`
      <div class="askcol">
        ${hiding === 0 ? nothing : html`
          <button class="handle" @click=${() => { this.shut = !this.shut; }}
            title=${this.shut ? "Show the conversation" : "Fold the conversation away"}
            aria-expanded=${this.shut ? "false" : "true"}>
            ${this.shut
              ? html`<span class="count">${msgs.length}</span>`
              : html`<nr-icon name="chevron-down" size="small"></nr-icon>`}
          </button>`}
        ${this.shut || chips.length === 0 || this.busy ? nothing : html`
          <div class=${followups.length > 0 ? "chips" : "chips starters"}>
            ${chips.map((c) => html`
              <button class="chip" @click=${() => this.say(c)}>${c}</button>`)}
          </div>`}

        ${this.shut || msgs.length === 0 ? nothing : html`
          <div class="bubbles">
            ${msgs.map((m: { sender: string, text: string }) => html`
              <div class=${m.sender === "user" ? "bubble mine" : "bubble theirs"}
                .innerHTML=${m.text}></div>`)}
            ${this.busy ? html`
              <div class="bubble theirs working"><i></i><i></i><i></i></div>` : nothing}
          </div>`}

        <nr-chatbot
          class="ask-chat"
          .controller=${this.session}
          .isBotTyping=${this.busy}
          .isQueryRunning=${this.busy}
          .showMessages=${false}
          .messageCollapseThreshold=${1000000}
          boxed
          placeholder=${this.placeholder}
          .i18n=${{ input: { attachButton: "" }, send: { sendButton: "", stopButton: "" } }}
        ><span slot="empty-state"></span></nr-chatbot>

        <!-- Static, never inside a ternary, and moved into the composer's own
             action row once the component has rendered: the row lives in
             nr-chatbot's shadow root, so a control that belongs beside the send
             button has to be carried there. -->
        <model-picker
          .choices=${this.choices}
          .choiceId=${this.choiceId}
          @pick-choice=${(e: CustomEvent) => {
            this.choiceId = e.detail.id as string;
            // Passed on from this element rather than allowed to climb: the
            // picker's own event is deliberately neither bubbling nor
            // composed (model-picker.ts says why), so a host that wants to
            // remember the choice listens on <ask-dock> and gets it here.
            this.dispatchEvent(new CustomEvent("pick-choice", { detail: { id: this.choiceId } }));
          }}
        ></model-picker>

        ${this.shut || (this.note === "" && this.href === "") ? nothing : html`
          <div class="foot">
            <span>${this.note}</span>
            <span class="grow"></span>
            ${this.href === "" ? nothing : html`<a href=${this.href}>${this.hrefText}</a>`}
          </div>`}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { "ask-dock": AskDock; }
}

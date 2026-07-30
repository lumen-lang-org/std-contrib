// The shell: sidebar | header + chat | workspace. Each region is its own
// element in its own file; this one only wires them together. The chat area
// is LumenUI's <nr-chatbot>, driven through its properties and events —
// nothing here reaches into it.

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./ui.js";
import "./sidebar.js";
import "./workspace-panel.js";
import "./artifact-panel.js";
import "./settings.js";
import "./knowledge.js";
import "./canvas.js";
import "./login-overlay.js";
import {
  AgentRow, ArtifactListing, Me, ThreadListing, TurnArtifactRef, WireRef,
  SIGNED_OUT, artifactsByTurn, listAgents, listArtifacts, listThreads, previewUrl, whoami,
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

@customElement("agent-console")
export class AgentConsole extends LitElement {
  static styles = css`
    :host { display: flex; height: 100%; }
    console-sidebar { width: 264px; flex: none; }
    /* The scrim behind the drawer. Only ever rendered under the breakpoint,
       and it is what closes the drawer — a tap anywhere else. */
    .scrim { display: none; }
    .center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    header { display: flex; align-items: center; gap: 10px; padding: 10px 18px;
             border-bottom: 1px solid var(--border); background: var(--bg); }
    .title { font: 600 17px var(--display); overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; flex: 1; }
    .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px;
            border: 1px solid var(--border); border-radius: 999px; padding: 3px 11px;
            color: var(--muted); background: var(--bg-card); }
    .chip .bolt { color: var(--accent); }
    select { background: var(--bg-card); border: 1px solid var(--border); color: inherit;
             border-radius: 8px; padding: 4px 8px; font: inherit; }
    .icon { background: none; border: 1px solid var(--border); color: var(--muted);
            border-radius: 10px; padding: 4px 10px; cursor: pointer; font: inherit;
            transition: background-color .15s cubic-bezier(.23,1,.32,1),
                        color .15s cubic-bezier(.23,1,.32,1),
                        border-color .15s cubic-bezier(.23,1,.32,1); }
    .icon:hover { border-color: var(--accent); color: var(--fg); }
    .icon[aria-pressed="true"] { border-color: var(--accent); color: var(--fg);
                                 background: var(--bg-sunken); }
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
        box-shadow: 0 0 32px -8px rgba(0,0,0,.28);
      }
      :host([nav]) console-sidebar { transform: none; }
      :host([nav]) .scrim {
        display: block; position: fixed; inset: 0; z-index: 55;
        background: rgba(0,0,0,.28);
      }
      /* The drawer toggle only exists where the drawer does. */
      .icon.nav { display: inline-grid; }
      /* The second rail stops sharing the width and covers instead. */
      workspace-panel, artifact-panel {
        position: fixed; inset: 0 0 0 auto; z-index: 50;
        width: min(420px, 100vw); box-shadow: 0 0 32px -8px rgba(0,0,0,.28);
      }
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
      .title { font-size: 15px; }
      /* The model chip is the first thing to go: it names a choice you make
         rarely, and the picker beside it still says which agent is answering. */
      .chip { display: none; }
      workspace-panel, artifact-panel { width: 100vw; }
      .cards { padding: 8px 12px 12px; }
      .card { max-width: 100%; }
    }

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

  @state() private agents: AgentRow[] = [];
  @state() private agentId = "";
  @state() private threads: ThreadListing[] = [];
  @state() private threadId = "";
  // The transcript lives in the session, which is what nr-chatbot reads. Only
  // the typing flag is mirrored here, because the header and the composer's
  // placeholder are drawn on this side.
  @state() private busy = false;

  // One session for the pane. It is the controller nr-chatbot was missing:
  // without one, Enter did nothing at all.
  private session = new ChatSession({
    agentId: () => this.agentId,
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
  @state() private rail: "" | "workspace" | "artifacts" = "";
  @state() private settings = false;
  @state() private view: "chat" | "knowledge" | "canvas" = "chat";
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
  @property({ attribute: false }) seedTurns: unknown[] = [];
  @property({ attribute: false }) seedPast: unknown = { steps: [], thoughts: [] };

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
    if (this.seeded || this.seedTurns.length === 0) { return; }
    this.seeded = true;
    const id = this.conversation !== "" ? this.conversation : currentId();
    if (id === "") { return; }
    this.threadId = id;
    this.session.apply(this.seedTurns as never, this.seedPast as never);
  }

  async connectedCallback() {
    super.connectedCallback();
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
    // The run says what it is doing while it is doing it. Held here so the
    // card re-renders; the session owns the list and never rebuilds it.
    [this.agents, this.threads] = await Promise.all([listAgents(), listThreads()])
      .catch(() => [[], []] as [AgentRow[], ThreadListing[]]);
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.threadsTicker !== null) { clearInterval(this.threadsTicker); this.threadsTicker = null; }
    if (this.unlisten !== null) { this.unlisten(); this.unlisten = null; }
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
    await this.session.open(id);
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

  // A conversation that has artifacts opens with them showing. Only when
  // nothing else is showing: a workspace rail somebody chose stays.
  private followArtifacts() {
    if (this.turnRefs.length === 0 || this.rail !== "" || this.railClosed) return;
    this.rail = "artifacts";
  }

  // Clicking the rail that is already open closes it, which is what a pressed
  // toggle should do.
  private show(which: "workspace" | "artifacts") {
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
    // A turn that produced the conversation's first artifact opens the rail
    // for it — the same follow a thread click does.
    this.followArtifacts();
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
  private async chipClick(e: Event) {
    const path = e.composedPath() as HTMLElement[];
    const chip = path.find((el) => el?.getAttribute?.("data-diff-path"));
    if (!chip) return;
    this.rail = "artifacts";
    this.railClosed = false;
    await this.updateComplete;
    const panel = this.renderRoot.querySelector("artifact-panel") as
      (HTMLElement & { showDiff?: (p: string, v: number) => Promise<void> }) | null;
    await panel?.showDiff?.(chip.getAttribute("data-diff-path") ?? "",
      Number(chip.getAttribute("data-diff-version") ?? "0"));
  }

  render() {
    const cards = this.cards();
    return html`
      ${this.signedOut ? html`<login-overlay></login-overlay>` : ""}
      <div class="scrim" @click=${() => { this.nav = false; }}></div>
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
      ></console-sidebar>

      <div class="center">
        ${this.view === "knowledge" ? html`<knowledge-page></knowledge-page>`
          : this.view === "canvas" ? html`<agent-canvas></agent-canvas>` : html`
        <header>
          <button class="icon nav" title="Conversations"
            @click=${() => { this.nav = !this.nav; }}>
            <nr-icon name="panel-left" size="small"></nr-icon>
          </button>
          <span class="title">${this.threadTitle()}</span>
          <span class="chip"><nr-icon class="bolt" name="zap" size="small"></nr-icon>
            ${this.threadId === "" ? html`
              <select @change=${(e: Event) => { this.agentId = (e.target as HTMLSelectElement).value; }}>
                ${this.agents.map((a) => html`
                  <option value=${a.id} ?selected=${a.id === this.agentId}>${a.agentName}</option>`)}
              </select>` : this.agentName()}
          </span>
          <button class="icon" title="Workspace" aria-pressed=${this.rail === "workspace"}
            @click=${() => this.show("workspace")}><nr-icon name="folder" size="small"></nr-icon></button>
          <button class="icon" title="Artifacts" aria-pressed=${this.rail === "artifacts"}
            @click=${() => this.show("artifacts")}><nr-icon name="file-text" size="small"></nr-icon></button>
        </header>
        <main>
          <!-- The session is the controller. Messages are not passed in: the
               component reads them from the controller's state, and a second
               binding would fight it. The message-sent event is not listened
               for either - it is announced after a send, not a request to
               perform one. -->
          <!-- boxed is the Kimi home reading the component already knows:
               empty state centered in a 768px column, the composer joined
               beneath it at the page's upper third, chips underneath — and
               the ordinary bottom-pinned layout the moment messages exist. -->
          <nr-chatbot class=${this.session.getState().messages.length > 0 ? "talking" : ""}
            @click=${(e: Event) => { void this.chipClick(e); }}
            .controller=${this.session}
            .isBotTyping=${this.busy}
            .isQueryRunning=${this.busy}
            enable-file-upload
            boxed
            welcome-message="Agents."
            placeholder="Ask ${this.agentName()}…"
          ></nr-chatbot>
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

      ${this.rail === "workspace"
        ? html`<workspace-panel .threadId=${this.threadId}></workspace-panel>` : ""}
      ${this.rail === "artifacts"
        ? html`<artifact-panel .threadId=${this.threadId}
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

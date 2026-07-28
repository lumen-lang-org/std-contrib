// The shell: sidebar | header + chat | workspace. Each region is its own
// element in its own file; this one only wires them together. The chat area
// is LumenUI's <nr-chatbot>, driven through its properties and events —
// nothing here reaches into it.

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./ui.js";
import "./sidebar.js";
import "./workspace-panel.js";
import "./artifact-panel.js";
import "./settings.js";
import "./knowledge.js";
import "./canvas.js";
import {
  AgentRow, ArtifactListing, ThreadListing, TurnArtifactRef, WireRef,
  artifactsByTurn, listAgents, listArtifacts, listThreads, previewUrl,
} from "./api.js";
import { ChatSession } from "./chat-session.js";

@customElement("agent-console")
export class AgentConsole extends LitElement {
  static styles = css`
    :host { display: flex; height: 100%; }
    console-sidebar { width: 264px; flex: none; }
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
            border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; }
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

    .cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 18px 12px;
             border-top: 1px solid var(--border); background: var(--bg); }
    .card { display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
            border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px;
            background: var(--bg-card); color: var(--fg); cursor: pointer;
            font: inherit; text-align: left; max-width: 260px; }
    .card:hover { border-color: var(--accent); }
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
    onThreadOpened: (id) => { this.threadId = id; },
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

  async connectedCallback() {
    super.connectedCallback();
    this.session.on("state:changed", () => { this.busy = this.session.isTyping(); });
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
  }

  private async open(id: string) {
    this.threadId = id;
    const found = this.threads.find((t) => t.id === id);
    if (found) this.agentId = found.agentId;
    await this.session.open(id);
    await this.refreshRefs();
  }

  private fresh() { this.threadId = ""; this.turnRefs = []; this.session.fresh(); }

  // Clicking the rail that is already open closes it, which is what a pressed
  // toggle should do.
  private show(which: "workspace" | "artifacts") {
    this.rail = this.rail === which ? "" : which;
  }

  private async refreshThreads() {
    this.threads = await listThreads().catch(() => this.threads);
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

  render() {
    const cards = this.cards();
    return html`
      <console-sidebar
        .threads=${this.threads}
        .activeId=${this.threadId}
        @pick-thread=${(e: CustomEvent) => { this.view = "chat"; this.open(e.detail.id); }}
        @new-thread=${() => { this.view = "chat"; this.fresh(); }}
        @open-settings=${() => { this.settings = true; }}
        @open-knowledge=${() => { this.view = "knowledge"; }}
        @open-canvas=${() => { this.view = "canvas"; }}
      ></console-sidebar>

      <div class="center">
        ${this.view === "knowledge" ? html`<knowledge-page></knowledge-page>`
          : this.view === "canvas" ? html`<agent-canvas></agent-canvas>` : html`
        <header>
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
          <nr-chatbot
            .controller=${this.session}
            .isBotTyping=${this.busy}
            .isQueryRunning=${this.busy}
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
        ? html`<artifact-panel .threadId=${this.threadId}></artifact-panel>` : ""}
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

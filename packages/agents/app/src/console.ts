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
import { AgentRow, ThreadListing, listAgents, listThreads } from "./api.js";
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
    onTurnDone: () => { void this.refreshThreads(); },
  });
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
    [this.agents, this.threads] = await Promise.all([listAgents(), listThreads()])
      .catch(() => [[], []] as [AgentRow[], ThreadListing[]]);
    this.agents = this.agents.filter((a) => a.enabled);
    if (this.agents.length > 0) this.agentId = this.agents[0].id;
  }

  private async open(id: string) {
    this.threadId = id;
    const found = this.threads.find((t) => t.id === id);
    if (found) this.agentId = found.agentId;
    await this.session.open(id);
  }

  private fresh() { this.threadId = ""; this.session.fresh(); }

  // Clicking the rail that is already open closes it, which is what a pressed
  // toggle should do.
  private show(which: "workspace" | "artifacts") {
    this.rail = this.rail === which ? "" : which;
  }

  private async refreshThreads() {
    this.threads = await listThreads().catch(() => this.threads);
  }

  private async reloadAgents() {
    const listed = await listAgents().catch(() => this.agents);
    this.agents = listed.filter((a) => a.enabled);
    // An agent disabled while it was selected must not stay selected.
    if (!this.agents.some((a) => a.id === this.agentId)) {
      this.agentId = this.agents.length > 0 ? this.agents[0].id : "";
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
          <span class="chip"><span class="bolt">⚡</span>
            ${this.threadId === "" ? html`
              <select @change=${(e: Event) => { this.agentId = (e.target as HTMLSelectElement).value; }}>
                ${this.agents.map((a) => html`
                  <option value=${a.id} ?selected=${a.id === this.agentId}>${a.agentName}</option>`)}
              </select>` : this.agentName()}
          </span>
          <button class="icon" title="Workspace" aria-pressed=${this.rail === "workspace"}
            @click=${() => this.show("workspace")}>🗂</button>
          <button class="icon" title="Artifacts" aria-pressed=${this.rail === "artifacts"}
            @click=${() => this.show("artifacts")}>📄</button>
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
        </main>`}
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

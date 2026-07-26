// The shell: sidebar | header + chat | workspace. Each region is its own
// element in its own file; this one only wires them together. The chat area
// is LumenUI's <nr-chatbot>, driven through its properties and events —
// nothing here reaches into it.

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./ui.js";
import "./sidebar.js";
import "./workspace-panel.js";
import "./settings.js";
import {
  AgentRow, ThreadListing, listAgents, listThreads, openThread, say, transcript,
} from "./api.js";

type UiMessage = {
  id: string; sender: "user" | "bot"; text: string; timestamp: string; error?: boolean;
};

@customElement("agent-console")
export class AgentConsole extends LitElement {
  static styles = css`
    :host { display: flex; height: 100%; }
    console-sidebar { width: 250px; flex: none; }
    .center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    header { display: flex; align-items: center; gap: 10px; padding: 9px 14px;
             border-bottom: 1px solid #21262d; }
    .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; flex: 1; }
    .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px;
            border: 1px solid #21262d; border-radius: 999px; padding: 3px 10px; color: #b6bec8; }
    .chip .bolt { color: #ea580c; }
    select { background: #161b22; border: 1px solid #21262d; color: inherit;
             border-radius: 6px; padding: 4px 8px; font: inherit; }
    .icon { background: none; border: 1px solid #21262d; color: #b6bec8; border-radius: 6px;
            padding: 4px 9px; cursor: pointer; font: inherit; }
    main { flex: 1; min-height: 0; }
    nr-chatbot { height: 100%; }
  `;

  @state() private agents: AgentRow[] = [];
  @state() private agentId = "";
  @state() private threads: ThreadListing[] = [];
  @state() private threadId = "";
  @state() private messages: UiMessage[] = [];
  @state() private busy = false;
  @state() private panel = false;
  @state() private settings = false;

  async connectedCallback() {
    super.connectedCallback();
    [this.agents, this.threads] = await Promise.all([listAgents(), listThreads()])
      .catch(() => [[], []] as [AgentRow[], ThreadListing[]]);
    this.agents = this.agents.filter((a) => a.enabled);
    if (this.agents.length > 0) this.agentId = this.agents[0].id;
  }

  private push(m: Omit<UiMessage, "timestamp">) {
    this.messages = [...this.messages, { ...m, timestamp: new Date().toISOString() }];
  }

  private async open(id: string) {
    this.threadId = id;
    const found = this.threads.find((t) => t.id === id);
    if (found) this.agentId = found.agentId;
    const turns = await transcript(id);
    this.messages = turns.map((t, i) => ({
      id: `t${i}`, sender: t.role === "user" ? "user" : "bot",
      text: t.text, timestamp: new Date().toISOString(),
    }));
  }

  private fresh() { this.threadId = ""; this.messages = []; }

  private async send(text: string) {
    if (this.busy || text.trim() === "") return;
    this.busy = true;
    try {
      // Opened lazily on the first message — an empty conversation nobody
      // typed into is not worth a row.
      if (this.threadId === "") this.threadId = (await openThread(this.agentId)).id;
      this.push({ id: `u${this.messages.length}`, sender: "user", text });
      const reply = await say(this.threadId, text);
      this.push({
        id: reply.runId, sender: "bot",
        text: reply.ok ? reply.text : reply.error, error: !reply.ok,
      });
      this.threads = await listThreads();
    } catch (e) {
      this.push({
        id: `e${this.messages.length}`, sender: "bot",
        text: e instanceof Error ? e.message : String(e), error: true,
      });
    } finally { this.busy = false; }
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
        @pick-thread=${(e: CustomEvent) => this.open(e.detail.id)}
        @new-thread=${this.fresh}
      ></console-sidebar>

      <div class="center">
        <header>
          <span class="title">${this.threadTitle()}</span>
          <span class="chip"><span class="bolt">⚡</span>
            ${this.threadId === "" ? html`
              <select @change=${(e: Event) => { this.agentId = (e.target as HTMLSelectElement).value; }}>
                ${this.agents.map((a) => html`
                  <option value=${a.id} ?selected=${a.id === this.agentId}>${a.agentName}</option>`)}
              </select>` : this.agentName()}
          </span>
          <button class="icon" title="Workspace" @click=${() => { this.panel = !this.panel; }}>🗂</button>
          <button class="icon" title="Settings" @click=${() => { this.settings = true; }}>⚙</button>
        </header>
        <main>
          <nr-chatbot
            .messages=${this.messages}
            .isBotTyping=${this.busy}
            .isQueryRunning=${this.busy}
            placeholder="Ask ${this.agentName()}…"
            @nr-chatbot-message-sent=${(e: CustomEvent) =>
              this.send(e.detail?.metadata?.text ?? e.detail?.text ?? "")}
          ></nr-chatbot>
        </main>
      </div>

      ${this.panel ? html`<workspace-panel .threadId=${this.threadId}></workspace-panel>` : ""}
      ${this.settings ? html`<console-settings @close=${() => { this.settings = false; }}></console-settings>` : ""}
    `;
  }
}

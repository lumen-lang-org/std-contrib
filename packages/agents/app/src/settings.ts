// Settings: the database rows the platform runs on, editable while it runs —
// which is the point of the whole package. One tab per table, each a thin
// list-and-form over the API; the heavier editors (scopes, evals, traces)
// belong to later iterations and are absent rather than mocked.

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  AgentRow, ModelConfigRow, ModelRow, PromptRow, ServerRow, TracingStatus,
  configureTracing, createModel, createPrompt, createServer, listAgents,
  listConfigs, listModels, listPrompts, listProviders, listServers,
  setAgentModel, setAgentPrompt, setModelEnabled, setTracingSecret,
  storeProviderKey, tracingStatus,
} from "./api.js";

const TABS = ["Agents", "Models", "Prompts", "MCP", "Providers", "Tracing"] as const;
type Tab = typeof TABS[number];

@customElement("console-settings")
export class ConsoleSettings extends LitElement {
  static styles = css`
    :host { position: fixed; inset: 0; background: rgba(0,0,0,0.55);
            display: flex; align-items: center; justify-content: center; z-index: 40; }
    .modal { width: min(860px, 92vw); height: min(560px, 88vh); background: #0e1116;
             border: 1px solid #21262d; border-radius: 10px; display: flex; overflow: hidden; }
    aside { width: 150px; border-right: 1px solid #21262d; padding-top: 10px; }
    aside div { padding: 9px 16px; cursor: pointer; color: #b6bec8; font-size: 14px; }
    aside div.on { color: #e6edf3; background: #161b22; border-left: 2px solid #ea580c; }
    main { flex: 1; overflow-y: auto; padding: 16px 20px; font-size: 13.5px; }
    table { width: 100%; border-collapse: collapse; }
    td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: 600; }
    input, select, textarea { background: #161b22; border: 1px solid #21262d; color: inherit;
             border-radius: 6px; padding: 5px 8px; font: inherit; }
    button { background: #ea580c; color: #fff; border: 0; border-radius: 6px;
             padding: 5px 12px; cursor: pointer; font: inherit; }
    .row { display: flex; gap: 8px; margin: 10px 0; flex-wrap: wrap; align-items: center; }
    .close { position: absolute; margin: 10px; right: max(calc(50vw - 430px), 4vw);
             background: none; border: 0; color: #8b949e; font-size: 18px; cursor: pointer; }
    .note { color: #8b949e; }
    .err { color: #f85149; }
  `;

  @property() tab: Tab = "Agents";
  @state() private agents: AgentRow[] = [];
  @state() private models: ModelRow[] = [];
  @state() private configs: ModelConfigRow[] = [];
  @state() private prompts: PromptRow[] = [];
  @state() private servers: ServerRow[] = [];
  @state() private providers: string[] = [];
  @state() private tracing: TracingStatus | null = null;
  @state() private problem = "";

  async connectedCallback() {
    super.connectedCallback();
    await this.refresh();
  }

  private async refresh() {
    this.problem = "";
    try {
      [this.agents, this.models, this.configs, this.prompts, this.servers, this.providers, this.tracing] =
        await Promise.all([
          listAgents(), listModels(), listConfigs(), listPrompts(),
          listServers(), listProviders(), tracingStatus(),
        ]);
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async act(work: () => Promise<unknown>) {
    this.problem = "";
    try { await work(); await this.refresh(); }
    catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private field(form: HTMLElement, name: string): string {
    return (form.querySelector(`[name=${name}]`) as HTMLInputElement | null)?.value ?? "";
  }

  render() {
    return html`
      <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
        <aside>
          ${TABS.map((t) => html`
            <div class=${t === this.tab ? "on" : ""} @click=${() => { this.tab = t; }}>${t}</div>`)}
        </aside>
        <main>
          ${this.problem === "" ? "" : html`<p class="err">${this.problem}</p>`}
          ${this.renderTab()}
        </main>
      </div>
      <button class="close" @click=${() => this.dispatchEvent(new CustomEvent("close"))}>✕</button>
    `;
  }

  private renderTab() {
    switch (this.tab) {
      case "Agents": return this.agentsTab();
      case "Models": return this.modelsTab();
      case "Prompts": return this.promptsTab();
      case "MCP": return this.mcpTab();
      case "Providers": return this.providersTab();
      case "Tracing": return this.tracingTab();
    }
  }

  private agentsTab() {
    return html`
      <table>
        <tr><th>Agent</th><th>Model config</th><th>Prompt</th><th>Enabled</th></tr>
        ${this.agents.map((a) => html`<tr>
          <td title=${a.description}>${a.agentName}</td>
          <td><select @change=${(e: Event) =>
              this.act(() => setAgentModel(a.id, (e.target as HTMLSelectElement).value))}>
            ${this.configs.map((c) => html`
              <option value=${c.id} ?selected=${c.id === a.modelConfigId}>${c.id} · ${c.modelId}</option>`)}
          </select></td>
          <td><select @change=${(e: Event) =>
              this.act(() => setAgentPrompt(a.id, (e.target as HTMLSelectElement).value))}>
            ${this.prompts.map((p) => html`
              <option value=${p.id} ?selected=${p.id === a.promptId}>${p.promptName} v${p.version}</option>`)}
          </select></td>
          <td>${a.enabled ? "yes" : "no"}</td>
        </tr>`)}
      </table>
      <p class="note">Changing a model or prompt takes effect on the next message — no restart.</p>
    `;
  }

  private modelsTab() {
    return html`
      <table>
        <tr><th>Label</th><th>API name</th><th>Provider</th><th>Kind</th><th>Enabled</th></tr>
        ${this.models.map((m) => html`<tr>
          <td>${m.label}</td><td>${m.apiName}</td><td>${m.provider}</td><td>${m.kind}</td>
          <td><input type="checkbox" ?checked=${m.enabled}
            @change=${(e: Event) => this.act(() =>
              setModelEnabled(m.id, (e.target as HTMLInputElement).checked))} /></td>
        </tr>`)}
      </table>
      <div class="row" id="newModel">
        <input name="id" placeholder="id" style="width:70px" />
        <input name="label" placeholder="Label" />
        <input name="apiName" placeholder="api name" />
        <select name="provider"><option>mistral</option><option>openai</option></select>
        <select name="kind"><option>chat</option><option>embedding</option></select>
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => createModel({
            id: this.field(f, "id"), label: this.field(f, "label"),
            apiName: this.field(f, "apiName"), provider: this.field(f, "provider"),
            kind: this.field(f, "kind"), dimensions: 0, enabled: true,
          }));
        }}>Add</button>
      </div>
    `;
  }

  private promptsTab() {
    return html`
      <table>
        <tr><th>Name</th><th>Version</th><th>Content</th></tr>
        ${this.prompts.map((p) => html`<tr>
          <td>${p.promptName}</td><td>v${p.version}</td>
          <td class="note">${p.content.slice(0, 90)}${p.content.length > 90 ? "…" : ""}</td>
        </tr>`)}
      </table>
      <div class="row" id="newPrompt" style="align-items:flex-start">
        <input name="name" placeholder="name" />
        <textarea name="content" placeholder="Prompt text — saving creates the next version" rows="3" style="flex:1"></textarea>
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => createPrompt(this.field(f, "name"), this.field(f, "content")));
        }}>Save version</button>
      </div>
      <p class="note">Prompts are never edited — a change is a new version, and rollback is pointing an agent at an older one.</p>
    `;
  }

  private mcpTab() {
    return html`
      <table>
        <tr><th>Name</th><th>Endpoint</th><th>Transport</th><th>Enabled</th></tr>
        ${this.servers.map((s) => html`<tr>
          <td>${s.serverName}</td><td>${s.endpoint}</td><td>${s.transport}</td>
          <td>${s.enabled ? "yes" : "no"}</td>
        </tr>`)}
      </table>
      <div class="row" id="newServer">
        <input name="id" placeholder="id" style="width:70px" />
        <input name="serverName" placeholder="Name" />
        <input name="endpoint" placeholder="http://…" style="flex:1" />
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => createServer({
            id: this.field(f, "id"), serverName: this.field(f, "serverName"),
            endpoint: this.field(f, "endpoint"), transport: "http", enabled: true,
          }));
        }}>Add</button>
      </div>
    `;
  }

  private providersTab() {
    return html`
      <p>Credentials stored (names only — the API never returns a key): ${this.providers.join(", ") || "none"}</p>
      <div class="row" id="newKey">
        <select name="provider"><option>mistral</option><option>openai</option></select>
        <input name="apiKey" placeholder="sk-…" type="password" style="flex:1" />
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => storeProviderKey(this.field(f, "provider"), this.field(f, "apiKey")));
        }}>Store</button>
      </div>
      <p class="note">Keys are encrypted under LUMEN_MASTER_KEY and can be replaced but never read back.</p>
    `;
  }

  private tracingTab() {
    const t = this.tracing;
    return html`
      <p>Status: ${t === null ? "…" : t.configured ? (t.active ? "active" : "configured, disabled") : "not configured"}</p>
      <div class="row" id="traceCfg">
        <select name="backend">
          ${["langfuse", "otlp", "phoenix", "braintrust", "langsmith", "arize"].map((b) => html`
            <option ?selected=${t?.backend === b}>${b}</option>`)}
        </select>
        <input name="endpoint" placeholder="https://…/v1/traces" .value=${t?.endpoint ?? ""} style="flex:1" />
        <input name="publicKey" placeholder="public key / project / space" />
        <label><input name="enabled" type="checkbox" ?checked=${t?.active ?? false} /> enabled</label>
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => configureTracing({
            id: "default", backend: this.field(f, "backend"), endpoint: this.field(f, "endpoint"),
            publicKey: this.field(f, "publicKey"), serviceName: "lumen-agents", environment: "production",
            enabled: (f.querySelector("[name=enabled]") as HTMLInputElement).checked,
          }));
        }}>Save</button>
      </div>
      <div class="row" id="traceKey">
        <input name="secret" placeholder="secret key" type="password" style="flex:1" />
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => setTracingSecret(this.field(f, "secret")));
        }}>Store secret</button>
      </div>
    `;
  }
}

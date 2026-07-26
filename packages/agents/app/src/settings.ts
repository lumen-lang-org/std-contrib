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
  setModelEnabled, setTracingSecret,
  storeProviderKey, tracingStatus, updateAgent,
} from "./api.js";

const TABS = ["Agents", "Models", "Prompts", "MCP", "Providers", "Tracing"] as const;
type Tab = typeof TABS[number];

@customElement("console-settings")
export class ConsoleSettings extends LitElement {
  static styles = css`
    :host { position: fixed; inset: 0; background: rgba(31,30,29,0.4);
            display: flex; align-items: center; justify-content: center; z-index: 40; }
    .modal { width: min(860px, 92vw); height: min(560px, 88vh); background: var(--bg);
             border: 1px solid var(--border); border-radius: 14px; display: flex;
             overflow: hidden; box-shadow: 0 18px 50px rgba(31,30,29,0.18); }
    aside { width: 150px; border-right: 1px solid var(--border); padding-top: 12px;
            background: var(--bg-rail); }
    aside div { padding: 9px 16px; cursor: pointer; color: var(--muted); font-size: 14px;
                border-radius: 8px; margin: 1px 8px; }
    aside div.on { color: var(--fg); background: var(--bg-user); }
    main { flex: 1; overflow-y: auto; padding: 18px 22px; font-size: 13.5px; }
    table { width: 100%; border-collapse: collapse; }
    td, th { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; }
    input, select, textarea { background: var(--bg-card); border: 1px solid var(--border);
             color: inherit; border-radius: 8px; padding: 5px 9px; font: inherit; }
    button { background: var(--accent); color: var(--accent-fg); border: 0;
             border-radius: 8px; padding: 5px 13px; cursor: pointer; font: inherit; }
    button:hover { background: var(--accent-hover); }
    .row { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; align-items: center; }
    .close { position: absolute; margin: 10px; right: max(calc(50vw - 430px), 4vw);
             background: none; border: 0; color: var(--bg); font-size: 18px; cursor: pointer; }
    .note { color: var(--muted); }
    .err { color: #B3261E; }
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
  @state() private editing: AgentRow | null = null;
  // Which kind the "add model" row is on, so the dimensions input appears only
  // for an embedding model, where it is required.
  @state() private newKind = "chat";

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
    if (this.editing !== null) return this.agentForm(this.editing);
    return html`
      <table>
        <tr><th>Agent</th><th>Description</th><th>Model config</th><th>Prompt</th><th>Enabled</th><th></th></tr>
        ${this.agents.map((a) => html`<tr>
          <td>${a.agentName}</td>
          <td class="note">${a.description.slice(0, 40)}</td>
          <td>${a.modelConfigId}</td>
          <td>${this.prompts.find((p) => p.id === a.promptId)?.promptName ?? a.promptId}</td>
          <td>${a.enabled ? "yes" : "no"}</td>
          <td><button @click=${() => { this.editing = { ...a }; }}>Edit</button></td>
        </tr>`)}
      </table>
      <p class="note">Changes take effect on the next message — no restart.</p>
    `;
  }

  // One form, every editable field, one PUT. The row being edited is a copy,
  // so Cancel is just dropping it.
  private agentForm(a: AgentRow) {
    const bind = (field: keyof AgentRow) => (e: Event) => {
      const el = e.target as HTMLInputElement;
      this.editing = { ...this.editing!, [field]: el.type === "checkbox" ? el.checked : el.value };
    };
    return html`
      <h3 style="margin-top:0">Edit ${a.id}</h3>
      <div class="row"><label style="width:110px">Name</label>
        <input .value=${a.agentName} @input=${bind("agentName")} style="flex:1" /></div>
      <div class="row"><label style="width:110px">Description</label>
        <input .value=${a.description} @input=${bind("description")} style="flex:1" /></div>
      <div class="row"><label style="width:110px">Model config</label>
        <select @change=${bind("modelConfigId")}>
          ${this.configs.map((c) => html`
            <option value=${c.id} ?selected=${c.id === a.modelConfigId}>${c.id} · ${c.modelId}</option>`)}
        </select></div>
      <div class="row"><label style="width:110px">Prompt</label>
        <select @change=${bind("promptId")}>
          ${this.prompts.map((p) => html`
            <option value=${p.id} ?selected=${p.id === a.promptId}>${p.promptName} v${p.version}</option>`)}
        </select></div>
      <div class="row"><label style="width:110px">Enabled</label>
        <input type="checkbox" ?checked=${a.enabled} @change=${bind("enabled")} /></div>
      <div class="row">
        <button @click=${() => this.act(async () => { await updateAgent(this.editing!); this.editing = null; })}>Save</button>
        <button style="background:none;color:var(--muted);border:1px solid var(--border)"
          @click=${() => { this.editing = null; }}>Cancel</button>
      </div>
    `;
  }

  private modelsTab() {
    return html`
      <table>
        <tr><th>Label</th><th>API name</th><th>Provider</th><th>Kind</th><th>Enabled</th></tr>
        ${this.models.map((m) => html`<tr>
          <td>${m.label}</td><td>${m.apiName}</td><td>${m.provider}</td><td>${m.kind}</td>
          <td><input type=${m.kind === "embedding" ? "radio" : "checkbox"} name="embedder"
            ?checked=${m.enabled}
            @change=${(e: Event) => this.act(() =>
              setModelEnabled(m.id, (e.target as HTMLInputElement).checked))} /></td>
        </tr>`)}
      </table>
      <p class="note">One embedding model is active at a time, and turning one on turns
      the others off — documents embedded by different models cannot see each other, so a
      second active embedder splits the corpus with nothing to report it.</p>
      <div class="row" id="newModel">
        <input name="id" placeholder="id" style="width:70px" />
        <input name="label" placeholder="Label" />
        <input name="apiName" placeholder="api name" />
        <select name="provider">
          <option>mistral</option><option>openai</option><option>anthropic</option>
        </select>
        <select name="kind" @change=${(e: Event) => {
          this.newKind = (e.target as HTMLSelectElement).value;
        }}><option>chat</option><option>embedding</option></select>
        ${this.newKind === "embedding" ? html`
          <input name="dimensions" type="number" min="1" placeholder="dimensions"
            style="width:120px" title="How wide this model's vectors are — 1024 for mistral-embed" />` : ""}
        <label><input name="enabled" type="checkbox" checked /> enabled</label>
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => createModel({
            id: this.field(f, "id"), label: this.field(f, "label"),
            apiName: this.field(f, "apiName"), provider: this.field(f, "provider"),
            kind: this.field(f, "kind"),
            // Not a constant: an embedding model that lies about its width
            // builds a vector column the provider's own answers do not fit.
            dimensions: parseInt(this.field(f, "dimensions") || "0", 10),
            enabled: (f.querySelector("[name=enabled]") as HTMLInputElement).checked,
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
          <td class="note">${p.body.slice(0, 90)}${p.body.length > 90 ? "…" : ""}</td>
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
        <select name="transport"><option>http</option><option>sse</option></select>
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => createServer({
            id: this.field(f, "id"), serverName: this.field(f, "serverName"),
            endpoint: this.field(f, "endpoint"), transport: this.field(f, "transport"),
            enabled: true,
          }));
        }}>Add</button>
      </div>
    `;
  }

  private providersTab() {
    return html`
      <p>Credentials stored (names only — the API never returns a key): ${this.providers.join(", ") || "none"}</p>
      <div class="row" id="newKey">
        <select name="provider">
          <option>mistral</option><option>openai</option><option>anthropic</option>
        </select>
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
        <input name="serviceName" placeholder="service name" .value=${t?.serviceName ?? "lumen-agents"} />
        <input name="environment" placeholder="environment" .value=${t?.environment ?? "production"} />
        <label><input name="enabled" type="checkbox" ?checked=${t?.active ?? false} /> enabled</label>
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => configureTracing({
            id: "default", backend: this.field(f, "backend"), endpoint: this.field(f, "endpoint"),
            publicKey: this.field(f, "publicKey"),
            // Read back from the form, which was filled from the row. These
            // were constants, so anyone who opened this tab and pressed Save
            // filed a staging deployment's traces under "production".
            serviceName: this.field(f, "serviceName"),
            environment: this.field(f, "environment"),
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

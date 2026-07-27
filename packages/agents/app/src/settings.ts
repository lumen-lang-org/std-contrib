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
  setTracingSecret, storeProviderKey, tracingStatus,
  updateAgent, updateModel, updateServer, setServerAuth, testModel,
} from "./api.js";

// Each tab, with the mark that stands for it in the rail. The icons are the
// ones nr-icon carries — a name it does not have is drawn as the name itself.
const TABS = [
  { name: "Agents", icon: "message-square" },
  { name: "Models", icon: "zap" },
  { name: "Prompts", icon: "file-text" },
  { name: "MCP", icon: "code" },
  { name: "Providers", icon: "cloud" },
  { name: "Tracing", icon: "layers" },
] as const;
type Tab = typeof TABS[number]["name"];

@customElement("console-settings")
export class ConsoleSettings extends LitElement {
  static styles = css`
    /* The overlay inside is fixed and out of flow, which leaves this host with
       no box at all — and an element with no box is not "visible" to anything
       that asks, from a test to a screen reader. So the host stays a layer of
       its own and the overlay fills it. */
    :host { position: fixed; inset: 0; z-index: 40; }

    /* The surface, its scrim, its header and its dismissal all belong to
       nr-overlay. What is left here is the settings layout itself. */
    nr-overlay {
      --nuraly-color-overlay-surface: var(--bg);
      --nuraly-color-overlay-border: var(--border);
      --nuraly-color-overlay-text: var(--fg);
      --nuraly-color-overlay-muted: var(--muted);
      --nuraly-color-overlay-hover: var(--bg-sunken);
    }

    .body { flex: 1; display: flex; min-height: 0; width: 100%; }

    /* Left rail. Each item is an icon and a word; the active one is a filled
       pill rather than a coloured word, so the eye finds it by shape. */
    aside { width: 216px; flex: none; border-right: 1px solid var(--border);
            background: var(--bg-rail); padding: 12px 8px; overflow-y: auto; }
    aside .label { font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase;
                   color: var(--muted); font-weight: 600; padding: 4px 10px 8px; }
    aside .item { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
                  border-radius: 8px; cursor: pointer; color: var(--muted);
                  font-size: 14px; margin-bottom: 1px; }
    aside .item:hover { background: var(--bg-sunken); color: var(--fg); }
    aside .item.on { background: var(--bg-sunken); color: var(--fg); font-weight: 500; }
    aside .item .ic { width: 16px; display: grid; place-items: center; opacity: 0.8; }

    main { flex: 1; overflow-y: auto; padding: 22px 26px 30px; min-width: 0; }

    /* Page head: the title, and the one action that makes a new one. */
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
    .head h2 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; flex: 1; }
    .head .ic { color: var(--muted); }

    .primary { background: var(--accent); color: var(--accent-fg); border: 0;
               border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 500;
               cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .primary:hover { background: var(--accent-hover); }

    /* Tabs carry their count, so the number is read without opening them. */
    .tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--border);
            margin-bottom: 4px; }
    .tabs .tab { padding: 8px 2px; cursor: pointer; color: var(--muted);
                 border-bottom: 2px solid transparent; margin-bottom: -1px;
                 display: flex; align-items: center; gap: 7px; font-size: 14px; }
    .tabs .tab:hover { color: var(--fg); }
    .tabs .tab.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 500; }
    .tabs .tab .n { color: var(--muted); font-size: 12.5px;
                    font-variant-numeric: tabular-nums; }

    /* A group of rows, headed by what it is and how many. */
    .group { display: flex; align-items: center; padding: 16px 2px 6px; }
    .group .label { flex: 1; font-size: 11px; letter-spacing: 0.09em;
                    text-transform: uppercase; color: var(--muted); font-weight: 600; }
    .group .n { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }

    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 500; font-size: 12.5px; }
    tbody tr:hover { background: var(--bg-rail); }
    td.right { text-align: right; white-space: nowrap; }

    /* An id is a value to copy, not prose: monospace, on a sunken chip. */
    .slug { font-family: var(--mono); font-size: 12.5px; background: var(--bg-sunken);
            border-radius: 6px; padding: 2px 8px; color: var(--fg); }
    /* A tag is a label something was given, not a value it holds. */
    .tag { font-size: 12.5px; background: var(--bg-sunken); border-radius: 999px;
           padding: 2px 10px; color: var(--muted); font-style: italic; }
    .dim { color: var(--muted); }

    /* Row actions: ghosts until the row is under the pointer. */
    .act { background: none; border: 0; color: var(--muted); cursor: pointer;
           padding: 4px 6px; border-radius: 6px; font-size: 14px; }
    .act:hover { background: var(--bg-sunken); color: var(--fg); }
    .act.danger:hover { color: var(--danger); }

    input, select, textarea { background: var(--bg-card); border: 1px solid var(--border);
             color: inherit; border-radius: 8px; padding: 7px 10px; font: inherit; }
    input:focus-visible, select:focus-visible, textarea:focus-visible,
    .item:focus-visible, .tab:focus-visible, button:focus-visible {
      outline: 2px solid var(--focus); outline-offset: 1px; }
    button { background: var(--accent); color: var(--accent-fg); border: 0;
             border-radius: 8px; padding: 7px 14px; cursor: pointer; font: inherit; }
    button:hover { background: var(--accent-hover); }
    .row { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
    .note { color: var(--muted); }
    .err { color: var(--danger); }
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
  // What the last Test said, so the answer appears where the button is.
  @state() private probed = "";

  private async probe(id: string) {
    this.probed = "testing…";
    try {
      const r = await testModel(id);
      this.probed = r.ok
        ? (r.reply !== undefined ? `answered: ${r.reply}` : `answered, ${r.dimensions} dimensions`)
        : `failed: ${r.error ?? "no reason given"}`;
    } catch (e) {
      this.probed = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

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

  // How many rows each tab holds, so the rail and the tabs can say so without
  // being opened. A tab with nothing behind it shows nothing rather than a
  // zero, which reads as a count that failed to load.
  private countOf(tab: Tab): number {
    switch (tab) {
      case "Agents": return this.agents.length;
      case "Models": return this.models.length;
      case "Prompts": return this.prompts.length;
      case "MCP": return this.servers.length;
      default: return 0;
    }
  }

  render() {
    return html`
      <nr-overlay
        open
        label="Settings"
        allow-fullscreen
        @nr-close=${() => this.dispatchEvent(new CustomEvent("close"))}
      >
        <div class="body">
          <aside>
            <div class="label">Settings</div>
            ${TABS.map((t) => html`
              <div class="item ${t.name === this.tab ? "on" : ""}" data-tab=${t.name}
                @click=${() => { this.tab = t.name; }}>
                <span class="ic"><nr-icon name=${t.icon} size="small"></nr-icon></span>
                <span>${t.name}</span>
              </div>`)}
          </aside>
          <main>
            ${this.problem === "" ? "" : html`<p class="err">${this.problem}</p>`}
            ${this.renderTab()}
          </main>
        </div>
      </nr-overlay>
    `;
  }

  // The heading every tab shares: what it is, how many, and the one action
  // that adds another.
  private head(title: string, icon: string) {
    const n = this.countOf(title as Tab);
    return html`
      <div class="head">
        <span class="ic"><nr-icon name=${icon} size="small"></nr-icon></span>
        <h2>${title}</h2>
        ${n > 0 ? html`<span class="dim">${n}</span>` : ""}
      </div>`;
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
    const entry = this.agents.find((a) => a.isDefault);
    return html`
      ${this.head("Agents", "message-square")}

      <div class="group">
        <span class="label">General</span>
        <span class="n">${this.agents.length}</span>
      </div>

      <table>
        <tbody>
        ${this.agents.map((a) => html`<tr>
          <td>
            ${a.agentName}
            ${a.id === entry?.id ? html`<span class="tag">entry</span>` : ""}
          </td>
          <!-- What the agent is for. Dropped in the first pass of this table
               in favour of the id and the config, which is exactly backwards:
               those two are addresses, and this is the only column that says
               what the row does. -->
          <td class="dim">${a.description.length > 52 ? a.description.slice(0, 52) + "…" : a.description}</td>
          <td><span class="slug">${a.id}</span></td>
          <td><span class="tag">${this.prompts.find((p) => p.id === a.promptId)?.promptName ?? a.promptId}</span></td>
          <td class="dim">${a.enabled ? "" : "off"}</td>
          <td class="right">
            <button class="act" title="Edit ${a.agentName}"
              @click=${() => { this.editing = { ...a }; }}>✎</button>
          </td>
        </tr>`)}
        </tbody>
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
        <tr><th>Label</th><th>API name</th><th>Provider</th><th>Kind</th><th>Enabled</th><th></th></tr>
        ${this.models.map((m) => html`<tr>
          <td>${m.label}</td><td>${m.apiName}</td><td>${m.provider}</td><td>${m.kind}</td>
          <td><input type=${m.kind === "embedding" ? "radio" : "checkbox"} name="embedder"
            ?checked=${m.enabled}
            @change=${(e: Event) => this.act(() =>
              updateModel({ ...m, enabled: (e.target as HTMLInputElement).checked }))} /></td>
          <td><button class="ghost" @click=${() => this.probe(m.id)}>Test</button></td>
        </tr>`)}
      </table>
      <p class="note">One embedding model is active at a time, and turning one on turns
      the others off — documents embedded by different models cannot see each other, so a
      second active embedder splits the corpus with nothing to report it.</p>
      ${this.probed === "" ? "" : html`<p class="note">${this.probed}</p>`}
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
        <input name="baseUrl" placeholder="base url — blank for the provider's own"
          style="flex:1" title="An OpenAI-compatible gateway: Ollama, vLLM, a company proxy" />
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
            baseUrl: this.field(f, "baseUrl"),
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
          <td><input type="checkbox" ?checked=${s.enabled}
            @change=${(e: Event) => this.act(() =>
              updateServer({ ...s, enabled: (e.target as HTMLInputElement).checked }))} /></td>
        </tr>`)}
      </table>
      <div class="row" id="newAuth">
        <select name="authFor">
          ${this.servers.map((s) => html`<option value=${s.id}>${s.serverName}</option>`)}
        </select>
        <select name="authKind">
          <option value="none">no auth</option><option value="bearer">bearer</option>
          <option value="header">custom header</option>
        </select>
        <input name="authHeader" placeholder="header name" style="width:130px" />
        <input name="token" type="password" placeholder="token" style="flex:1" />
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => setServerAuth(this.field(f, "authFor"), this.field(f, "authKind"),
            this.field(f, "authHeader"), this.field(f, "token")));
        }}>Set auth</button>
      </div>
      <p class="note">A token is stored encrypted under the server's id and never read back.</p>
      <div class="row" id="newServer">
        <input name="id" placeholder="id" style="width:70px" />
        <input name="serverName" placeholder="Name" />
        <input name="endpoint" placeholder="http://…" style="flex:1" />
        <!-- Only what the API accepts. It offered "sse", which every create refused. -->
        <select name="transport"><option>http</option></select>
        <button @click=${(e: Event) => {
          const f = (e.target as HTMLElement).parentElement!;
          this.act(() => createServer({
            id: this.field(f, "id"), serverName: this.field(f, "serverName"),
            endpoint: this.field(f, "endpoint"), transport: this.field(f, "transport"),
            authKind: "none", authHeader: "", enabled: true,
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

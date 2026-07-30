// Settings: the database rows the platform runs on, editable while it runs —
// which is the point of the whole package.
//
// Every tab is the same shape, and the shape is borrowed from a settings modal
// with twice as many tabs as this one: a titled head over a hairline, the one
// action that makes a new row on the right, rows gathered under an uppercase
// group label with its count, and — this is the part that matters — a form
// that *replaces* the list instead of sitting underneath it as a strip of
// unlabelled boxes.
//
// What was here before was that strip: a `<table>` and a row of bare inputs
// whose only clue was a placeholder. A placeholder is not a label; it leaves
// the moment you type, so a half-filled form is a row of anonymous values.
//
// The layout is taken. The palette is not: this console's action colour is
// ink, and borrowing another product's indigo would have made it look like
// that product.

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  AgentFull, AgentRow, ModelConfigRow, ModelRow, PromptRow, ScriptImageRow, ServerRow,
  SkillFileRow, SkillRow, TracingStatus,
  configureTracing, createAgent, createConfig, createModel, createPrompt,
  createScriptImage, createServer, createSkill, createSkillFile, deleteAgent, deleteConfig,
  deleteModel, deleteScriptImage, deleteServer, deleteSkill, deleteSkillFile,
  updateScriptImage, listScriptImages,
  listAgents, listConfigs, listModels, listPrompts, listProviders, listServers,
  listSkillFiles, listSkills, linkSkill, unlinkSkill,
  setTracingSecret, storeProviderKey, tracingStatus,
  updateAgent, updateModel, updateServer, updateSkill, updateSkillFile, setServerAuth, testModel,
} from "./api.js";

// Each tab, with the mark that stands for it in the rail. The icons are the
// ones nr-icon carries — a name it does not have is drawn as the name itself.
const TABS = [
  { name: "Agents", icon: "message-square" },
  { name: "Models", icon: "zap" },
  { name: "Prompts", icon: "file-text" },
  { name: "Skills", icon: "sticky-note" },
  { name: "MCP", icon: "code" },
  { name: "Images", icon: "box" },
  { name: "Providers", icon: "cloud" },
  { name: "Tracing", icon: "layers" },
] as const;
type Tab = typeof TABS[number]["name"];

// "vertex" authenticates with a whole service-account JSON pasted as the
// key; the server mints short-lived OAuth tokens from it per request.
const PROVIDERS = ["mistral", "openai", "anthropic", "vertex"];
const BACKENDS = ["langfuse", "otlp", "phoenix", "braintrust", "langsmith", "arize"];

// The value a LumenUI field is now carrying. Read off the element rather than
// out of the event detail: nr-input, nr-select and nr-textarea each describe
// their payload differently, and `value` is the one thing all three agree on.
function valueOf(e: Event): string {
  return (e.target as unknown as { value?: string }).value ?? "";
}

const options = (values: string[]) => values.map((v) => ({ value: v, label: v }));

// The values this form offers, plus whatever the row already holds. A row
// stored before the list was what it is now still shows what it actually is,
// rather than being silently redrawn as the first option that happens to fit.
const withCurrent = (values: string[], current: string) =>
  options(current === "" || values.includes(current) ? values : [...values, current]);

// What is open on top of a list. A form replaces its list, so this is one
// value rather than a flag per table.
type View =
  | { kind: "list" }
  | { kind: "agent"; row: AgentRow; fresh: boolean }
  | { kind: "model"; row: ModelRow; fresh: boolean }
  | { kind: "config"; row: ModelConfigRow }
  | { kind: "prompt"; row: { promptName: string; body: string } }
  // A skill's files ride the view: they are loaded when the form opens and
  // edited beside the body, each write its own call.
  | { kind: "skill"; row: SkillRow; fresh: boolean; files: SkillFileRow[] }
  | { kind: "server"; row: ServerRow & { token: string }; fresh: boolean }
  | { kind: "image"; row: ScriptImageRow }
  | { kind: "key"; row: { provider: string; apiKey: string } };

const NEW_AGENT: AgentRow = {
  id: "", agentName: "", description: "", modelConfigId: "", promptId: "",
  enabled: true, isDefault: false, scriptImageId: "",
};
const NEW_MODEL: ModelRow = {
  id: "", label: "", apiName: "", provider: "mistral", kind: "chat",
  dimensions: 0, baseUrl: "", enabled: true,
};
const NEW_CONFIG: ModelConfigRow = {
  id: "", modelId: "", temperature: 0.2, maxTokens: 4096, topP: 1, extra: "",
};
const NEW_SERVER: ServerRow & { token: string } = {
  id: "", serverName: "", transport: "http", endpoint: "",
  authKind: "none", authHeader: "", enabled: true, token: "",
};

// What markdown looks like while it is being written. Weight and shape carry
// most of it — a heading is heavier, emphasis leans, a quote greys out — with
// one hue for the two things that are addresses rather than prose: a link and
// a piece of code.
const MARKDOWN_TOKENS = `
  .hljs-section { color: var(--fg, #17171A); font-weight: 650; }
  .hljs-strong { font-weight: 700; }
  .hljs-emphasis { font-style: italic; }
  .hljs-bullet { color: var(--muted, #6B6B76); }
  .hljs-quote { color: var(--muted, #6B6B76); font-style: italic; }
  .hljs-code { color: #0F766E; }
  .hljs-link, .hljs-symbol { color: var(--focus, #2563EB); }
`;

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

    main { flex: 1; overflow-y: auto; padding: 22px 26px 40px; min-width: 0; }

    /* Page head: what this tab is, over a hairline that runs the width of the
       page. The hairline is what makes the head a head rather than a first
       paragraph. */
    .head { display: flex; align-items: center; gap: 10px;
            padding-bottom: 14px; border-bottom: 1px solid var(--border); }
    .head h2 { margin: 0; font-size: 19px; font-weight: 600;
               letter-spacing: -0.01em; flex: 1; }
    .head .ic { color: var(--muted); }

    /* The actions that make new rows, right-aligned under the rule. */
    .bar { display: flex; justify-content: flex-end; gap: 8px; margin: 16px 0 2px; }

    .primary, .ghost { border-radius: 8px; padding: 8px 14px; font: inherit;
                       font-weight: 500; cursor: pointer;
                       display: inline-flex; align-items: center; gap: 6px; }
    .primary { background: var(--accent); color: var(--accent-fg); border: 0; }
    .primary:hover { background: var(--accent-hover); }
    .ghost { background: var(--bg); color: var(--fg); border: 1px solid var(--border); }
    .ghost:hover { background: var(--bg-sunken); }

    /* A group of rows, headed by what it is and how many. */
    .group { display: flex; align-items: baseline; padding: 20px 2px 4px; }
    .group .label { flex: 1; font-size: 11px; letter-spacing: 0.09em;
                    text-transform: uppercase; color: var(--muted); font-weight: 600; }
    .group .n { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }

    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 500; font-size: 12.5px; }
    tbody tr:hover { background: var(--bg-rail); }
    td.right { text-align: right; white-space: nowrap; width: 1%; }
    td.name { font-weight: 500; white-space: nowrap; }
    td.fill { width: 60%; }

    /* An id is a value to copy, not prose: monospace, on a sunken chip. */
    .slug { font-family: var(--mono); font-size: 12.5px; background: var(--bg-sunken);
            border-radius: 6px; padding: 2px 8px; color: var(--fg);
            white-space: nowrap; }
    /* A tag is a label something was given, not a value it holds. */
    .tag { font-size: 12.5px; background: var(--bg-sunken); border-radius: 999px;
           padding: 2px 10px; color: var(--muted); font-style: italic;
           white-space: nowrap; }
    .tag.live { color: var(--ok); font-style: normal; }
    .tag.off { color: var(--danger); font-style: normal; }
    .dim { color: var(--muted); }
    .trunc { display: block; max-width: 46ch; overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }

    /* Row actions: ghosts until the row is under the pointer. */
    .acts { display: inline-flex; gap: 2px; }
    .act { background: none; border: 0; color: var(--muted); cursor: pointer;
           padding: 5px 6px; border-radius: 6px; line-height: 0; }
    .act:hover { background: var(--bg-sunken); color: var(--fg); }
    .act.danger:hover { color: var(--danger); }

    /* --- forms ------------------------------------------------------------ */

    .formhead { display: flex; align-items: center; gap: 12px; margin: 18px 0 20px; }
    .formhead h3 { margin: 0; font-size: 16px; font-weight: 500; }

    /* Something true about the row that no field can hold. */
    .banner { background: var(--bg-rail); border: 1px solid var(--border);
              border-radius: 8px; padding: 11px 14px; color: var(--muted);
              margin-bottom: 22px; }

    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 20px 24px; max-width: 1000px; align-items: start; }
    .f { display: flex; flex-direction: column; min-width: 0; }
    .f.wide { grid-column: 1 / -1; }
    .f .help { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.45; }
    /* The label belongs to the field, so it is slotted into the component
       rather than sitting beside it — that is what a screen reader reads. */
    [slot="label"], .f > .label { display: block; font-size: 13px; font-weight: 500;
                     margin-bottom: 6px; color: var(--fg); }
    /* The editor keeps the border the rest of the fields have, and a ground
       that is the page rather than the component's own near-white. */
    nr-code-editor::part(editor-container) {
      border-color: var(--border); background: var(--bg-card);
    }
    .req { color: var(--danger); font-style: normal; margin-left: 2px; }
    nr-input, nr-select, nr-textarea { display: block; width: 100%; }
    /* A checkbox is its own label, so it needs the room a label would take. */
    .f.check { justify-content: end; padding-top: 22px; }
    /* LumenUI fills a checked box violet — a hue this console spends on the
       graph, where a colour means which kind of node something is. The colour
       is hard-coded inside the component, so its exposed part is the way in. */
    nr-checkbox[checked]::part(input) {
      background-color: var(--accent); border-color: var(--accent);
    }
    nr-checkbox:hover::part(input) { border-color: var(--accent); }

    .formacts { display: flex; gap: 8px; margin-top: 26px; padding-top: 18px;
                border-top: 1px solid var(--border); max-width: 1000px; }

    .note { color: var(--muted); font-style: italic; margin-top: 22px; }
    .err { color: var(--danger); margin: 12px 0 0; }
    .said { color: var(--muted); margin: 12px 0 0;
            font-family: var(--mono); font-size: 12.5px; }
    .empty { color: var(--muted); padding: 18px 2px; }

    :focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  `;

  @property() tab: Tab = "Agents";
  @state() private agents: AgentFull[] = [];
  @state() private models: ModelRow[] = [];
  @state() private configs: ModelConfigRow[] = [];
  @state() private prompts: PromptRow[] = [];
  @state() private skills: SkillRow[] = [];
  @state() private images: ScriptImageRow[] = [];
  // The agent form's skill checklist, drafted here and diffed against the
  // stored links on save — the canvas's diff-apply idea, in form clothes.
  @state() private skillDraft: string[] = [];
  @state() private servers: ServerRow[] = [];
  @state() private providers: string[] = [];
  @state() private tracing: TracingStatus | null = null;
  @state() private problem = "";
  @state() private view: View = { kind: "list" };
  // What the last Test said, so the answer appears where the button is.
  @state() private probed = "";
  // The tracing panel is a form with no list, so its draft lives here.
  @state() private trace = {
    backend: "langfuse", endpoint: "", publicKey: "",
    serviceName: "lumen-agents", environment: "production", enabled: false,
    secret: "",
  };

  async connectedCallback() {
    super.connectedCallback();
    await this.refresh();
  }

  // highlight.js labels markdown with token classes the editor's own
  // stylesheet has no colours for: it dresses javascript, json and css and
  // stops there, so a prompt highlighted "as markdown" came out uniformly
  // black — spans everywhere, not one of them visible. The spans live inside
  // that component's shadow root, where a rule of ours cannot reach, so the
  // sheet is handed to the root itself. Custom properties do cross a shadow
  // boundary, which is what keeps this on the console's palette instead of
  // introducing a second one.
  protected updated() {
    for (const el of this.renderRoot.querySelectorAll("nr-code-editor")) {
      const root = el.shadowRoot as (ShadowRoot & { dressed?: boolean }) | null;
      if (root === null || root.dressed === true) continue;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(MARKDOWN_TOKENS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      root.dressed = true;
    }
  }

  private async refresh() {
    this.problem = "";
    try {
      [this.agents, this.models, this.configs, this.prompts, this.servers, this.providers, this.tracing, this.images, this.skills] =
        await Promise.all([
          listAgents(), listModels(), listConfigs(), listPrompts(),
          listServers(), listProviders(), tracingStatus(), listScriptImages(), listSkills(),
        ]);
      const t = this.tracing;
      if (t !== null) {
        this.trace = {
          ...this.trace,
          backend: t.backend === "" ? "langfuse" : t.backend,
          endpoint: t.endpoint,
          serviceName: t.serviceName === "" ? "lumen-agents" : t.serviceName,
          environment: t.environment === "" ? "production" : t.environment,
          enabled: t.active,
        };
      }
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  // Every write goes through here: the list is re-read from the server rather
  // than patched in place, so what is on screen is what was stored.
  private async act(work: () => Promise<unknown>, then: View = { kind: "list" }) {
    this.problem = "";
    try {
      await work();
      await this.refresh();
      this.view = then;
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

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

  private close() { this.view = { kind: "list" }; this.problem = ""; }

  // Editing a row edits a copy of it, so Cancel is dropping the copy.
  private open(view: View) { this.view = view; this.problem = ""; }

  private patch(fields: Record<string, unknown>) {
    const v = this.view;
    if (v.kind === "list") return;
    this.view = { ...v, row: { ...v.row, ...fields } } as View;
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
                @click=${() => { this.tab = t.name; this.close(); }}>
                <span class="ic"><nr-icon name=${t.icon} size="small"></nr-icon></span>
                <span>${t.name}</span>
              </div>`)}
          </aside>
          <main>
            ${this.renderTab()}
            ${this.problem === "" ? "" : html`<p class="err" role="alert">${this.problem}</p>`}
          </main>
        </div>
      </nr-overlay>
    `;
  }

  private renderTab() {
    switch (this.tab) {
      case "Agents": return this.agentsTab();
      case "Models": return this.modelsTab();
      case "Prompts": return this.promptsTab();
      case "Skills": return this.skillsTab();
      case "MCP": return this.mcpTab();
      case "Images": return this.imagesTab();
      case "Providers": return this.providersTab();
      case "Tracing": return this.tracingTab();
    }
  }

  // --- the pieces every tab is built from ---------------------------------------------

  private head(title: string, icon: string) {
    return html`
      <div class="head">
        <span class="ic"><nr-icon name=${icon} size="small"></nr-icon></span>
        <h2>${title}</h2>
      </div>`;
  }

  // A count is shown when there is something to count. A group that is a
  // heading rather than a list — the tracing secret — would otherwise carry a
  // "0" that reads as a number that failed to load.
  private group(label: string, n?: number) {
    return html`
      <div class="group"><span class="label">${label}</span>
        ${n === undefined ? "" : html`<span class="n">${n}</span>`}</div>`;
  }

  private formHead(title: string) {
    return html`
      <div class="formhead">
        <button class="act" title="Back to the list" @click=${() => this.close()}>
          <nr-icon name="chevron-left" size="small"></nr-icon>
        </button>
        <h3>${title}</h3>
      </div>`;
  }

  private formActions(save: () => void, label = "Save") {
    return html`
      <div class="formacts">
        <button class="primary" @click=${save}>${label}</button>
        <button class="ghost" @click=${() => this.close()}>Cancel</button>
      </div>`;
  }

  // A field is described, not spelled out: one record per field rather than a
  // line of positional arguments nobody can read at the call site.
  private text(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    required?: boolean; help?: string; placeholder?: string; type?: string;
    wide?: boolean; disabled?: boolean;
  }) {
    return html`
      <div class="f ${f.wide === true ? "wide" : ""}">
        <nr-input id=${f.id} .value=${f.value} type=${f.type ?? "text"}
          placeholder=${f.placeholder ?? ""} ?disabled=${f.disabled === true}
          @nr-input=${(e: Event) => f.on(valueOf(e))}
          @input=${(e: Event) => f.on(valueOf(e))}>
          <span slot="label">${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        </nr-input>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private choice(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    options: { value: string; label: string }[];
    required?: boolean; help?: string; wide?: boolean;
  }) {
    return html`
      <div class="f ${f.wide === true ? "wide" : ""}">
        <!-- block, or the field sizes itself to its longest option and a form
             of full-width boxes has one field that is not. -->
        <nr-select block id=${f.id} .value=${f.value} .options=${f.options}
          @nr-change=${(e: Event) => f.on(valueOf(e))}>
          <span slot="label">${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        </nr-select>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private area(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    rows?: number; required?: boolean; help?: string; placeholder?: string;
  }) {
    return html`
      <div class="f wide">
        <!-- outlined: nr-textarea defaults to an underline while nr-input
             defaults to a box, so a form with both has one field that reads as
             a different kind of control. -->
        <nr-textarea variant="outlined" id=${f.id} .value=${f.value} rows=${f.rows ?? 6}
          placeholder=${f.placeholder ?? ""}
          @nr-input=${(e: Event) => f.on(valueOf(e))}
          @input=${(e: Event) => f.on(valueOf(e))}>
          <span slot="label">${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        </nr-textarea>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  // A prompt is written rather than filled in, so it gets an editor rather
  // than a box: monospace, its own scroll, and markdown highlighted as it is
  // typed — headings, lists, emphasis and fenced code all visible without
  // rendering anything. The component is CodeJar over a contenteditable, which
  // is why the value arrives on the event's detail: there is no <textarea>
  // underneath to read `.value` from.
  private editor(f: {
    id: string; label: string; value: string; on: (v: string) => void;
    language?: string; height?: string; required?: boolean; help?: string;
  }) {
    return html`
      <div class="f wide">
        <span class="label" id="${f.id}-label">
          ${f.label}${f.required === true ? html`<em class="req">*</em>` : ""}</span>
        <nr-code-editor
          id=${f.id}
          theme="vs"
          language=${f.language ?? "markdown"}
          word-wrap
          .code=${f.value}
          style=${`height:${f.height ?? "420px"}`}
          @nr-change=${(e: CustomEvent) => f.on((e.detail as { value: string }).value)}>
        </nr-code-editor>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private check(f: {
    id: string; label: string; checked: boolean; on: (v: boolean) => void; help?: string;
  }) {
    return html`
      <div class="f check">
        <nr-checkbox id=${f.id} ?checked=${f.checked}
          @nr-change=${(e: CustomEvent) => f.on(e.detail.checked as boolean)}>${f.label}</nr-checkbox>
        ${f.help === undefined ? "" : html`<p class="help">${f.help}</p>`}
      </div>`;
  }

  private rowActions(items: { icon: string; title: string; danger?: boolean; run: () => void }[]) {
    return html`
      <td class="right"><span class="acts">
        ${items.map((i) => html`
          <button class="act ${i.danger === true ? "danger" : ""}" title=${i.title}
            @click=${i.run}><nr-icon name=${i.icon} size="small"></nr-icon></button>`)}
      </span></td>`;
  }

  // --- agents -------------------------------------------------------------------------

  private agentsTab() {
    const v = this.view;
    if (v.kind === "agent") return this.agentForm(v.row, v.fresh);
    const entry = this.agents.find((a) => a.isDefault);
    return html`
      ${this.head("Agents", "message-square")}
      <div class="bar">
        <button class="primary" data-new="agent"
          @click=${() => { this.skillDraft = []; this.open({ kind: "agent", row: { ...NEW_AGENT,
            modelConfigId: this.configs[0]?.id ?? "", promptId: this.prompts[0]?.id ?? "" },
            fresh: true }); }}>
          <nr-icon name="plus" size="small"></nr-icon> New agent
        </button>
      </div>

      ${this.group("General", this.agents.length)}
      <table><tbody>
        ${this.agents.map((a) => html`<tr>
          <td class="name">${a.agentName}</td>
          <td><span class="slug">${a.id}</span></td>
          <!-- What the agent is for. Dropped in the first pass of this table
               in favour of the id and the config, which is exactly backwards:
               those two are addresses, and this is the only column that says
               what the row does. -->
          <td class="fill dim"><span class="trunc">${a.description}</span></td>
          <td><span class="tag">${this.prompts.find((p) => p.id === a.promptId)?.promptName ?? a.promptId}</span></td>
          <td>${a.id === entry?.id ? html`<span class="tag live">entry</span>` : ""}
              ${a.enabled ? "" : html`<span class="tag off">off</span>`}</td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${a.agentName}`, run: () => {
              this.skillDraft = (a.skills ?? []).map((s) => s.id);
              this.open({ kind: "agent", row: { ...a }, fresh: false });
            } },
            { icon: "trash", title: `Delete ${a.agentName}`, danger: true,
              run: () => this.act(() => deleteAgent(a.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">Changes take effect on the next message — no restart.</p>
    `;
  }

  private agentForm(a: AgentRow, fresh: boolean) {
    return html`
      ${this.formHead(fresh ? "New agent" : `Edit ${a.agentName}`)}
      <div class="banner">A change here is read by the next message of every
        conversation already open — there is no restart and no reconnect.</div>

      <div class="grid">
        ${this.text({ id: "a-name", label: "Name", value: a.agentName, required: true,
          placeholder: "What this agent is called", on: (v) => this.patch({ agentName: v }) })}
        ${this.text({ id: "a-id", label: "Id", value: a.id, required: true,
          disabled: !fresh, placeholder: "support-desk",
          help: fresh ? "Its address everywhere else — in the API, in a link, on the graph. It cannot be changed later."
                      : "An id is what other rows point at, so it is fixed once the row exists.",
          on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "a-desc", label: "Description", value: a.description, wide: true,
          placeholder: "What this agent is for", on: (v) => this.patch({ description: v }) })}
        ${this.choice({ id: "a-config", label: "Model configuration", value: a.modelConfigId,
          options: this.configs.map((c) => ({ value: c.id, label: `${c.id} · ${c.modelId}` })),
          required: true,
          help: "Which model answers, and the temperature and token budget it answers with.",
          on: (v) => this.patch({ modelConfigId: v }) })}
        ${this.choice({ id: "a-prompt", label: "Prompt", value: a.promptId,
          options: this.prompts.map((p) => ({ value: p.id, label: `${p.promptName} v${p.version}` })),
          required: true,
          help: "Prompts are versioned rather than edited; rolling back is pointing this at an older one.",
          on: (v) => this.patch({ promptId: v }) })}
        ${this.choice({ id: "a-image", label: "Script environment", value: a.scriptImageId,
          options: [{ value: "", label: "Deployment default" }].concat(
            this.images.filter((i) => i.enabled).map((i) => ({ value: i.id, label: `${i.label} · ${i.image}` }))),
          help: "The image this agent's script containers are built from. Its conversations inherit it when the container is created; changing it here affects the next one, not the ones already running.",
          on: (v) => this.patch({ scriptImageId: v }) })}
        ${this.check({ id: "a-enabled", label: "Enabled", checked: a.enabled,
          help: "A disabled agent keeps its rows and its history; it just cannot be opened.",
          on: (v) => this.patch({ enabled: v }) })}
        ${this.check({ id: "a-default", label: "Entry agent", checked: a.isDefault,
          help: "The agent a new conversation opens against. Exactly one, so turning this on turns another off.",
          on: (v) => this.patch({ isDefault: v }) })}
      </div>

      ${this.skills.length === 0 ? "" : html`
        ${this.group("Skills", this.skillDraft.length)}
        <div class="grid">
          ${this.skills.map((k) => this.check({
            id: `a-skill-${k.skillName}`, label: k.skillName,
            checked: this.skillDraft.includes(k.id),
            help: k.description,
            on: (on) => { this.skillDraft = on
              ? [...this.skillDraft.filter((x) => x !== k.id), k.id]
              : this.skillDraft.filter((x) => x !== k.id); } }))}
        </div>
      `}

      ${this.formActions(() => this.act(async () => {
        // The row first — a fresh agent needs to exist before a link can name
        // it — then the checklist's diff against what was stored.
        if (fresh) { await createAgent(a); } else { await updateAgent(a); }
        const before = fresh ? [] : (this.agents.find((x) => x.id === a.id)?.skills ?? []).map((s) => s.id);
        for (const id of this.skillDraft.filter((x) => !before.includes(x))) { await linkSkill(a.id, id); }
        for (const id of before.filter((x) => !this.skillDraft.includes(x))) { await unlinkSkill(a.id, id); }
      }))}
    `;
  }

  // --- models and their configurations ------------------------------------------------

  private modelsTab() {
    const v = this.view;
    if (v.kind === "model") return this.modelForm(v.row, v.fresh);
    if (v.kind === "config") return this.configForm(v.row);

    const chat = this.models.filter((m) => m.kind !== "embedding");
    const embedding = this.models.filter((m) => m.kind === "embedding");
    return html`
      ${this.head("Models", "zap")}
      <div class="bar">
        <button class="ghost" data-new="config"
          @click=${() => this.open({ kind: "config", row: { ...NEW_CONFIG,
            modelId: this.models.find((m) => m.kind !== "embedding")?.id ?? "" } })}>
          <nr-icon name="settings" size="small"></nr-icon> New configuration
        </button>
        <button class="primary" data-new="model"
          @click=${() => this.open({ kind: "model", row: { ...NEW_MODEL }, fresh: true })}>
          <nr-icon name="plus" size="small"></nr-icon> New model
        </button>
      </div>

      ${this.group("Generation", chat.length)}
      <table><tbody>${chat.map((m) => this.modelRow(m))}</tbody></table>

      ${this.group("Embedding", embedding.length)}
      <table><tbody>${embedding.map((m) => this.modelRow(m))}</tbody></table>
      <p class="note">One embedding model is active at a time, and turning one on turns
      the others off — documents embedded by different models cannot see each other, so a
      second active embedder splits the corpus with nothing to report it.</p>

      ${this.group("Configurations", this.configs.length)}
      <table><tbody>
        ${this.configs.map((c) => html`<tr>
          <td class="name">${c.id}</td>
          <td><span class="slug">${c.modelId}</span></td>
          <td class="fill dim">temperature ${c.temperature} · ${c.maxTokens} max tokens · top-p ${c.topP}</td>
          ${this.rowActions([
            { icon: "trash", title: `Delete ${c.id}`, danger: true,
              run: () => this.act(() => deleteConfig(c.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">A configuration is created and repointed rather than edited: an agent
      mid-conversation reads it every round.</p>

      ${this.probed === "" ? "" : html`<p class="said">${this.probed}</p>`}
    `;
  }

  private modelRow(m: ModelRow) {
    return html`<tr>
      <td class="name">${m.label}</td>
      <td><span class="tag">${m.provider}</span></td>
      <td><span class="slug">${m.apiName}</span></td>
      <td class="fill dim">${m.baseUrl === "" ? "" : m.baseUrl}
        ${m.kind === "embedding" && m.dimensions > 0 ? `${m.dimensions} dimensions` : ""}</td>
      <td>${m.enabled ? html`<span class="tag live">on</span>` : html`<span class="tag off">off</span>`}</td>
      ${this.rowActions([
        { icon: "play", title: `Test ${m.label}`, run: () => this.probe(m.id) },
        { icon: "edit", title: `Edit ${m.label}`, run: () => this.open({ kind: "model", row: { ...m }, fresh: false }) },
        { icon: "trash", title: `Delete ${m.label}`, danger: true, run: () => this.act(() => deleteModel(m.id)) },
      ])}
    </tr>`;
  }

  private modelForm(m: ModelRow, fresh: boolean) {
    const embedding = m.kind === "embedding";
    return html`
      ${this.formHead(fresh ? "New model" : `Edit ${m.label}`)}
      <div class="grid">
        ${this.text({ id: "m-label", label: "Name", value: m.label, required: true,
          placeholder: "What to call it here", on: (v) => this.patch({ label: v }) })}
        ${this.text({ id: "m-id", label: "Id", value: m.id, required: true, disabled: !fresh,
          placeholder: "mistral-small", on: (v) => this.patch({ id: v }) })}
        ${this.choice({ id: "m-provider", label: "Provider", value: m.provider, required: true,
          options: withCurrent(PROVIDERS, m.provider), on: (v) => this.patch({ provider: v }) })}
        ${this.text({ id: "m-apiname", label: "Model identifier", value: m.apiName, required: true,
          placeholder: "mistral-small-latest",
          help: "The name the provider itself knows it by.",
          on: (v) => this.patch({ apiName: v }) })}
        ${this.text({ id: "m-baseurl", label: "Base URL", value: m.baseUrl, wide: true,
          placeholder: "https://api.groq.com/openai/v1",
          help: "Blank for the provider's own address; fill it in for an OpenAI-compatible host — a gateway, a proxy, Ollama.",
          on: (v) => this.patch({ baseUrl: v }) })}
        ${this.choice({ id: "m-kind", label: "Kind", value: m.kind,
          options: options(["chat", "embedding"]),
          on: (v) => this.patch({ kind: v }) })}
        ${embedding ? this.text({ id: "m-dimensions", label: "Dimensions", type: "number",
          value: String(m.dimensions), required: true, placeholder: "1024",
          help: "How wide this model's vectors are — 1024 for mistral-embed. A width that does not match builds a column the provider's own answers will not fit.",
          on: (v) => this.patch({ dimensions: parseInt(v || "0", 10) }) }) : ""}
        ${this.check({ id: "m-enabled", label: "Enabled", checked: m.enabled,
          help: embedding
            ? "One embedding model is active at a time: turning this on turns the others off."
            : "Only an enabled model can be named by a configuration.",
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => this.act(() => fresh ? createModel(m) : updateModel(m)))}
    `;
  }

  private configForm(c: ModelConfigRow) {
    return html`
      ${this.formHead("New configuration")}
      <div class="banner">A configuration is how an agent names a model: the id here is
        what its <em>Model configuration</em> field points at.</div>
      <div class="grid">
        ${this.text({ id: "c-id", label: "Id", value: c.id, required: true,
          placeholder: "mistral-big", on: (v) => this.patch({ id: v }) })}
        ${this.choice({ id: "c-model", label: "Model", value: c.modelId, required: true,
          options: this.models.map((m) => ({ value: m.id, label: `${m.label} · ${m.apiName}` })),
          on: (v) => this.patch({ modelId: v }) })}
        ${this.text({ id: "c-maxtokens", label: "Max tokens", type: "number",
          value: String(c.maxTokens), required: true, placeholder: "8192",
          help: "The ceiling on one reply. A model that reaches it while writing a tool call stops mid-call, and a reply cut off there cannot be stored — so a budget too small for the work is felt as a conversation that stops answering.",
          on: (v) => this.patch({ maxTokens: parseInt(v || "0", 10) }) })}
        ${this.text({ id: "c-temperature", label: "Temperature", type: "number",
          value: String(c.temperature), placeholder: "0.2",
          help: "0 for work that must be repeatable, higher for prose.",
          on: (v) => this.patch({ temperature: Number(v || "0") }) })}
        ${this.text({ id: "c-topp", label: "Top-p", type: "number", value: String(c.topP),
          placeholder: "1", on: (v) => this.patch({ topP: Number(v || "0") }) })}
        ${this.area({ id: "c-extra", label: "Extra", value: c.extra, rows: 3,
          placeholder: "{}",
          help: "Sent to the provider as-is, for the fields this form does not carry.",
          on: (v) => this.patch({ extra: v }) })}
      </div>
      ${this.formActions(() => this.act(() => createConfig(c)), "Create")}
    `;
  }

  // --- prompts ------------------------------------------------------------------------

  // The images an operator will run scripts in.
  //
  // Curated here rather than named by a model: run_script builds a
  // conversation's container from its agent's choice, and a model that could
  // name its own image could make the server pull anything off the internet
  // and run it.
  private imagesTab() {
    const v = this.view;
    if (v.kind === "image") return this.imageForm(v.row);
    return html`
      ${this.head("Images", "box")}
      <div class="bar">
        <button class="primary" data-new="image"
          @click=${() => this.open({ kind: "image",
            row: { id: "", label: "", image: "", enabled: true } })}>
          <nr-icon name="plus" size="small"></nr-icon> New image
        </button>
      </div>

      ${this.group("Images", this.images.length)}
      <table><tbody>
        ${this.images.map((i) => html`<tr>
          <td class="name">${i.label}</td>
          <td class="fill dim"><span class="trunc">${i.image}</span></td>
          <td><span class="tag">${i.enabled ? "enabled" : "off"}</span></td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${i.label}`,
              run: () => this.open({ kind: "image", row: { ...i } }) },
            { icon: "trash-2", title: `Delete ${i.label}`, danger: true,
              run: () => { void this.removeImage(i.id); } },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">An agent picks one of these; its conversations inherit it when their
      container is created. Deleting one leaves those agents on the deployment default rather
      than breaking them.</p>
    `;
  }

  private imageForm(row: ScriptImageRow) {
    const fresh = !this.images.some((i) => i.id === row.id);
    return html`
      ${this.head(fresh ? "New image" : row.label, "box")}
      <div class="form">
        ${this.text({ id: "i-label", label: "Label", value: row.label, required: true,
          placeholder: "Python + node toolchain", on: (v) => this.patch({ label: v }) })}
        ${this.text({ id: "i-id", label: "Id", value: row.id, required: true, disabled: !fresh,
          placeholder: "runtime-1", on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "i-image", label: "Image reference", value: row.image, required: true,
          wide: true, placeholder: "agents-runtime:1",
          help: "What docker is handed. A tag or a digest; it must already be present on the host or pullable by it.",
          on: (v) => this.patch({ image: v }) })}
        ${this.check({ id: "i-enabled", label: "Enabled", checked: row.enabled,
          help: "A disabled image stays configured but is not offered to an agent.",
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => { void this.saveImage(row, fresh); })}
    `;
  }

  private async saveImage(row: ScriptImageRow, fresh: boolean) {
    this.problem = "";
    try {
      if (fresh) { await createScriptImage(row); } else { await updateScriptImage(row); }
      this.view = { kind: "list" };
      await this.refresh();
    } catch (e) {
      this.problem = e instanceof Error ? e.message : String(e);
    }
  }

  private async removeImage(id: string) {
    this.problem = "";
    try {
      await deleteScriptImage(id);
      await this.refresh();
    } catch (e) {
      this.problem = e instanceof Error ? e.message : String(e);
    }
  }

  private promptsTab() {
    const v = this.view;
    if (v.kind === "prompt") return this.promptForm(v.row);
    return html`
      ${this.head("Prompts", "file-text")}
      <div class="bar">
        <button class="primary" data-new="prompt"
          @click=${() => this.open({ kind: "prompt", row: { promptName: "", body: "" } })}>
          <nr-icon name="plus" size="small"></nr-icon> New prompt
        </button>
      </div>

      ${this.group("Versions", this.prompts.length)}
      <table><tbody>
        ${this.prompts.map((p) => html`<tr>
          <td class="name">${p.promptName}</td>
          <td><span class="tag">v${p.version}</span></td>
          <td class="fill dim"><span class="trunc">${p.body}</span></td>
          ${this.rowActions([
            { icon: "plus", title: `New version of ${p.promptName}`,
              run: () => this.open({ kind: "prompt", row: { promptName: p.promptName, body: p.body } }) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">Prompts are never edited — a change is a new version, and rollback is
      pointing an agent at an older one.</p>
    `;
  }

  private promptForm(p: { promptName: string; body: string }) {
    const prior = this.prompts.filter((x) => x.promptName === p.promptName);
    const next = prior.length === 0 ? 1 : Math.max(...prior.map((x) => x.version)) + 1;
    return html`
      ${this.formHead(prior.length === 0 ? "New prompt" : `${p.promptName} · version ${next}`)}
      <div class="grid">
        ${this.text({ id: "p-name", label: "Name", value: p.promptName, required: true,
          placeholder: "support-desk",
          help: "A name that already exists gets the next version rather than replacing one.",
          on: (v) => this.patch({ promptName: v }) })}
        ${this.editor({ id: "p-body", label: "Prompt", value: p.body, required: true,
          help: "Markdown, highlighted as you type. It is sent to the model as the text it is — nothing here renders it.",
          on: (v) => this.patch({ body: v }) })}
      </div>
      ${this.formActions(
        () => this.act(() => createPrompt(p.promptName, p.body)), "Save version")}
    `;
  }

  // --- skills -------------------------------------------------------------------------

  private skillsTab() {
    const v = this.view;
    if (v.kind === "skill") return this.skillForm(v.row, v.fresh, v.files);
    const usedBy = (id: string) =>
      this.agents.filter((a) => (a.skills ?? []).some((s) => s.id === id)).length;
    return html`
      ${this.head("Skills", "sticky-note")}
      <div class="bar">
        <button class="primary" data-new="skill"
          @click=${() => this.open({ kind: "skill", fresh: true, files: [],
            row: { id: "", skillName: "", description: "", body: "", updatedAt: "" } })}>
          <nr-icon name="plus" size="small"></nr-icon> New skill
        </button>
      </div>

      ${this.group("Skills", this.skills.length)}
      <table><tbody>
        ${this.skills.map((k) => html`<tr>
          <td class="name">${k.skillName}</td>
          <td class="fill dim"><span class="trunc">${k.description}</span></td>
          <td><span class="tag">${usedBy(k.id)} agent${usedBy(k.id) === 1 ? "" : "s"}</span></td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${k.skillName}`,
              run: async () => this.open({ kind: "skill", row: { ...k }, fresh: false,
                files: await listSkillFiles(k.id) }) },
            { icon: "trash", title: `Delete ${k.skillName}`, danger: true,
              run: () => this.act(() => deleteSkill(k.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">The briefing shows each agent its skills as one line each; the body arrives
      only when the model loads it with use_skill. Editing is in place — a skill is read fresh on
      every load, so the next call sees the change.</p>
    `;
  }

  private skillForm(k: SkillRow, fresh: boolean, files: SkillFileRow[]) {
    return html`
      ${this.formHead(fresh ? "New skill" : `Edit ${k.skillName}`)}
      <div class="grid">
        ${this.text({ id: "sk-name", label: "Name", value: k.skillName, required: true,
          disabled: !fresh, placeholder: "read-proto-enums",
          help: fresh
            ? "What the model sends to use_skill — and a directory name in the container, so letters, digits, dot, dash, underscore."
            : "The name is what agents' briefings already say, so it is fixed once the row exists.",
          on: (v) => this.patch({ skillName: v }) })}
        ${this.text({ id: "sk-id", label: "Id", value: k.id, required: true,
          disabled: !fresh, placeholder: "k-read-proto-enums",
          on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "sk-desc", label: "Description", value: k.description, wide: true, required: true,
          placeholder: "One line: when should a model reach for this?",
          help: "The line the briefing shows on every turn — it is how the skill is chosen, so write it for the moment of need.",
          on: (v) => this.patch({ description: v }) })}
        ${this.editor({ id: "sk-body", label: "Instructions", value: k.body, required: true,
          help: "Markdown. Loaded whole by use_skill when a task matches the description — procedures, invocations, the files below and how to run them.",
          on: (v) => this.patch({ body: v }) })}
      </div>
      ${this.formActions(() => this.act(() =>
        fresh ? createSkill({ ...k, updatedAt: new Date().toISOString() })
              : updateSkill({ ...k, updatedAt: new Date().toISOString() })))}

      ${fresh ? "" : html`
        ${this.group("Files", files.length)}
        <p class="note">Staged into the conversation's container at
        <span class="slug">/skills/${k.skillName}/</span> fresh on every run — the body should tell
        the model to run them rather than retype them.</p>
        ${files.map((f) => html`
          <div class="grid">
            ${this.editor({ id: `sk-file-${f.path}`, label: f.path, value: f.body,
              on: (v) => this.patchFile(f.id, v) })}
          </div>
          <div class="bar">
            <button class="act" title=${`Save ${f.path}`}
              @click=${() => this.fileAct(k, () => updateSkillFile(files.find((x) => x.id === f.id) ?? f))}>
              <nr-icon name="check" size="small"></nr-icon> Save ${f.path}</button>
            <button class="act danger" title=${`Delete ${f.path}`}
              @click=${() => this.fileAct(k, () => deleteSkillFile(k.id, f.id))}>
              <nr-icon name="trash" size="small"></nr-icon></button>
          </div>
        `)}
        <div class="grid">
          ${this.text({ id: "sk-newfile", label: "New file", value: "",
            placeholder: "enums.py",
            help: "A plain name; it appears under this skill's directory. Add it, then edit its body above.",
            on: () => undefined })}
        </div>
        <div class="bar">
          <button class="act" data-new="skill-file" @click=${() => this.addFile(k)}>
            <nr-icon name="plus" size="small"></nr-icon> Add file</button>
        </div>
      `}
    `;
  }

  // A file edit stays on the form: the view's copy is patched as the editor
  // types, and a save re-reads the file list rather than trusting the draft.
  private patchFile(fileId: string, body: string) {
    const v = this.view;
    if (v.kind !== "skill") return;
    this.view = { ...v, files: v.files.map((f) => f.id === fileId ? { ...f, body } : f) };
  }

  private async fileAct(k: SkillRow, work: () => Promise<unknown>) {
    this.problem = "";
    try {
      await work();
      const files = await listSkillFiles(k.id);
      this.view = { kind: "skill", row: k, fresh: false, files };
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async addFile(k: SkillRow) {
    const name = (this.renderRoot.querySelector("#sk-newfile") as unknown as { value?: string })?.value ?? "";
    if (name.trim() === "") { this.problem = "a file needs a name"; return; }
    await this.fileAct(k, () => createSkillFile({
      id: `${k.id}:${name.trim()}`, skillId: k.id, path: name.trim(),
      body: "# " + name.trim() + "\n",
    }));
  }

  // --- MCP servers --------------------------------------------------------------------

  private mcpTab() {
    const v = this.view;
    if (v.kind === "server") return this.serverForm(v.row, v.fresh);
    return html`
      ${this.head("MCP", "code")}
      <div class="bar">
        <button class="primary" data-new="server"
          @click=${() => this.open({ kind: "server", row: { ...NEW_SERVER }, fresh: true })}>
          <nr-icon name="plus" size="small"></nr-icon> New server
        </button>
      </div>

      ${this.group("Servers", this.servers.length)}
      <table><tbody>
        ${this.servers.map((s) => html`<tr>
          <td class="name">${s.serverName}</td>
          <td class="fill"><span class="slug">${s.endpoint}</span></td>
          <td><span class="tag">${s.transport}</span></td>
          <td><span class="tag">${s.authKind === "none" ? "no auth" : s.authKind}</span></td>
          <td>${s.enabled ? "" : html`<span class="tag off">off</span>`}</td>
          ${this.rowActions([
            { icon: "edit", title: `Edit ${s.serverName}`,
              run: () => this.open({ kind: "server", row: { ...s, token: "" }, fresh: false }) },
            { icon: "trash", title: `Delete ${s.serverName}`, danger: true,
              run: () => this.act(() => deleteServer(s.id)) },
          ])}
        </tr>`)}
      </tbody></table>
      <p class="note">A server's tools are asked of the server itself, so a tool appears here
      the moment the server offers it.</p>
    `;
  }

  private serverForm(s: ServerRow & { token: string }, fresh: boolean) {
    return html`
      ${this.formHead(fresh ? "New server" : `Edit ${s.serverName}`)}
      <div class="grid">
        ${this.text({ id: "s-name", label: "Name", value: s.serverName, required: true,
          placeholder: "What this server is called", on: (v) => this.patch({ serverName: v }) })}
        ${this.text({ id: "s-id", label: "Id", value: s.id, required: true, disabled: !fresh,
          placeholder: "docflow", on: (v) => this.patch({ id: v }) })}
        ${this.text({ id: "s-endpoint", label: "Endpoint", value: s.endpoint, required: true,
          wide: true, placeholder: "http://…/mcp", on: (v) => this.patch({ endpoint: v }) })}
        <!-- http is the only transport the API accepts: stdio is a subprocess
             and this server has none to spawn. -->
        ${this.choice({ id: "s-transport", label: "Transport", value: s.transport,
          options: withCurrent(["http"], s.transport),
          on: (v) => this.patch({ transport: v }) })}
        ${this.choice({ id: "s-authkind", label: "Authentication", value: s.authKind,
          options: [
            { value: "none", label: "none" },
            { value: "bearer", label: "bearer" },
            { value: "header", label: "custom header" },
          ],
          on: (v) => this.patch({ authKind: v }) })}
        ${s.authKind === "header" ? this.text({ id: "s-authheader", label: "Header name",
          value: s.authHeader, required: true, placeholder: "X-Api-Key",
          on: (v) => this.patch({ authHeader: v }) }) : ""}
        ${s.authKind === "none" ? "" : this.text({ id: "s-token", label: "Token",
          type: "password", value: s.token, placeholder: fresh ? "" : "unchanged",
          help: "Stored encrypted under the server's id and never read back. Leaving it blank keeps the token already stored.",
          on: (v) => this.patch({ token: v }) })}
        ${this.check({ id: "s-enabled", label: "Enabled", checked: s.enabled,
          on: (v) => this.patch({ enabled: v }) })}
      </div>
      ${this.formActions(() => this.act(async () => {
        const row: ServerRow = {
          id: s.id, serverName: s.serverName, transport: s.transport,
          endpoint: s.endpoint, authKind: s.authKind, authHeader: s.authHeader,
          enabled: s.enabled,
        };
        if (fresh) { await createServer(row); } else { await updateServer(row); }
        // Only when one was typed: an empty token here would replace a working
        // credential with an unreadable envelope, and it can never be read back
        // to notice.
        if (s.token !== "") { await setServerAuth(s.id, s.authKind, s.authHeader, s.token); }
      }))}
    `;
  }

  // --- provider credentials -----------------------------------------------------------

  private providersTab() {
    const v = this.view;
    if (v.kind === "key") return this.keyForm(v.row);
    return html`
      ${this.head("Providers", "cloud")}
      <div class="bar">
        <button class="primary" data-new="key"
          @click=${() => this.open({ kind: "key", row: { provider: PROVIDERS[0], apiKey: "" } })}>
          <nr-icon name="plus" size="small"></nr-icon> New credential
        </button>
      </div>

      ${this.group("Credentials", this.providers.length)}
      ${this.providers.length === 0
        ? html`<p class="empty">No credential is stored, so no model can be reached.</p>`
        : html`<table><tbody>
            ${this.providers.map((p) => html`<tr>
              <td class="name">${p}</td>
              <td class="fill"><span class="tag live">stored</span></td>
              ${this.rowActions([
                { icon: "key", title: `Replace the ${p} key`,
                  run: () => this.open({ kind: "key", row: { provider: p, apiKey: "" } }) },
              ])}
            </tr>`)}
          </tbody></table>`}
      <p class="note">Keys are encrypted under LUMEN_MASTER_KEY. The API answers which
      providers have one, never the key itself.</p>
    `;
  }

  private keyForm(k: { provider: string; apiKey: string }) {
    const held = this.providers.includes(k.provider);
    return html`
      ${this.formHead(held ? `Replace the ${k.provider} key` : "New credential")}
      <div class="grid">
        ${this.choice({ id: "k-provider", label: "Provider", value: k.provider, required: true,
          options: withCurrent(PROVIDERS, k.provider), on: (v) => this.patch({ provider: v }) })}
        ${this.text({ id: "k-key", label: "API key", value: k.apiKey, type: "password",
          required: true, placeholder: "sk-…",
          help: "Written once and never read back — replacing it is the only way to change it.",
          on: (v) => this.patch({ apiKey: v }) })}
      </div>
      ${this.formActions(() => this.act(() => storeProviderKey(k.provider, k.apiKey)), "Store")}
    `;
  }

  // --- tracing ------------------------------------------------------------------------

  // A panel rather than a list: there is one row and it is always the same one.
  private tracingTab() {
    const t = this.tracing;
    const state = t === null ? "…"
      : t.configured ? (t.active ? "Active" : "Configured, disabled")
      : "Not configured";
    const edit = (fields: Partial<typeof this.trace>) => { this.trace = { ...this.trace, ...fields }; };
    return html`
      ${this.head("Tracing", "layers")}
      <div class="formhead"><h3>${state}</h3></div>

      <div class="grid">
        ${this.choice({ id: "t-backend", label: "Backend", value: this.trace.backend,
          options: withCurrent(BACKENDS, this.trace.backend), required: true,
          help: "Checked when it is set rather than at the first trace — a typo that silently turns tracing off later is found by nobody.",
          on: (v) => edit({ backend: v }) })}
        ${this.text({ id: "t-endpoint", label: "Endpoint", value: this.trace.endpoint,
          placeholder: "https://…/v1/traces", on: (v) => edit({ endpoint: v }) })}
        ${this.text({ id: "t-public", label: "Public key", value: this.trace.publicKey,
          placeholder: "public key, project or space",
          on: (v) => edit({ publicKey: v }) })}
        ${this.text({ id: "t-service", label: "Service name", value: this.trace.serviceName,
          placeholder: "lumen-agents", on: (v) => edit({ serviceName: v }) })}
        ${this.text({ id: "t-env", label: "Environment", value: this.trace.environment,
          placeholder: "production",
          help: "These two were constants once, so opening this tab and pressing Save refiled a staging deployment's traces under production.",
          on: (v) => edit({ environment: v }) })}
        ${this.check({ id: "t-enabled", label: "Enabled", checked: this.trace.enabled,
          on: (v) => edit({ enabled: v }) })}
      </div>
      <div class="formacts">
        <button class="primary" @click=${() => this.act(() => configureTracing({
          id: "default", backend: this.trace.backend, endpoint: this.trace.endpoint,
          publicKey: this.trace.publicKey, serviceName: this.trace.serviceName,
          environment: this.trace.environment, enabled: this.trace.enabled,
        }), { kind: "list" })}>Save</button>
      </div>

      ${this.group("Secret")}
      <div class="grid">
        ${this.text({ id: "t-secret", label: "Secret key", value: this.trace.secret,
          type: "password", placeholder: "sk-lf-…",
          help: "Stored the same way a provider key is: encrypted, and never handed back.",
          on: (v) => edit({ secret: v }) })}
      </div>
      <div class="formacts">
        <button class="ghost" @click=${() => this.act(async () => {
          await setTracingSecret(this.trace.secret);
          this.trace = { ...this.trace, secret: "" };
        }, { kind: "list" })}>Store secret</button>
      </div>
    `;
  }
}

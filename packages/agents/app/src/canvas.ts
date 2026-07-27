// The agent graph, drawn and edited.
//
// One node per agent, one edge per sub-agent relation, on LumenUI's
// <workflow-canvas> — the same component the workflow builder uses, so the
// drag, the connect, the marquee, the undo and the minimap all come for free
// rather than being written again here.
//
// Every write goes through the same routes the Settings tables use:
// updateAgent for a field, linkChild/unlinkChild for a relation. A canvas that
// wrote its own way to the database would be a second door past the invariants
// the API enforces — one default agent, a sub-agent that is not its own
// ancestor — and the two views would drift apart the first time one of them
// was wrong.

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
// <workflow-canvas> is registered by the single LumenUI bundle in ui.ts.
import "./ui.js";
import {
  AgentFull, ModelConfigRow, PromptRow,
  listAgents, listConfigs, listPrompts, updateAgent, linkChild, unlinkChild,
} from "./api.js";

// The canvas types are structural, and the package's own type entry point is
// the deep path. Only the two shapes this file builds are named.
type Position = { x: number; y: number };
type CanvasNode = {
  id: string; name: string; type: string; position: Position;
  configuration: Record<string, unknown>;
  ports: { inputs: Port[]; configs?: Port[]; outputs: Port[] };
  metadata?: { description?: string; icon?: string; color?: string };
  selected?: boolean;
};
type Port = { id: string; type: string; label: string; multiple?: boolean };
type CanvasEdge = {
  id: string; sourceNodeId: string; sourcePortId: string;
  targetNodeId: string; targetPortId: string; label?: string;
};
type CanvasWorkflow = {
  id: string; name: string; nodes: CanvasNode[]; edges: CanvasEdge[];
};

// A relation as the API states it: parent delegates to child.
type Link = { parent: string; child: string };

const LAYOUT_KEY = "agent-canvas-layout";

// Where the nodes sit. The database has no opinion about layout — an agent row
// is not a position — so a drag is remembered here rather than invented as a
// column. Losing it costs a re-drag, not data.
function savedLayout(): Record<string, Position> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Position>) : {};
  } catch {
    return {};
  }
}

function saveLayout(at: Record<string, Position>) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(at)); } catch { /* private mode */ }
}

// Parents above their children, so the arrows read downward on first open.
// Only used for an agent nobody has dragged yet.
function tidyPositions(agents: AgentFull[]): Record<string, Position> {
  const children = new Set<string>();
  for (const a of agents) for (const s of a.subAgents) children.add(s.id);
  const roots = agents.filter((a) => !children.has(a.id));
  const rest = agents.filter((a) => children.has(a.id));
  const at: Record<string, Position> = {};
  roots.forEach((a, i) => { at[a.id] = { x: 120 + i * 300, y: 120 }; });
  rest.forEach((a, i) => { at[a.id] = { x: 120 + i * 300, y: 380 }; });
  return at;
}

const AGENT_PORTS: { inputs: Port[]; configs: Port[]; outputs: Port[] } = {
  inputs: [{ id: "in", type: "INPUT", label: "Delegated to" }],
  configs: [],
  outputs: [{ id: "out", type: "OUTPUT", label: "Delegates to" }],
};

@customElement("agent-canvas")
export class AgentCanvas extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    header { display: flex; align-items: center; gap: 10px; padding: 10px 18px;
             border-bottom: 1px solid var(--border); background: var(--bg); }
    .title { font: 600 17px var(--serif); flex: 1; }
    .note { color: var(--muted); font-size: 12.5px; }
    .body { flex: 1; display: flex; min-height: 0; }
    workflow-canvas { flex: 1; min-width: 0; }
    aside { width: 300px; flex: none; border-left: 1px solid var(--border);
            background: var(--bg-card); overflow-y: auto; padding: 16px; }
    aside h3 { margin: 0 0 4px; font: 600 15px var(--serif); }
    aside .sub { color: var(--muted); font-size: 12.5px; margin-bottom: 14px; }
    label { display: block; font-size: 12.5px; color: var(--muted); margin: 10px 0 4px; }
    input, select, textarea { width: 100%; box-sizing: border-box; font: inherit;
      background: var(--bg); color: inherit; border: 1px solid var(--border);
      border-radius: 8px; padding: 6px 8px; }
    textarea { min-height: 60px; resize: vertical; }
    .row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .row input[type=checkbox] { width: auto; }
    .actions { display: flex; gap: 8px; margin-top: 16px; }
    button { font: inherit; border-radius: 8px; padding: 6px 12px; cursor: pointer;
             border: 1px solid var(--border); background: var(--bg); color: inherit; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: 0.55; cursor: default; }
    .problem { color: #B3261E; font-size: 12.5px; margin-top: 10px; }
    .saved { color: #157F4D; font-size: 12.5px; margin-top: 10px; }
    .empty { color: var(--muted); font-size: 13px; }
  `;

  @state() private agents: AgentFull[] = [];
  @state() private configs: ModelConfigRow[] = [];
  @state() private prompts: PromptRow[] = [];
  @state() private picked = "";
  @state() private draft: AgentFull | null = null;
  @state() private problem = "";
  @state() private saved = "";
  @state() private busy = false;

  // The relations as last read from the API. The canvas hands back its whole
  // graph on every change, so the difference against this is what needs a
  // request — otherwise a single drag would re-POST every existing link.
  private links: Link[] = [];

  async connectedCallback() {
    super.connectedCallback();
    await this.load();
  }

  private async load() {
    const [agents, configs, prompts] = await Promise.all([
      listAgents(), listConfigs(), listPrompts(),
    ]).catch(() => [[], [], []] as [AgentFull[], ModelConfigRow[], PromptRow[]]);
    this.agents = agents;
    this.configs = configs;
    this.prompts = prompts;
    this.links = agents.flatMap((a) => a.subAgents.map((s) => ({ parent: a.id, child: s.id })));
    if (this.picked !== "" && !agents.some((a) => a.id === this.picked)) {
      this.picked = "";
      this.draft = null;
    }
  }

  private workflow(): CanvasWorkflow {
    const at = { ...tidyPositions(this.agents), ...savedLayout() };
    return {
      id: "agents",
      name: "Agents",
      nodes: this.agents.map((a) => ({
        id: a.id,
        name: a.agentName,
        type: "AGENT",
        position: at[a.id] ?? { x: 120, y: 120 },
        // What the node shows without being opened: which model config and
        // prompt it runs on, and whether it is the one a new conversation
        // opens against.
        configuration: {
          agentId: a.id,
          modelConfigId: a.modelConfigId,
          promptId: a.promptId,
          isDefault: a.isDefault,
        },
        ports: { ...AGENT_PORTS },
        metadata: {
          description: a.description,
          // Disabled agents are drawn but muted: an agent that exists and is
          // switched off is not the same as one that is absent, and hiding it
          // would make the graph disagree with the Settings table.
          color: a.enabled ? (a.isDefault ? "#157F4D" : "#10b981") : "#9AA4B2",
        },
        selected: a.id === this.picked,
      })),
      edges: this.links.map((l) => ({
        id: `${l.parent}->${l.child}`,
        sourceNodeId: l.parent, sourcePortId: "out",
        targetNodeId: l.child, targetPortId: "in",
      })),
    };
  }

  private pick(id: string) {
    const found = this.agents.find((a) => a.id === id) ?? null;
    this.picked = found ? id : "";
    this.draft = found ? { ...found } : null;
    this.problem = "";
    this.saved = "";
  }

  // A node dragged to a new place. Remembered locally; nothing is sent.
  private moved(e: CustomEvent) {
    const id = e.detail?.nodeId ?? e.detail?.node?.id;
    const pos = e.detail?.position ?? e.detail?.node?.position;
    if (!id || !pos) return;
    saveLayout({ ...savedLayout(), [id]: { x: pos.x, y: pos.y } });
  }

  // The canvas changed its graph: an edge was drawn or deleted. Only the
  // difference is sent, and only through the relation routes.
  private async changed(e: CustomEvent) {
    const wf = e.detail?.workflow as CanvasWorkflow | undefined;
    if (!wf || this.busy) return;

    const now: Link[] = wf.edges
      .filter((x) => x.sourceNodeId !== x.targetNodeId)
      .map((x) => ({ parent: x.sourceNodeId, child: x.targetNodeId }));
    const key = (l: Link) => `${l.parent}->${l.child}`;
    const had = new Set(this.links.map(key));
    const has = new Set(now.map(key));
    const added = now.filter((l) => !had.has(key(l)));
    const dropped = this.links.filter((l) => !has.has(key(l)));
    if (added.length === 0 && dropped.length === 0) return;

    this.busy = true;
    this.problem = "";
    try {
      // An agent delegating to itself is refused before the request: the API
      // says no, and the canvas should not draw an edge it cannot keep.
      for (const l of added) await linkChild(l.parent, l.child);
      for (const l of dropped) await unlinkChild(l.parent, l.child);
      await this.load();
      this.saved = added.length > 0 ? "linked" : "unlinked";
    } catch (err) {
      // The API refused — a cycle, or an agent that is not there. Reload so
      // the drawing matches what was actually stored rather than what was
      // attempted.
      this.problem = err instanceof Error ? err.message : String(err);
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  private edit<K extends keyof AgentFull>(field: K, value: AgentFull[K]) {
    if (!this.draft) return;
    this.draft = { ...this.draft, [field]: value };
    this.saved = "";
  }

  private async save() {
    if (!this.draft || this.busy) return;
    this.busy = true;
    this.problem = "";
    this.saved = "";
    try {
      // The flat columns only. The full view nests prompt, config, servers and
      // sub-agents, and sending those back is rejected outright.
      await updateAgent({
        id: this.draft.id,
        agentName: this.draft.agentName,
        description: this.draft.description,
        modelConfigId: this.draft.modelConfigId,
        promptId: this.draft.promptId,
        enabled: this.draft.enabled,
        isDefault: this.draft.isDefault,
      });
      await this.load();
      this.pick(this.draft.id);
      this.saved = "saved";
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  private inspector() {
    const d = this.draft;
    if (!d) {
      return html`<h3>Nothing selected</h3>
        <p class="empty">Pick an agent on the canvas to edit it. Drag from one
        agent's right-hand port to another's left to make it a sub-agent.</p>`;
    }
    return html`
      <h3>${d.agentName}</h3>
      <div class="sub">${d.id}</div>

      <label for="c-name">Name</label>
      <input id="c-name" name="agentName" .value=${d.agentName}
        @input=${(e: Event) => this.edit("agentName", (e.target as HTMLInputElement).value)} />

      <label for="c-desc">Description</label>
      <textarea id="c-desc" name="description" .value=${d.description}
        @input=${(e: Event) => this.edit("description", (e.target as HTMLTextAreaElement).value)}></textarea>

      <label for="c-config">Model config</label>
      <select id="c-config" name="modelConfigId" .value=${d.modelConfigId}
        @change=${(e: Event) => this.edit("modelConfigId", (e.target as HTMLSelectElement).value)}>
        ${this.configs.map((c) => html`
          <option value=${c.id} ?selected=${c.id === d.modelConfigId}>${c.id} · ${c.modelId}</option>`)}
      </select>

      <label for="c-prompt">Prompt</label>
      <select id="c-prompt" name="promptId" .value=${d.promptId}
        @change=${(e: Event) => this.edit("promptId", (e.target as HTMLSelectElement).value)}>
        ${this.prompts.map((p) => html`
          <option value=${p.id} ?selected=${p.id === d.promptId}>${p.promptName} v${p.version}</option>`)}
      </select>

      <div class="row">
        <input id="c-enabled" name="enabled" type="checkbox" .checked=${d.enabled}
          @change=${(e: Event) => this.edit("enabled", (e.target as HTMLInputElement).checked)} />
        <label for="c-enabled" style="margin:0">Enabled</label>
      </div>
      <div class="row">
        <input id="c-default" name="isDefault" type="checkbox" .checked=${d.isDefault}
          @change=${(e: Event) => this.edit("isDefault", (e.target as HTMLInputElement).checked)} />
        <label for="c-default" style="margin:0">Default agent</label>
      </div>

      <div class="actions">
        <button class="primary" ?disabled=${this.busy} @click=${() => this.save()}>Save</button>
        <button ?disabled=${this.busy} @click=${() => this.pick(d.id)}>Revert</button>
      </div>
      ${this.problem !== "" ? html`<div class="problem" role="alert">${this.problem}</div>` : ""}
      ${this.saved !== "" ? html`<div class="saved">${this.saved}</div>` : ""}
    `;
  }

  render() {
    return html`
      <header>
        <span class="title">Agents</span>
        <span class="note">${this.agents.length} agents · ${this.links.length} relations</span>
      </header>
      <div class="body">
        <workflow-canvas
          .workflow=${this.workflow()}
          ?showMinimap=${true}
          ?showToolbar=${true}
          ?showPalette=${false}
          @node-selected=${(e: CustomEvent) =>
            this.pick(e.detail?.nodeId ?? e.detail?.node?.id ?? "")}
          @node-configured=${(e: CustomEvent) =>
            this.pick(e.detail?.node?.id ?? e.detail?.nodeId ?? "")}
          @node-moved=${(e: CustomEvent) => this.moved(e)}
          @workflow-changed=${(e: CustomEvent) => this.changed(e)}
        ></workflow-canvas>
        <aside>${this.inspector()}</aside>
      </div>
    `;
  }
}

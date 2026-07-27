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
  AgentFull, ModelConfigRow, PromptRow, ServerRow,
  listAgents, listConfigs, listPrompts, listServers,
  updateAgent, updateServer, linkChild, unlinkChild, linkServer, unlinkServer,
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

// Two kinds of thing share one canvas, and their ids come from different
// tables — an agent and a server could both be called "s1". A node id carries
// its kind so they cannot collide, and every read of one goes back through
// `partsOf` rather than slicing strings at the call site.
type Kind = "agent" | "server";
const nodeId = (kind: Kind, id: string) => `${kind}:${id}`;
function partsOf(node: string): { kind: Kind; id: string } {
  const cut = node.indexOf(":");
  return { kind: node.slice(0, cut) as Kind, id: node.slice(cut + 1) };
}

// A relation as the API states it. `kind` is the child's: an agent delegates
// to a sub-agent, and it uses a server. They are different routes.
type Link = { parent: string; child: string; kind: Kind };

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

function forgetLayout() {
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* private mode */ }
}

// Agents in two rows — the ones nothing delegates to on top, their
// sub-agents below — and the servers in a column off to the right. Arrows
// then read downward for delegation and rightward for tools, which is the
// distinction the graph exists to show. Only used for a node nobody has
// dragged yet.
// One grid for everything on the canvas, so nodes line up instead of landing
// wherever the arithmetic put them. A cell is wider than a node and taller
// than one with two lines of description, which is what keeps the gaps even
// as names and endpoints change length.
const CELL = { w: 320, h: 220 };
const ORIGIN = { x: 100, y: 100 };
const cell = (col: number, row: number): Position =>
  ({ x: ORIGIN.x + col * CELL.w, y: ORIGIN.y + row * CELL.h });

function tidyPositions(agents: AgentFull[], servers: ServerRow[]): Record<string, Position> {
  const children = new Set<string>();
  for (const a of agents) for (const c of a.subAgents) children.add(c.id);
  const roots = agents.filter((a) => !children.has(a.id));
  const rest = agents.filter((a) => children.has(a.id));
  const at: Record<string, Position> = {};

  // Agents in two rows: what nothing delegates to on top, its sub-agents
  // under it. Each row is centred on the wider of the two, so a single root
  // above three sub-agents sits over the middle of them rather than off at
  // the left edge with its arrows fanning sideways.
  const span = Math.max(roots.length, rest.length, 1);
  const place = (list: AgentFull[], row: number) => {
    const offset = (span - list.length) / 2;
    list.forEach((a, i) => { at[nodeId("agent", a.id)] = cell(offset + i, row); });
  };
  place(roots, 0);
  place(rest, 1);

  // Servers in their own column, one clear cell to the right of the widest
  // agent row — a fixed x would have them sitting on top of the agents as
  // soon as there were four of them.
  servers.forEach((v, i) => { at[nodeId("server", v.id)] = cell(span + 0.5, i); });
  return at;
}

const AGENT_PORTS: { inputs: Port[]; configs: Port[]; outputs: Port[] } = {
  inputs: [{ id: "in", type: "INPUT", label: "Delegated to" }],
  configs: [],
  outputs: [{ id: "out", type: "OUTPUT", label: "Delegates to / uses" }],
};

// A server is something an agent reaches, never something that reaches back,
// so it has an input and no output. The canvas will not let an edge start
// where there is no port to start from.
const SERVER_PORTS: { inputs: Port[]; configs: Port[]; outputs: Port[] } = {
  inputs: [{ id: "in", type: "INPUT", label: "Used by" }],
  configs: [],
  outputs: [],
};

// The entry agent is the one a new conversation opens against, and it is the
// single most useful thing to be able to find at a glance — so it is not a
// shade of the others but its own colour and its own mark.
const ENTRY = { color: "#C2410C", icon: "play" };
const AGENT = { color: "#10b981", icon: "cpu" };
const SUB = { color: "#0EA5E9", icon: "agent" };
const OFF = { color: "#9AA4B2", icon: "cpu" };
const SERVER = { color: "#7C3AED", icon: "plug" };
const SERVER_OFF = { color: "#9AA4B2", icon: "plug" };

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
    header button { padding: 4px 11px; font-size: 13px; }
  `;

  @state() private agents: AgentFull[] = [];
  @state() private servers: ServerRow[] = [];
  @state() private configs: ModelConfigRow[] = [];
  @state() private prompts: PromptRow[] = [];
  @state() private picked = "";
  @state() private draft: AgentFull | null = null;
  @state() private serverDraft: ServerRow | null = null;
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

  // Put every node back on the grid. Dragging is remembered, which is what
  // makes a hand-arranged graph stay arranged — and also what makes it
  // impossible to get back to a tidy one without this.
  private tidy() {
    forgetLayout();
    this.requestUpdate();
  }

  private async load() {
    const [agents, configs, prompts, servers] = await Promise.all([
      listAgents(), listConfigs(), listPrompts(), listServers(),
    ]).catch(() => [[], [], [], []] as
      [AgentFull[], ModelConfigRow[], PromptRow[], ServerRow[]]);
    this.agents = agents;
    this.configs = configs;
    this.prompts = prompts;
    this.servers = servers;
    this.links = [
      ...agents.flatMap((a) => a.subAgents.map((c) =>
        ({ parent: a.id, child: c.id, kind: "agent" as Kind }))),
      ...agents.flatMap((a) => a.servers.map((v) =>
        ({ parent: a.id, child: v.id, kind: "server" as Kind }))),
    ];
    if (this.picked !== "") this.pick(this.picked);
  }

  private workflow(): CanvasWorkflow {
    const at = { ...tidyPositions(this.agents, this.servers), ...savedLayout() };
    const isSub = new Set(this.agents.flatMap((a) => a.subAgents.map((c) => c.id)));
    const look = (a: AgentFull) =>
      !a.enabled ? OFF : a.isDefault ? ENTRY : isSub.has(a.id) ? SUB : AGENT;
    return {
      id: "agents",
      name: "Agents",
      nodes: [...this.agents.map((a) => ({
        id: nodeId("agent", a.id),
        // The entry agent says so on the node. Colour alone asks the reader to
        // remember a legend; the word does not.
        name: a.isDefault ? `${a.agentName} · entry` : a.agentName,
        type: "AGENT",
        position: at[nodeId("agent", a.id)] ?? { x: 120, y: 120 },
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
          color: look(a).color,
          icon: look(a).icon,
        },
        selected: nodeId("agent", a.id) === this.picked,
      })),
      ...this.servers.map((v) => ({
        id: nodeId("server", v.id),
        name: v.serverName,
        type: "TOOL",
        position: at[nodeId("server", v.id)] ?? { x: 760, y: 120 },
        configuration: { serverId: v.id, transport: v.transport, endpoint: v.endpoint },
        ports: { ...SERVER_PORTS },
        metadata: {
          description: `${v.transport} · ${v.endpoint}`,
          color: v.enabled ? SERVER.color : SERVER_OFF.color,
          icon: SERVER.icon,
        },
        selected: nodeId("server", v.id) === this.picked,
      }))],
      edges: this.links.map((l) => ({
        id: `${l.parent}->${l.kind}:${l.child}`,
        sourceNodeId: nodeId("agent", l.parent), sourcePortId: "out",
        targetNodeId: nodeId(l.kind, l.child), targetPortId: "in",
        // Which kind of relation this is, said on the edge rather than left to
        // the reader to infer from what it points at.
        label: l.kind === "agent" ? "delegates" : "uses",
      })),
    };
  }

  private pick(node: string) {
    this.problem = "";
    this.saved = "";
    if (node === "" || node.indexOf(":") < 0) {
      this.picked = ""; this.draft = null; this.serverDraft = null;
      return;
    }
    const { kind, id } = partsOf(node);
    if (kind === "server") {
      const found = this.servers.find((v) => v.id === id) ?? null;
      this.picked = found ? node : "";
      this.serverDraft = found ? { ...found } : null;
      this.draft = null;
      return;
    }
    const found = this.agents.find((a) => a.id === id) ?? null;
    this.picked = found ? node : "";
    this.draft = found ? { ...found } : null;
    this.serverDraft = null;
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

    // Only an agent has an output port, so a source is always an agent; the
    // target decides which route the link belongs to.
    const now: Link[] = wf.edges
      .filter((x) => x.sourceNodeId !== x.targetNodeId)
      .map((x) => {
        const target = partsOf(x.targetNodeId);
        return { parent: partsOf(x.sourceNodeId).id, child: target.id, kind: target.kind };
      });
    const key = (l: Link) => `${l.parent}->${l.kind}:${l.child}`;
    const had = new Set(this.links.map(key));
    const has = new Set(now.map(key));
    const added = now.filter((l) => !had.has(key(l)));
    const dropped = this.links.filter((l) => !has.has(key(l)));
    if (added.length === 0 && dropped.length === 0) return;

    this.busy = true;
    this.problem = "";
    try {
      // An agent delegating to itself is refused by the API, and the canvas
      // should not keep an edge the database does not have — hence the reload
      // below on either outcome.
      for (const l of added) {
        await (l.kind === "agent" ? linkChild(l.parent, l.child) : linkServer(l.parent, l.child));
      }
      for (const l of dropped) {
        await (l.kind === "agent" ? unlinkChild(l.parent, l.child) : unlinkServer(l.parent, l.child));
      }
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

  private editServer<K extends keyof ServerRow>(field: K, value: ServerRow[K]) {
    if (!this.serverDraft) return;
    this.serverDraft = { ...this.serverDraft, [field]: value };
    this.saved = "";
  }

  private async saveServer() {
    if (!this.serverDraft || this.busy) return;
    this.busy = true;
    this.problem = "";
    this.saved = "";
    try {
      // The token is never part of this. A credential is set through its own
      // route and never comes back from the API, so a form that round-tripped
      // the row would have to invent one — and would overwrite the stored
      // envelope with the blank it invented.
      await updateServer(this.serverDraft);
      const id = this.serverDraft.id;
      await this.load();
      this.pick(nodeId("server", id));
      this.saved = "saved";
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
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
      const id = this.draft.id;
      await this.load();
      this.pick(nodeId("agent", id));
      this.saved = "saved";
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  private serverForm(v: ServerRow) {
    return html`
      <h3>${v.serverName}</h3>
      <div class="sub">MCP server · ${v.id}</div>

      <label for="s-name">Name</label>
      <input id="s-name" name="serverName" .value=${v.serverName}
        @input=${(e: Event) => this.editServer("serverName", (e.target as HTMLInputElement).value)} />

      <label for="s-endpoint">Endpoint</label>
      <input id="s-endpoint" name="endpoint" .value=${v.endpoint}
        @input=${(e: Event) => this.editServer("endpoint", (e.target as HTMLInputElement).value)} />

      <label for="s-transport">Transport</label>
      <select id="s-transport" name="transport" .value=${v.transport}
        @change=${(e: Event) => this.editServer("transport", (e.target as HTMLSelectElement).value)}>
        <option value="http" ?selected=${v.transport === "http"}>http</option>
        ${v.transport !== "http" ? html`
          <!-- A row stored before the rule was consistent. Shown as it is,
               rather than silently redrawn as http by a select with no option
               to match it. -->
          <option value=${v.transport} selected>${v.transport}</option>` : ""}
      </select>

      <label for="s-authkind">Authentication</label>
      <select id="s-authkind" name="authKind" .value=${v.authKind}
        @change=${(e: Event) => this.editServer("authKind", (e.target as HTMLSelectElement).value)}>
        <option value="none" ?selected=${v.authKind === "none"}>none</option>
        <option value="bearer" ?selected=${v.authKind === "bearer"}>bearer</option>
        <option value="header" ?selected=${v.authKind === "header"}>custom header</option>
      </select>

      ${v.authKind === "header" ? html`
        <label for="s-authheader">Header name</label>
        <input id="s-authheader" name="authHeader" .value=${v.authHeader}
          @input=${(e: Event) => this.editServer("authHeader", (e.target as HTMLInputElement).value)} />` : ""}

      <div class="row">
        <input id="s-enabled" name="enabled" type="checkbox" .checked=${v.enabled}
          @change=${(e: Event) => this.editServer("enabled", (e.target as HTMLInputElement).checked)} />
        <label for="s-enabled" style="margin:0">Enabled</label>
      </div>

      <p class="empty">The token itself is set in Settings and never read back,
      so it is not shown here and saving cannot clear it.</p>

      <div class="actions">
        <button class="primary" ?disabled=${this.busy} @click=${() => this.saveServer()}>Save</button>
        <button ?disabled=${this.busy} @click=${() => this.pick(nodeId("server", v.id))}>Revert</button>
      </div>
      ${this.problem !== "" ? html`<div class="problem" role="alert">${this.problem}</div>` : ""}
      ${this.saved !== "" ? html`<div class="saved">${this.saved}</div>` : ""}
    `;
  }

  private inspector() {
    if (this.serverDraft) return this.serverForm(this.serverDraft);
    const d = this.draft;
    if (!d) {
      return html`<h3>Nothing selected</h3>
        <p class="empty">Pick an agent or a server to edit it. Drag from an
        agent's right-hand port to another agent to delegate to it, or to a
        server to give it that server's tools.</p>`;
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
        <button ?disabled=${this.busy} @click=${() => this.pick(nodeId("agent", d.id))}>Revert</button>
      </div>
      ${this.problem !== "" ? html`<div class="problem" role="alert">${this.problem}</div>` : ""}
      ${this.saved !== "" ? html`<div class="saved">${this.saved}</div>` : ""}
    `;
  }

  render() {
    return html`
      <header>
        <span class="title">Agents</span>
        <span class="note">${this.agents.length} agents · ${this.servers.length} servers ·
          ${this.links.filter((l) => l.kind === "agent").length} delegations ·
          ${this.links.filter((l) => l.kind === "server").length} tool links</span>
        <button @click=${() => this.tidy()} title="Put every node back on the grid">Tidy</button>
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

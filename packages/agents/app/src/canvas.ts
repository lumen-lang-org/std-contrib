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
  AgentFull, ModelConfigRow, PromptRow, ServerRow, ServerTools,
  listAgents, listConfigs, listPrompts, listServers, serverTools,
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
type Kind = "agent" | "server" | "tool";
const nodeId = (kind: Kind, id: string) => `${kind}:${id}`;
function partsOf(node: string): { kind: Kind; id: string } {
  const cut = node.indexOf(":");
  return { kind: node.slice(0, cut) as Kind, id: node.slice(cut + 1) };
}

// The value a LumenUI field is now carrying.
//
// Read off the element rather than out of the event detail: nr-input,
// nr-select and nr-textarea each describe their payload differently, and the
// element's own `value` is the one thing all three agree on. A detail shape
// that changed under us would be a silent empty string here otherwise.
function valueOf(e: Event): string {
  return (e.target as unknown as { value?: string }).value ?? "";
}

// http is the only transport the API accepts. A row stored before that rule
// was consistent still shows what it actually is rather than being silently
// redrawn as http by a list with no entry to match it.
function transportOptions(current: string): { value: string; label: string }[] {
  const base = [{ value: "http", label: "http" }];
  return current === "http" ? base : [...base, { value: current, label: current }];
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
// than one carrying two lines of description, which is what keeps the gaps
// even as names and endpoints change length.
// Tight enough that a three-column graph still fits beside the inspector on a
// laptop: the canvas has no fit-to-view to call, so the layout has to land
// inside the pane rather than trust the reader to pan for the last column.
const CELL = { w: 240, h: 190 };
const ORIGIN = { x: 50, y: 70 };
const cell = (col: number, row: number): Position =>
  ({ x: ORIGIN.x + col * CELL.w, y: ORIGIN.y + row * CELL.h });

// How far along the chain of delegation each agent sits: an agent nobody
// delegates to is 0, and anything it delegates to is one further along.
//
// Computed by walking outward from the roots rather than by asking each agent
// for its parents, so a cycle cannot send it round forever — an agent already
// placed keeps the depth it was first reached at. A graph where every agent
// has a parent has no root to start from, so the walk seeds itself with the
// first agent and still terminates.
function depths(agents: AgentFull[]): Map<string, number> {
  const children = new Set<string>();
  for (const a of agents) for (const c of a.subAgents) children.add(c.id);
  const by = new Map(agents.map((a) => [a.id, a]));
  const depth = new Map<string, number>();

  let frontier = agents.filter((a) => !children.has(a.id)).map((a) => a.id);
  if (frontier.length === 0 && agents.length > 0) frontier = [agents[0].id];

  let level = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (depth.has(id)) continue;
      depth.set(id, level);
      for (const c of by.get(id)?.subAgents ?? []) {
        if (!depth.has(c.id)) next.push(c.id);
      }
    }
    frontier = next;
    level = level + 1;
  }
  // An agent no walk reached — one inside a cycle with no way in — still
  // needs somewhere to be rather than stacking at the origin.
  for (const a of agents) if (!depth.has(a.id)) depth.set(a.id, level);
  return depth;
}

// Laid out the way a trace reads: left to right, one column per step of
// delegation, with what an agent uses at the end of the line. Each column is
// centred against the tallest, so a single agent feeding three sub-agents sits
// level with the middle of them and its arrows stay flat instead of fanning.
function tidyPositions(
  agents: AgentFull[], servers: ServerRow[], tools: ServerTools[],
): Record<string, Position> {
  const depth = depths(agents);
  const columns: AgentFull[][] = [];
  for (const a of agents) {
    const d = depth.get(a.id) ?? 0;
    while (columns.length <= d) columns.push([]);
    columns[d].push(a);
  }

  const serverColumn = columns.length;
  const toolColumn = serverColumn + 1;

  // Tools are laid out under the server that offers them rather than in one
  // list, so which server a tool came from is read off the position instead
  // of having to be looked up.
  const rowsOfTools = tools.reduce((n, t) => n + t.tools.length, 0);
  const tallest = Math.max(
    ...columns.map((c) => c.length), servers.length, rowsOfTools, 1);
  const at: Record<string, Position> = {};

  columns.forEach((column, col) => {
    const offset = (tallest - column.length) / 2;
    column.forEach((a, row) => { at[nodeId("agent", a.id)] = cell(col, offset + row); });
  });

  // Each server sits level with the middle of its own tools, so the fan of
  // arrows out of it is symmetric rather than hanging off the top.
  const toolOffset = (tallest - Math.max(rowsOfTools, servers.length)) / 2;
  let row = 0;
  servers.forEach((v) => {
    const mine = tools.find((t) => t.serverId === v.id)?.tools ?? [];
    const span = Math.max(mine.length, 1);
    at[nodeId("server", v.id)] = cell(serverColumn, toolOffset + row + (span - 1) / 2);
    mine.forEach((t, i) => {
      at[nodeId("tool", `${v.id}/${t.name}`)] = cell(toolColumn, toolOffset + row + i);
    });
    row = row + span;
  });
  return at;
}

const AGENT_PORTS: { inputs: Port[]; configs: Port[]; outputs: Port[] } = {
  inputs: [{ id: "in", type: "INPUT", label: "Delegated to" }],
  configs: [],
  outputs: [{ id: "out", type: "OUTPUT", label: "Delegates to / uses" }],
};

// An agent reaches a server and a server never reaches back, so its input is
// where agents arrive. Its output goes only to the tools it offers, which the
// server states and nobody here edits.
const SERVER_PORTS: { inputs: Port[]; configs: Port[]; outputs: Port[] } = {
  inputs: [{ id: "in", type: "INPUT", label: "Used by" }],
  configs: [],
  outputs: [{ id: "out", type: "OUTPUT", label: "Offers" }],
};

// The entry agent is the one a new conversation opens against, and it is the
// single most useful thing to be able to find at a glance — so it is not a
// shade of the others but its own colour and its own mark.
// Icon names are looked up in nr-icon's own set, and a name that is not in it
// is drawn as the name — the word "function" sat across the title of every
// tool node until it was noticed. These are all names the set actually has;
// `agent`, which reads like it ought to exist, is not one of them.
const ENTRY = { color: "#C2410C", icon: "play" };
const AGENT = { color: "#10b981", icon: "cpu" };
const SUB = { color: "#0EA5E9", icon: "git-fork" };
const OFF = { color: "#9AA4B2", icon: "cpu" };
const SERVER = { color: "#7C3AED", icon: "plug" };
const SERVER_OFF = { color: "#9AA4B2", icon: "plug" };
const TOOL = { color: "#0F766E", icon: "code" };

// Three things on one canvas want three cards, not one card wearing three
// colours. The node type is what the canvas renders from, so it is the type
// that changes: an agent is an agent node and gets the AI badge and the ports
// an agent has; a server is an HTTP endpoint, which over http is exactly what
// it is; a tool is a function, which is what a tool call is.
const CARD: Record<Kind, string> = {
  agent: "AGENT",
  server: "HTTP",
  tool: "FUNCTION",
};

// A tool is a leaf: something a server offers, reached through that server.
// It has an input and no output, and nothing links to it by hand.
const TOOL_PORTS: { inputs: Port[]; configs: Port[]; outputs: Port[] } = {
  inputs: [{ id: "in", type: "INPUT", label: "Offered by" }],
  configs: [],
  outputs: [],
};

@customElement("agent-canvas")
export class AgentCanvas extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    header { display: flex; align-items: center; gap: 10px; padding: 10px 18px;
             border-bottom: 1px solid var(--border); background: var(--bg); }
    .title { font: 600 17px var(--display); flex: 1; }
    .note { color: var(--muted); font-size: 12.5px; }
    .body { flex: 1; display: flex; min-height: 0; }
    workflow-canvas { flex: 1; min-width: 0; }
    aside { width: 300px; flex: none; border-left: 1px solid var(--border);
            background: var(--bg-card); overflow-y: auto; padding: 16px; }
    aside h3 { margin: 0 0 4px; font: 600 15px var(--display); }
    aside .sub { color: var(--muted); font-size: 12.5px; margin-bottom: 14px; }
    /* The fields are LumenUI components and bring their own look; what is
       left here is only the spacing between them. */
    nr-input, nr-select, nr-textarea { display: block; margin-top: 12px; }
    /* nr-select sizes itself to its content, which leaves a form of full-width
       inputs with two short pills in the middle of it. The host rule is the
       component's default and an outer rule may say otherwise. */
    nr-select { width: 100%; }
    [slot=label] { font-size: 12.5px; color: var(--muted); }
    .row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .actions { display: flex; gap: 8px; margin-top: 18px; }
    .problem { color: #B3261E; font-size: 12.5px; margin-top: 10px; }
    .saved { color: #157F4D; font-size: 12.5px; margin-top: 10px; }
    .offers { color: #0F766E; font-size: 12.5px; margin-top: 10px; }
    .empty { color: var(--muted); font-size: 13px; }
    .claim { font-size: 13.5px; margin: 0 0 10px; }
    header nr-button { font-size: 13px; }
  `;

  @state() private agents: AgentFull[] = [];
  @state() private servers: ServerRow[] = [];
  @state() private tools: ServerTools[] = [];
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
    // Asked of each server in parallel, and never fatal: a server that cannot
    // be reached still belongs on the graph, saying why.
    this.tools = await Promise.all(
      servers.map((v) => serverTools(v.id).catch(() =>
        ({ serverId: v.id, problem: "could not ask this server", tools: [] }))),
    );
    this.links = [
      ...agents.flatMap((a) => a.subAgents.map((c) =>
        ({ parent: a.id, child: c.id, kind: "agent" as Kind }))),
      ...agents.flatMap((a) => a.servers.map((v) =>
        ({ parent: a.id, child: v.id, kind: "server" as Kind }))),
    ];
    if (this.picked !== "") this.pick(this.picked);
  }

  private workflow(): CanvasWorkflow {
    const at = { ...tidyPositions(this.agents, this.servers, this.tools), ...savedLayout() };
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
        type: CARD.agent,
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
        type: CARD.server,
        position: at[nodeId("server", v.id)] ?? { x: 760, y: 120 },
        configuration: { serverId: v.id, transport: v.transport, endpoint: v.endpoint },
        ports: { ...SERVER_PORTS },
        metadata: {
          description: `${v.transport} · ${v.endpoint}`,
          color: v.enabled ? SERVER.color : SERVER_OFF.color,
          icon: SERVER.icon,
        },
        selected: nodeId("server", v.id) === this.picked,
      })),
      // A tool per row the server listed. These are not stored anywhere — the
      // server is asked each time the graph is drawn — so they appear and
      // disappear with the server itself.
      ...this.tools.flatMap((t) => t.tools.map((tool) => ({
        id: nodeId("tool", `${t.serverId}/${tool.name}`),
        name: tool.name,
        type: CARD.tool,
        position: at[nodeId("tool", `${t.serverId}/${tool.name}`)] ?? { x: 0, y: 0 },
        configuration: { serverId: t.serverId, tool: tool.name },
        ports: { ...TOOL_PORTS },
        metadata: { description: tool.description, color: TOOL.color, icon: TOOL.icon },
        selected: nodeId("tool", `${t.serverId}/${tool.name}`) === this.picked,
      })))],
      edges: [...this.links.map((l) => ({
        id: `${l.parent}->${l.kind}:${l.child}`,
        sourceNodeId: nodeId("agent", l.parent), sourcePortId: "out",
        targetNodeId: nodeId(l.kind, l.child), targetPortId: "in",
        // Which kind of relation this is, said on the edge rather than left to
        // the reader to infer from what it points at.
        label: l.kind === "agent" ? "delegates" : "uses",
      })),
      // Server to tool. Not a stored relation and not editable: a server
      // offers what it offers, and drawing it any other way would suggest the
      // console could change it.
      ...this.tools.flatMap((t) => t.tools.map((tool) => ({
        id: `${t.serverId}=>${tool.name}`,
        sourceNodeId: nodeId("server", t.serverId), sourcePortId: "out",
        targetNodeId: nodeId("tool", `${t.serverId}/${tool.name}`), targetPortId: "in",
        label: "offers",
      })))],
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
    if (kind === "tool") {
      this.picked = node;
      this.draft = null;
      this.serverDraft = null;
      return;
    }
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

  // Double-clicking a node opens it in the inspector. The canvas's own
  // configuration panel is turned off through `disable-node-config`, so this
  // only has to say which node was asked for.
  //
  // Two editors for one row is the thing being avoided, and the panel is the
  // one to lose: it edits the workflow object this component was handed, and
  // the graph is rebuilt from the API on every load, so anything typed there
  // goes quietly. It also describes an agent as owning a provider and an API
  // key with LLM, Prompt, Memory and Tools to connect — the workflow
  // builder's model, not this one, where an agent names a model config and a
  // prompt by id. And its name field shows the node's label, which for the
  // entry agent carries a "· entry" suffix that is not part of the name.
  private configure(e: CustomEvent) {
    this.pick(e.detail?.node?.id ?? e.detail?.nodeId ?? "");
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

    // Only relations the console owns. A server-to-tool edge is the server
    // stating what it offers — there is no route that could store a change to
    // it, and treating one as a link would send a tool's id to linkServer.
    const now: Link[] = wf.edges
      .filter((x) => x.sourceNodeId !== x.targetNodeId)
      .map((x) => ({ source: partsOf(x.sourceNodeId), target: partsOf(x.targetNodeId) }))
      .filter((x) => x.source.kind === "agent" && x.target.kind !== "tool")
      .map((x) => ({ parent: x.source.id, child: x.target.id, kind: x.target.kind }));
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

      <nr-input id="s-name" .value=${v.serverName} placeholder="What this server is called"
        @nr-input=${(e: Event) => this.editServer("serverName", valueOf(e))}>
        <span slot="label">Name</span>
      </nr-input>

      <nr-input id="s-endpoint" .value=${v.endpoint} placeholder="https://…"
        @nr-input=${(e: Event) => this.editServer("endpoint", valueOf(e))}>
        <span slot="label">Endpoint</span>
      </nr-input>

      <nr-select id="s-transport" .value=${v.transport}
        .options=${transportOptions(v.transport)}
        @nr-change=${(e: Event) => this.editServer("transport", valueOf(e))}>
        <span slot="label">Transport</span>
      </nr-select>

      <nr-select id="s-authkind" .value=${v.authKind}
        .options=${[
          { value: "none", label: "none" },
          { value: "bearer", label: "bearer" },
          { value: "header", label: "custom header" },
        ]}
        @nr-change=${(e: Event) => this.editServer("authKind", valueOf(e))}>
        <span slot="label">Authentication</span>
      </nr-select>

      ${v.authKind === "header" ? html`
        <nr-input id="s-authheader" .value=${v.authHeader} placeholder="X-Api-Key"
          @nr-input=${(e: Event) => this.editServer("authHeader", valueOf(e))}>
          <span slot="label">Header name</span>
        </nr-input>` : ""}

      <div class="row">
        <nr-checkbox id="s-enabled" ?checked=${v.enabled}
          @nr-change=${(e: CustomEvent) => this.editServer("enabled", e.detail.checked)}>Enabled</nr-checkbox>
      </div>

      ${this.toolNote(v)}

      <p class="empty">The token itself is set in Settings and never read back,
      so it is not shown here and saving cannot clear it.</p>

      <div class="actions">
        <nr-button id="s-save" type="primary" ?disabled=${this.busy}
          @click=${() => this.saveServer()}>Save</nr-button>
        <nr-button id="s-revert" ?disabled=${this.busy}
          @click=${() => this.pick(nodeId("server", v.id))}>Revert</nr-button>
      </div>
      ${this.problem !== "" ? html`<div class="problem" role="alert">${this.problem}</div>` : ""}
      ${this.saved !== "" ? html`<div class="saved">${this.saved}</div>` : ""}
    `;
  }

  // A tool is not ours to edit: the server declares it. Shown, not offered as
  // a form, because a form that cannot save anything is a lie about what the
  // console can do.
  private toolView(node: string) {
    const { id } = partsOf(node);
    const cut = id.indexOf("/");
    const serverId = id.slice(0, cut);
    const name = id.slice(cut + 1);
    const server = this.servers.find((v) => v.id === serverId);
    const tool = this.tools.find((t) => t.serverId === serverId)?.tools
      .find((x) => x.name === name);
    return html`
      <h3>${name}</h3>
      <div class="sub">tool · offered by ${server?.serverName ?? serverId}</div>
      <p class="claim">${tool?.description !== "" ? tool?.description : "This tool gives no description."}</p>
      <p class="empty">What a server offers is the server's to say. It is read
      each time the graph is drawn and never stored here, so it cannot be
      edited from the console.</p>
    `;
  }

  // What this server answered when it was asked for its tools. A count when it
  // answered, the reason when it did not — the two must not look the same.
  private toolNote(v: ServerRow) {
    const listed = this.tools.find((t) => t.serverId === v.id);
    if (!listed) return "";
    if (listed.problem !== "") {
      return html`<div class="problem">no tools drawn: ${listed.problem}</div>`;
    }
    // Its own class, not `.saved`: that one means "your edit was stored", and
    // sharing it put two different meanings under one name — which a test
    // caught as two elements where it expected one.
    return html`<div class="offers">${listed.tools.length} tools offered</div>`;
  }

  private inspector() {
    if (this.picked !== "" && partsOf(this.picked).kind === "tool") {
      return this.toolView(this.picked);
    }
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

      <nr-input id="c-name" .value=${d.agentName} placeholder="What this agent is called"
        @nr-input=${(e: Event) => this.edit("agentName", valueOf(e))}>
        <span slot="label">Name</span>
      </nr-input>

      <nr-textarea id="c-desc" .value=${d.description} rows="3"
        placeholder="What it is for"
        @nr-input=${(e: Event) => this.edit("description", valueOf(e))}>
        <span slot="label">Description</span>
      </nr-textarea>

      <nr-select id="c-config" .value=${d.modelConfigId}
        .options=${this.configs.map((c) => ({ value: c.id, label: `${c.id} · ${c.modelId}` }))}
        @nr-change=${(e: Event) => this.edit("modelConfigId", valueOf(e))}>
        <span slot="label">Model config</span>
      </nr-select>

      <nr-select id="c-prompt" .value=${d.promptId}
        .options=${this.prompts.map((x) => ({ value: x.id, label: `${x.promptName} v${x.version}` }))}
        @nr-change=${(e: Event) => this.edit("promptId", valueOf(e))}>
        <span slot="label">Prompt</span>
      </nr-select>

      <div class="row">
        <nr-checkbox id="c-enabled" ?checked=${d.enabled}
          @nr-change=${(e: CustomEvent) => this.edit("enabled", e.detail.checked)}>Enabled</nr-checkbox>
      </div>
      <div class="row">
        <nr-checkbox id="c-default" ?checked=${d.isDefault}
          @nr-change=${(e: CustomEvent) => this.edit("isDefault", e.detail.checked)}>Entry agent</nr-checkbox>
      </div>

      <div class="actions">
        <nr-button id="c-save" type="primary" ?disabled=${this.busy}
          @click=${() => this.save()}>Save</nr-button>
        <nr-button id="c-revert" ?disabled=${this.busy}
          @click=${() => this.pick(nodeId("agent", d.id))}>Revert</nr-button>
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
          ${this.links.filter((l) => l.kind === "server").length} tool links ·
          ${this.tools.reduce((n, t) => n + t.tools.length, 0)} tools</span>
        <nr-button id="tidy" size="small" @click=${() => this.tidy()}>Tidy</nr-button>
      </header>
      <div class="body">
        <workflow-canvas
          .workflow=${this.workflow()}
          ?showMinimap=${true}
          ?showToolbar=${true}
          ?showPalette=${false}
          .disableNodeConfig=${true}
          @node-selected=${(e: CustomEvent) =>
            this.pick(e.detail?.nodeId ?? e.detail?.node?.id ?? "")}
          @node-configured=${(e: CustomEvent) => this.configure(e)}
          @node-moved=${(e: CustomEvent) => this.moved(e)}
          @workflow-changed=${(e: CustomEvent) => this.changed(e)}
        ></workflow-canvas>
        <aside>${this.inspector()}</aside>
      </div>
    `;
  }
}

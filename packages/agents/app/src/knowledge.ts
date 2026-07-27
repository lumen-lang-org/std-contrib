// The knowledge page: a working surface, not a settings tab. Folder rail on
// the left, the selected folder's sources in the middle, upload into any
// path. A "new folder" is just a path nothing has been filed under yet —
// scopes exist by carrying documents, so creation is choosing where the next
// upload lands.

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ModelRow, ScopeNode, SourceListing, deleteSource, listModels, listScopes,
  listSources, uploadDocument,
} from "./api.js";

// How often to look again while something is indexing. Only runs while there
// is work — a page watching an idle queue is a page polling for nothing.
const WATCH_MS = 1500;

// A folder and what hangs under it. Intermediate folders are synthesized: a
// scope exists by carrying documents, so nothing is filed at /engineering
// when /engineering/plume has everything — but the branch still has to be
// there to open, and its count is the subtree's.
type TreeNode = {
  path: string;
  name: string;
  documents: number;
  total: number;
  children: TreeNode[];
};

function buildTree(rows: ScopeNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const ensure = (path: string): TreeNode => {
    const found = byPath.get(path);
    if (found) return found;
    const node: TreeNode = {
      path,
      name: path.slice(path.lastIndexOf("/") + 1) || "/",
      documents: 0, total: 0, children: [],
    };
    byPath.set(path, node);
    const cut = path.lastIndexOf("/");
    if (cut > 0) ensure(path.slice(0, cut)).children.push(node);
    else roots.push(node);
    return node;
  };

  for (const r of rows) {
    const node = ensure(r.path);
    node.documents = r.documents;
    node.total = r.total;
  }

  // A synthesized parent has no row of its own, so its total is its
  // children's. Depth-first, so a child is summed before its parent.
  const sum = (n: TreeNode): number => {
    const below = n.children.reduce((acc, c) => acc + sum(c), 0);
    n.total = Math.max(n.total, n.documents + below);
    return n.total;
  };
  roots.forEach(sum);

  const sort = (ns: TreeNode[]) => {
    ns.sort((a, b) => a.name.localeCompare(b.name));
    ns.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

@customElement("knowledge-page")
export class KnowledgePage extends LitElement {
  static styles = css`
    :host { display: flex; height: 100%; min-width: 0; }
    aside { width: 230px; border-right: 1px solid var(--border); background: var(--bg-rail);
            overflow-y: auto; padding: 10px 8px; }
    h3 { margin: 4px 8px 8px; font-size: 12px; text-transform: uppercase;
         letter-spacing: 0.06em; color: var(--muted); }
    .scope { padding: 6px 8px; border-radius: 8px; cursor: pointer; font-size: 13.5px;
             color: var(--muted); display: flex; align-items: center; gap: 6px; }
    .scope:hover, .scope.on { background: var(--bg-user); color: var(--fg); }
    .scope .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scope small { color: var(--muted); }
    .twist { width: 12px; flex: none; text-align: center; font-size: 10px;
             color: var(--muted); }
    main { flex: 1; min-width: 0; overflow-y: auto; padding: 18px 24px; }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    td, th { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; }
    input, select { background: var(--bg-card); border: 1px solid var(--border);
            color: inherit; border-radius: 8px; padding: 6px 9px; font: inherit; }
    button { background: var(--accent); color: var(--accent-fg); border: 0;
             border-radius: 8px; padding: 6px 13px; cursor: pointer; font: inherit; }
    button:hover { background: var(--accent-hover); }
    .ghost { background: none; color: var(--muted); border: 1px solid var(--border); }
    tr.folder { cursor: pointer; }
    tr.folder:hover td { background: var(--bg-user); }
    .row { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
    .note { color: var(--muted); }
    .err { color: #B3261E; }
    .title { font: 600 17px var(--display); margin: 0 0 12px; }
    .status { font-size: 12px; border-radius: 999px; padding: 2px 9px;
              border: 1px solid var(--border); color: var(--muted); }
    .status.indexed { color: #2F6F4E; border-color: #BFD8C9; }
    .status.queued, .status.indexing { color: #8A5A2B; border-color: #E6D2B8; }
    .status.failed { color: #B3261E; border-color: #E8C0BC; }
  `;

  @state() private scopes: ScopeNode[] = [];
  @state() private collapsed = new Set<string>();
  @state() private scope = "/";
  @state() private sources: SourceListing[] = [];
  // The one enabled embedding model. Not a choice made per upload: documents
  // embedded by different models cannot see each other, so which embedder is
  // active is a property of the corpus, set once under Settings.
  @state() private embedder: ModelRow | null = null;
  @state() private problem = "";
  @state() private busy = "";
  private watch: number = 0;

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.watch !== 0) { clearInterval(this.watch); this.watch = 0; }
  }

  // Poll while anything is queued or indexing, and stop when it settles.
  private keepWatching() {
    const pending = this.sources.some((s) => s.status === "queued" || s.status === "indexing");
    if (pending && this.watch === 0) {
      this.watch = window.setInterval(() => void this.refresh(), WATCH_MS);
    }
    if (!pending && this.watch !== 0) {
      clearInterval(this.watch);
      this.watch = 0;
    }
  }

  async connectedCallback() {
    super.connectedCallback();
    try {
      this.embedder = (await listModels())
        .find((m) => m.kind === "embedding" && m.enabled) ?? null;
      await this.refresh();
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async refresh() {
    this.problem = "";
    try {
      this.scopes = await listScopes();
      if (this.scope === "/" && this.scopes.length > 0) this.scope = this.scopes[0].path;
      this.sources = await listSources(this.scope);
      this.keepWatching();
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async pick(path: string) {
    this.scope = path;
    await this.refresh();
  }

  private upload() {
    const model = this.embedder?.id ?? "";
    const into = (this.shadowRoot!.querySelector("[name=into]") as HTMLInputElement)?.value || this.scope;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        this.busy = `Indexing ${f.name}…`;
        try {
          await uploadDocument(f.name.replace(/\.[^.]+$/, ""), into, await f.text(), model);
        } catch (e) {
          this.problem = e instanceof Error ? e.message : String(e);
          break;
        }
      }
      this.busy = "";
      await this.refresh();
    };
    input.click();
  }

  // One folder and, unless collapsed, everything under it. The count is the
  // subtree's, so a closed branch still says how much it holds.
  private branch(n: TreeNode, depth: number): unknown {
    const open = !this.collapsed.has(n.path);
    const kids = n.children.length > 0;
    return html`
      <div class="scope ${n.path === this.scope ? "on" : ""}"
        data-path=${n.path}
        data-open=${kids ? String(open) : "leaf"}
        style="padding-left: ${8 + depth * 14}px" @click=${() => this.pick(n.path)}>
        <span class="twist" @click=${(e: Event) => { e.stopPropagation(); this.twist(n.path); }}>
          ${kids ? (open ? "▾" : "▸") : ""}
        </span>
        <span class="name" title=${n.path}>${n.name}</span>
        <small>${n.total}</small>
      </div>
      ${kids && open ? n.children.map((k) => this.branch(k, depth + 1)) : ""}
    `;
  }

  // The folders directly under a path, so the list reads like a file manager:
  // folders first, then what is filed here. The rail shows the whole shape;
  // this shows where you are.
  private childrenOf(path: string): TreeNode[] {
    const walk = (ns: TreeNode[]): TreeNode[] => {
      for (const n of ns) {
        if (n.path === path) return n.children;
        const below = walk(n.children);
        if (below.length > 0) return below;
      }
      return [];
    };
    return walk(buildTree(this.scopes));
  }

  private parentOf(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut > 0 ? path.slice(0, cut) : "";
  }

  private twist(path: string) {
    const next = new Set(this.collapsed);
    if (next.has(path)) next.delete(path); else next.add(path);
    this.collapsed = next;
  }

  render() {
    return html`
      <aside>
        <h3>Folders</h3>
        ${buildTree(this.scopes).map((n) => this.branch(n, 0))}
        ${this.scopes.length === 0 ? html`<div class="scope">none yet</div>` : ""}
      </aside>
      <main>
        <p class="title">Knowledge · ${this.scope}</p>
        ${this.problem === "" ? "" : html`<p class="err">${this.problem}</p>`}
        ${this.busy === "" ? "" : html`<p class="note">${this.busy}</p>`}
        <div class="row">
          <input name="into" placeholder="folder — typing a new path creates it" .value=${this.scope} style="flex:1" />
          <button ?disabled=${this.embedder === null} @click=${this.upload}>Upload</button>
        </div>
        ${this.embedder === null ? html`
          <p class="note">No embedding model is enabled — turn one on under Settings → Models
          before uploading.</p>` : html`
          <p class="note">Indexed with <strong>${this.embedder.label}</strong>.</p>`}
        <div class="scroll"><table>
          <tr><th>Name</th><th>Status</th><th>Chunks</th><th>Size</th><th></th></tr>
          ${this.parentOf(this.scope) === "" ? "" : html`<tr class="folder"
            @click=${() => this.pick(this.parentOf(this.scope))}>
            <td colspan="5" class="note">↩ ${this.parentOf(this.scope)}</td>
          </tr>`}
          ${this.childrenOf(this.scope).map((n) => html`<tr class="folder"
            @click=${() => this.pick(n.path)}>
            <td>📁 ${n.name}</td>
            <td class="note">—</td>
            <td class="note">—</td>
            <td class="note">${n.total} ${n.total === 1 ? "document" : "documents"}</td>
            <td></td>
          </tr>`)}
          ${this.sources.map((s) => html`<tr>
            <td>${s.source}</td>
            <td><span class="status ${s.status}" title=${s.error}>${s.status}</span></td>
            <td>${s.status === "indexed" ? s.chunks : html`<span class="note">—</span>`}</td>
            <td>${s.status === "indexed"
              ? (s.bytes / 1024).toFixed(1) + " kB"
              : html`<span class="note">—</span>`}</td>
            <td>${s.status === "indexed" || s.status === "failed" ? html`
              <button class="ghost" @click=${() =>
                deleteSource(s.source).then(() => this.refresh())}>Delete</button>` : ""}</td>
          </tr>`)}
        </table></div>
        ${this.sources.length === 0 && this.childrenOf(this.scope).length === 0
          ? html`<p class="note">Nothing filed here yet.</p>` : ""}
      </main>
    `;
  }
}

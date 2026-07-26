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

@customElement("knowledge-page")
export class KnowledgePage extends LitElement {
  static styles = css`
    :host { display: flex; height: 100%; min-width: 0; }
    aside { width: 230px; border-right: 1px solid var(--border); background: var(--bg-rail);
            overflow-y: auto; padding: 10px 8px; }
    h3 { margin: 4px 8px 8px; font-size: 12px; text-transform: uppercase;
         letter-spacing: 0.06em; color: var(--muted); }
    .scope { padding: 7px 10px; border-radius: 8px; cursor: pointer; font-size: 13.5px;
             color: var(--muted); display: flex; justify-content: space-between; }
    .scope:hover, .scope.on { background: var(--bg-user); color: var(--fg); }
    .scope small { color: var(--muted); }
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
    .row { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
    .note { color: var(--muted); }
    .err { color: #B3261E; }
    .title { font: 600 17px var(--serif); margin: 0 0 12px; }
  `;

  @state() private scopes: ScopeNode[] = [];
  @state() private scope = "/";
  @state() private sources: SourceListing[] = [];
  @state() private embedders: ModelRow[] = [];
  @state() private problem = "";
  @state() private busy = "";

  async connectedCallback() {
    super.connectedCallback();
    try {
      this.embedders = (await listModels()).filter((m) => m.kind === "embedding" && m.enabled);
      await this.refresh();
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async refresh() {
    this.problem = "";
    try {
      this.scopes = await listScopes();
      if (this.scope === "/" && this.scopes.length > 0) this.scope = this.scopes[0].path;
      this.sources = await listSources(this.scope);
    } catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
  }

  private async pick(path: string) {
    this.scope = path;
    await this.refresh();
  }

  private upload() {
    const model = (this.shadowRoot!.querySelector("[name=model]") as HTMLSelectElement)?.value ?? "";
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

  render() {
    return html`
      <aside>
        <h3>Folders</h3>
        ${this.scopes.map((s) => html`
          <div class="scope ${s.path === this.scope ? "on" : ""}" @click=${() => this.pick(s.path)}>
            <span>${s.path}</span><small>${s.total}</small>
          </div>`)}
        ${this.scopes.length === 0 ? html`<div class="scope">none yet</div>` : ""}
      </aside>
      <main>
        <p class="title">Knowledge · ${this.scope}</p>
        ${this.problem === "" ? "" : html`<p class="err">${this.problem}</p>`}
        ${this.busy === "" ? "" : html`<p class="note">${this.busy}</p>`}
        <div class="row">
          <input name="into" placeholder="folder — typing a new path creates it" .value=${this.scope} style="flex:1" />
          <select name="model">
            ${this.embedders.map((m) => html`<option value=${m.id}>${m.label}</option>`)}
          </select>
          <button ?disabled=${this.embedders.length === 0} @click=${this.upload}>Upload</button>
        </div>
        ${this.embedders.length === 0 ? html`
          <p class="note">No enabled embedding model — add one under Settings → Models first.</p>` : ""}
        <div class="scroll"><table>
          <tr><th>Source</th><th>Chunks</th><th>Size</th><th></th></tr>
          ${this.sources.map((s) => html`<tr>
            <td>${s.source}</td><td>${s.chunks}</td><td>${(s.bytes / 1024).toFixed(1)} kB</td>
            <td><button class="ghost" @click=${() =>
              deleteSource(s.source).then(() => this.refresh())}>Delete</button></td>
          </tr>`)}
        </table></div>
        ${this.sources.length === 0 ? html`<p class="note">Nothing filed here yet.</p>` : ""}
      </main>
    `;
  }
}

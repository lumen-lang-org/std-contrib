// The left rail: brand, search, new conversation, and the thread list.
// Fires `pick-thread` ({id}) and `new-thread`.

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ThreadListing } from "./api.js";

@customElement("console-sidebar")
export class ConsoleSidebar extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%;
            background: var(--bg-rail); border-right: 1px solid var(--border); }
    .brand { padding: 16px 18px 12px; font: 700 18px var(--serif); }
    .brand .dot { color: var(--accent); }
    .tools { display: flex; gap: 8px; padding: 0 14px 12px; }
    input { flex: 1; background: var(--bg-card); border: 1px solid var(--border);
            color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; }
    button { background: var(--accent); color: var(--accent-fg); border: 0;
             border-radius: 8px; padding: 6px 11px; cursor: pointer; font: inherit; }
    button:hover { background: var(--accent-hover); }
    nav { flex: 1; overflow-y: auto; padding: 4px 8px; }
    .thread { padding: 8px 10px; cursor: pointer; border-radius: 8px; margin: 1px 0;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              font-size: 13.5px; color: var(--muted); }
    .thread:hover { background: var(--bg-user); color: var(--fg); }
    .thread.active { color: var(--fg); background: var(--bg-user); }
    .none { padding: 16px; color: var(--muted); font-size: 13px; }
    footer { position: relative; border-top: 1px solid var(--border); padding: 10px 12px; }
    .me { display: flex; align-items: center; gap: 10px; cursor: pointer;
          border-radius: 8px; padding: 6px 8px; }
    .me:hover { background: var(--bg-user); }
    .avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent);
              color: var(--accent-fg); display: grid; place-items: center;
              font: 600 13px var(--serif); }
    .who { flex: 1; font-size: 13.5px; }
    .menu { position: absolute; bottom: 54px; left: 12px; right: 12px;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; box-shadow: 0 10px 30px rgba(31,30,29,0.14);
            overflow: hidden; }
    .menu div { padding: 9px 14px; cursor: pointer; font-size: 13.5px; }
    .menu div:hover { background: var(--bg-user); }
    .menu .about { color: var(--muted); cursor: default; border-top: 1px solid var(--border); }
    .menu .about:hover { background: none; }
  `;

  @property({ type: Array }) threads: ThreadListing[] = [];
  @property() activeId = "";
  @state() private filter = "";
  @state() private menu = false;

  private shown(): ThreadListing[] {
    const q = this.filter.trim().toLowerCase();
    if (q === "") return this.threads;
    return this.threads.filter((t) => t.title.toLowerCase().includes(q));
  }

  render() {
    return html`
      <div class="brand">Agents<span class="dot">.</span></div>
      <div class="tools">
        <input placeholder="Search…"
          @input=${(e: Event) => { this.filter = (e.target as HTMLInputElement).value; }} />
        <button title="New conversation"
          @click=${() => this.dispatchEvent(new CustomEvent("new-thread"))}>+</button>
      </div>
      <nav>
        ${this.shown().length === 0 ? html`<div class="none">No conversations yet.</div>` : ""}
        ${this.shown().map((t) => html`
          <div class="thread ${t.id === this.activeId ? "active" : ""}"
            title=${t.title}
            @click=${() => this.dispatchEvent(new CustomEvent("pick-thread", { detail: { id: t.id } }))}>
            ${t.title === "" ? t.agentId : t.title}
          </div>`)}
      </nav>
      <div class="thread" style="margin: 0 8px 4px" @click=${() =>
        this.dispatchEvent(new CustomEvent("open-knowledge"))}>📚 Knowledge</div>
      <div class="thread" style="margin: 0 8px 4px" @click=${() =>
        this.dispatchEvent(new CustomEvent("open-canvas"))}>🕸 Agent graph</div>
      <footer>
        ${this.menu ? html`<div class="menu">
          <div @click=${() => { this.menu = false; this.dispatchEvent(new CustomEvent("open-settings")); }}>Settings</div>
          <div class="about">Agent console · std-contrib</div>
        </div>` : ""}
        <div class="me" @click=${() => { this.menu = !this.menu; }}>
          <span class="avatar">A</span>
          <span class="who">Agents</span>
          <span>⋯</span>
        </div>
      </footer>
    `;
  }
}

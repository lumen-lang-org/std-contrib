// The left rail: brand, search, new conversation, and the thread list.
// Fires `pick-thread` ({id}) and `new-thread`.

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ThreadListing } from "./api.js";

@customElement("console-sidebar")
export class ConsoleSidebar extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%;
            background: #0a0d12; border-right: 1px solid #21262d; }
    .brand { padding: 14px 16px; font-weight: 700; }
    .brand .dot { color: #ea580c; }
    .tools { display: flex; gap: 8px; padding: 0 12px 10px; }
    input { flex: 1; background: #161b22; border: 1px solid #21262d; color: inherit;
            border-radius: 6px; padding: 6px 10px; font: inherit; }
    button { background: #ea580c; color: #fff; border: 0; border-radius: 6px;
             padding: 6px 10px; cursor: pointer; font: inherit; }
    nav { flex: 1; overflow-y: auto; }
    .thread { padding: 9px 16px; cursor: pointer; border-left: 2px solid transparent;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              font-size: 13.5px; color: #b6bec8; }
    .thread:hover { background: #161b22; }
    .thread.active { color: #e6edf3; border-left-color: #ea580c; background: #161b22; }
    .none { padding: 16px; color: #8b949e; font-size: 13px; }
  `;

  @property({ type: Array }) threads: ThreadListing[] = [];
  @property() activeId = "";
  @state() private filter = "";

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
    `;
  }
}

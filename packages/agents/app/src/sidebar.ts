// The left rail: brand, search, new conversation, and the thread list.
// Fires `pick-thread` ({id}) and `new-thread`.

import { LitElement, css, html } from "lit";
import { BRAND } from "./brand.js";
import { customElement, property, state } from "lit/decorators.js";
import type { Me, ThreadListing } from "./api.js";
import { isAdmin } from "./api.js";

@customElement("console-sidebar")
export class ConsoleSidebar extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%;
            background: var(--bg-rail); border-right: 1px solid var(--border); }

    /* Top: the wordmark, and the two things you do to the rail itself. */
    .top { display: flex; align-items: center; gap: 4px; padding: 12px 10px 6px; }
    .brand { flex: 1; padding-left: 6px; font: 600 15px var(--display);
             letter-spacing: -0.01em; }
    .brand .dot { color: var(--brand); }
    .top button { background: none; border: 0; color: var(--muted); cursor: pointer;
                  padding: 5px; border-radius: 7px; display: grid; place-items: center; }
    .top button:hover { background: var(--bg-sunken); color: var(--fg); }

    /* Actions and navigation share one row shape, so the rail reads as a
       single list rather than as three stacked widgets. */
    .item { display: flex; align-items: center; gap: 10px; margin: 1px 8px;
            padding: 8px 10px; border-radius: 12px; cursor: pointer;
            color: var(--fg); font-size: 14px;
            transition: background-color .15s cubic-bezier(.23,1,.32,1); }
    .item:hover { background: var(--bg-sunken); }
    /* The same ink as the label beside it, not --muted.
       --muted is rgba(0,0,0,.45), which renders 140,140,140 on this rail's
       250,250,250 — a grey glyph next to near-black text, so every row read as
       half disabled. Sampled against Kimi's rail at the same size, its row
       icons carry the SAME ink as their labels; grey is spent there on the
       section headings only. This is the rule the console's own header and
       composer icons already follow. */
    .item nr-icon { color: var(--fg); }

    /* Search is a row until it is used, like every other row here. */
    .find { display: flex; align-items: center; gap: 10px; margin: 1px 8px;
            padding: 8px 10px; border-radius: 12px;
            transition: background-color .15s cubic-bezier(.23,1,.32,1); }
    .find:focus-within { background: var(--bg-sunken); }
    .find nr-icon { color: var(--fg); }
    .find input { flex: 1; min-width: 0; background: none; border: 0; padding: 0;
                  font: inherit; color: inherit; outline: none; }
    .find input::placeholder { color: var(--muted); }

    .label { padding: 14px 16px 4px; font-size: 11.5px; color: var(--muted);
             font-weight: 500; }

    nav { flex: 1; overflow-y: auto; padding-bottom: 8px; }
    .thread { margin: 1px 8px; padding: 7px 10px; cursor: pointer; border-radius: 12px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              /* A conversation title is a destination, not an annotation. At
                 --muted it was the faintest text on the rail while being the
                 only part of it a person actually reads — the hover and active
                 states below already promote it to --fg, so the resting state
                 was the odd one out. */
              font-size: 13.5px; color: var(--fg);
              transition: background-color .15s cubic-bezier(.23,1,.32,1),
                          color .15s cubic-bezier(.23,1,.32,1); }
    .thread:hover { background: var(--bg-sunken); color: var(--fg); }
    .thread.active { color: var(--fg); background: var(--bg-sunken); }
    .none { padding: 8px 16px; color: var(--muted); font-size: 13px; }

    footer { position: relative; border-top: 1px solid var(--border); padding: 8px; }
    .me { display: flex; align-items: center; gap: 10px; cursor: pointer;
          border-radius: 12px; padding: 6px 10px;
          transition: background-color .15s cubic-bezier(.23,1,.32,1); }
    .me:hover { background: var(--bg-sunken); }
    .avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--brand);
              color: var(--accent-fg); display: grid; place-items: center;
              font: 600 12px var(--display); flex: none; }
    .who { flex: 1; font-size: 13.5px; }
    .menu { position: absolute; bottom: 52px; left: 8px; right: 8px;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; box-shadow: 0 12px 32px rgba(23,23,26,0.14);
            overflow: hidden; }
    .menu div { padding: 9px 14px; cursor: pointer; font-size: 13.5px; }
    .menu div:hover { background: var(--bg-sunken); }
    .menu .about { color: var(--muted); cursor: default; border-top: 1px solid var(--border); }
    .menu .about:hover { background: none; }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  `;



  @property({ type: Array }) threads: ThreadListing[] = [];
  @property() activeId = "";
  // Null until asked, and null again where nothing authenticates — see
  // `whoami` in api.ts for why those two are not the same answer.
  @property({ attribute: false }) me: Me | null = null;
  @state() private filter = "";
  @state() private menu = false;

  // A name to show, preferring what a person would recognise. The gateway
  // fills `username` from the token's email when the claim carries no name,
  // so an address is the common case and the local part reads better in 13px.
  private name(): string {
    if (this.me === null) { return BRAND; }
    // The gateway calls a minted visitor "guest" with an empty email; say the
    // word properly rather than printing the tag's lowercase spelling.
    if (this.me.anonymous === true) { return "Guest"; }
    const said = this.me.username !== "" ? this.me.username : this.me.email;
    return said.includes("@") ? said.split("@")[0] : said;
  }

  private initial(): string {
    const n = this.name();
    return n === "" ? "?" : n[0].toUpperCase();
  }

  private shown(): ThreadListing[] {
    const q = this.filter.trim().toLowerCase();
    if (q === "") return this.threads;
    return this.threads.filter((t) => t.title.toLowerCase().includes(q));
  }

  render() {
    return html`
      <div class="top">
        <span class="brand">${BRAND}<span class="dot">.</span></span>
        <button class="collapse" title="Collapse the sidebar"
          @click=${() => this.dispatchEvent(new CustomEvent("collapse"))}>
          <!-- "panel-left": the set has no "sidebar", and a name it does not
               carry is drawn as the name. -->
          <nr-icon name="panel-left" size="small"></nr-icon>
        </button>
      </div>

      <!-- What you do, then where you go. Both are rows of the same shape, so
           the eye runs down one list instead of crossing three widgets. -->
      <div class="item" data-nav="new" @click=${() => this.dispatchEvent(new CustomEvent("new-thread"))}>
        <nr-icon name="edit" size="small"></nr-icon><span>New conversation</span>
      </div>
      <div class="item" data-nav="knowledge" @click=${() => this.dispatchEvent(new CustomEvent("open-knowledge"))}>
        <nr-icon name="database" size="small"></nr-icon><span>Knowledge</span>
      </div>
      <!-- No "Agent graph" row. The graph is not a place beside Knowledge; it
           is a view OF an agent, and the way in is the agent's own card in
           the directory — where "which agent" has already been answered. -->
      <!-- The two directory shelves that are worth a standing place. They were
           reachable only from the composer's + menu, which is a menu you open
           mid-sentence — fine for pinning a skill while you write, wrong for
           "who am I talking to" and "what can this reach", which are questions
           you ask before you start. Both open the same overlay the + menu
           opens, on their own tab. -->
      <div class="item" data-nav="agents" @click=${() => this.dispatchEvent(new CustomEvent("open-agents"))}>
        <nr-icon name="users" size="small"></nr-icon><span>Agents</span>
      </div>
      <div class="item" data-nav="connectors" @click=${() => this.dispatchEvent(new CustomEvent("open-connectors"))}>
        <nr-icon name="plug" size="small"></nr-icon><span>Connectors</span>
      </div>
      <!-- What other people have offered to start from. Under the three that
           are about your own work, because it is somebody else's. -->
      <div class="item" data-nav="starts" @click=${() => this.dispatchEvent(new CustomEvent("open-starts"))}>
        <nr-icon name="share" size="small"></nr-icon><span>Starting points</span>
      </div>

      <div class="find">
        <nr-icon name="search" size="small"></nr-icon>
        <input placeholder="Search…" aria-label="Search conversations"
          @input=${(e: Event) => { this.filter = (e.target as HTMLInputElement).value; }} />
      </div>

      <div class="label">Recents</div>
      <nav>
        ${this.shown().length === 0 ? html`<div class="none">No conversations yet.</div>` : ""}
        ${this.shown().map((t) => html`
          <div class="thread ${t.id === this.activeId ? "active" : ""}"
            data-thread=${t.id}
            title=${t.title}
            @click=${() => this.dispatchEvent(new CustomEvent("pick-thread", { detail: { id: t.id } }))}>
            ${t.title === "" ? t.agentId : t.title}
          </div>`)}
      </nav>

      <footer>
        ${this.menu ? html`<div class="menu">
          <!-- One Settings for a person — it opens on Preferences and holds
               the authoring tabs beside it — and the operator's page for the
               people the gateway will admit; a row that answers 403 is worse
               than no row. -->
          <div @click=${() => { this.menu = false; this.dispatchEvent(new CustomEvent("open-settings")); }}>Settings</div>
          ${isAdmin(this.me) ? html`
            <div @click=${() => { this.menu = false; location.assign("/admin/models"); }}>Deployment settings</div>
          ` : ""}
          ${this.me === null ? "" : this.me.anonymous === true ? html`
            <!-- A guest signs IN, not out: /logout would only mint them a new
                 guest cookie on the next request. The console owns the
                 overlay, so this is an event, like every other row here. -->
            <div @click=${() => { this.menu = false; this.dispatchEvent(new CustomEvent("open-signin")); }}>Sign in</div>
          ` : html`
            <div @click=${() => { location.assign("/logout"); }}>Sign out</div>
          `}
          <div class="about">Agent console · std-contrib</div>
        </div>` : ""}
        <div class="me" @click=${() => { this.menu = !this.menu; }}
             title=${this.me === null ? "" : this.me.email}>
          <span class="avatar">${this.initial()}</span>
          <span class="who">${this.me === null ? BRAND : this.name()}</span>
          <nr-icon name="chevron-up" size="small"></nr-icon>
        </div>
      </footer>
    `;
  }
}

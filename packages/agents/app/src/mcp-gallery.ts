// A gallery of MCP servers a person can browse and add.
//
// The MCP tab today asks for an endpoint, a transport and an auth kind — which
// is the right form for someone who already knows which server they want and
// where it lives. It is the wrong first screen for someone who has heard of
// MCP and wants to see what is on offer. This is that first screen: a shelf of
// known servers, each with what it does and what it needs from you, and one
// button that fills the form in.
//
// --- why there is no table behind this ------------------------------------
//
// The obvious design is an `mcp_catalog` table, seeded by the operator, served
// over a new route. It was not built, and the reason is worth writing down: a
// catalogue row holds no state. Nothing points at it, nothing edits it, it
// never differs per deployment, and the moment it is a row it needs a
// migration, a REST controller, seeding into every environment, and a story
// for what happens when the catalogue and the code disagree about a server's
// shape. A constant in the console has none of that and is edited in a pull
// request, which is exactly the review a curated list wants.
//
// What IS a row is the server a person adds — that already exists
// (mcpServersMapping, POST /servers), and this file's whole job is to fill
// that form in. Adding from the gallery and adding by hand converge on the
// same row, which is the property that keeps this from becoming a second way
// to own a server.
//
// If a deployment ever needs its own catalogue, the seam is `CATALOGUE`: swap
// the constant for a fetch and nothing else here changes.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/** One server on the shelf. `endpoint` is a suggestion, not a promise: a
 *  person may run their own copy, so the field stays editable after Add. */
export type CatalogueEntry = {
  id: string;
  name: string;
  /** One line, in the reader's terms — what it lets an agent do, not how. */
  what: string;
  /** What the person has to supply. "" when it needs nothing. Shown before
   *  they click, because discovering an API key requirement after adding a
   *  server is the annoyance this line exists to prevent. */
  needs: string;
  endpoint: string;
  transport: "http";
  authKind: "none" | "bearer" | "header";
  /** Where to read about it. Every entry has one — a server nobody can look
   *  up is one nobody should paste a token into. */
  docs: string;
};

// The shelf. Deliberately short and unglamorous: each of these is a server a
// person can plausibly point at today, and a list padded with things that only
// run behind someone else's paywall would be a catalogue of disappointments.
//
// Endpoints are the PUBLIC hosted ones where a public one exists, and a
// localhost default where the server is meant to be run beside the engine —
// the `needs` line says which, because "http://127.0.0.1:3000" in a field is
// otherwise indistinguishable from a service that is simply down.
export const CATALOGUE: CatalogueEntry[] = [
  {
    id: "cat-filesystem",
    name: "Filesystem",
    what: "Read and write files in a directory you choose",
    needs: "Runs beside the engine — start it yourself, then point this at it",
    endpoint: "http://127.0.0.1:8931/mcp",
    transport: "http",
    authKind: "none",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "cat-git",
    name: "Git",
    what: "Read a repository's history, branches and diffs",
    needs: "Runs beside the engine, with the repository mounted",
    endpoint: "http://127.0.0.1:8932/mcp",
    transport: "http",
    authKind: "none",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "cat-fetch",
    name: "Fetch",
    what: "Fetch a web page and read it as text",
    needs: "Runs beside the engine",
    endpoint: "http://127.0.0.1:8933/mcp",
    transport: "http",
    authKind: "none",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "cat-postgres",
    name: "PostgreSQL",
    what: "Query a database read-only and describe its schema",
    needs: "Runs beside the engine, with a connection string it owns",
    endpoint: "http://127.0.0.1:8934/mcp",
    transport: "http",
    authKind: "none",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
  {
    id: "cat-github",
    name: "GitHub",
    what: "Search code, read issues and open pull requests",
    needs: "A personal access token",
    endpoint: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    authKind: "bearer",
    docs: "https://github.com/github/github-mcp-server",
  },
  {
    id: "cat-sentry",
    name: "Sentry",
    what: "Read issues and stack traces from your projects",
    needs: "An auth token",
    endpoint: "https://mcp.sentry.dev/mcp",
    transport: "http",
    authKind: "bearer",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
  },
];

/** What the gallery asks the settings page to create. Deliberately the shape
 *  of the form rather than of the row: the page owns the POST, so the gallery
 *  never learns the API and there is one place that writes a server. */
export type AddRequest = {
  serverName: string;
  transport: string;
  endpoint: string;
  authKind: string;
  authHeader: string;
  enabled: boolean;
};

@customElement("mcp-gallery")
export class McpGallery extends LitElement {
  static styles = css`
    :host { display: block; }
    .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); }
    .card { display: flex; flex-direction: column; gap: 6px; padding: 14px;
            border: 1px solid var(--border); border-radius: 12px;
            background: var(--bg-card); }
    .top { display: flex; align-items: center; gap: 8px; }
    .name { font-size: 14px; font-weight: 600; color: var(--fg); }
    .what { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
    /* The requirement reads as a caveat, not as body copy: it is the one line
       that decides whether adding this server will work for you. */
    .needs { font-size: 12px; color: var(--faint); line-height: 1.4; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .add { font: inherit; font-size: 13px; padding: 6px 14px; cursor: pointer;
           border: 1px solid var(--border); border-radius: 999px;
           background: var(--bg-card); color: var(--fg); }
    .add:hover { background: var(--bg-user); border-color: var(--muted); }
    .add[disabled] { opacity: .55; cursor: default; }
    .docs { font-size: 12.5px; color: var(--muted); text-decoration: none; }
    .docs:hover { color: var(--fg); text-decoration: underline; }
    /* Already added: the card stays, because a shelf that hides what you own
       makes you wonder whether you imagined adding it. */
    .have { font-size: 12px; color: var(--ok); }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  `;

  /** The endpoints already configured, so the shelf can say which of these you
   *  have. Endpoints and not names: a person may rename a server, and the
   *  address is what actually decides whether it is the same one. */
  @property({ attribute: false }) taken: string[] = [];

  @state() private busy = "";

  private already(e: CatalogueEntry): boolean {
    return this.taken.includes(e.endpoint);
  }

  private add(e: CatalogueEntry): void {
    this.busy = e.id;
    const ask: AddRequest = {
      serverName: e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      transport: e.transport,
      endpoint: e.endpoint,
      authKind: e.authKind,
      authHeader: "",
      // Off. Adding a server from a shelf is a statement of interest, not of
      // trust — an entry that needs a token would otherwise be enabled and
      // failing every tool call until somebody noticed the form.
      enabled: false,
    };
    // Announced, not performed: the settings page owns the POST and the
    // refresh, the same split the model picker uses for pick-choice.
    this.dispatchEvent(new CustomEvent("add-server", { detail: ask }));
    // Cleared by the page re-rendering with a new `taken`; the latch is only
    // here so a double click does not send two.
    setTimeout(() => { this.busy = ""; }, 1200);
  }

  render() {
    return html`
      <div class="grid">
        ${CATALOGUE.map((e) => html`
          <div class="card">
            <div class="top"><span class="name">${e.name}</span></div>
            <div class="what">${e.what}</div>
            ${e.needs === "" ? nothing : html`<div class="needs">${e.needs}</div>`}
            <div class="foot">
              ${this.already(e)
                ? html`<span class="have">Added</span>`
                : html`<button class="add" ?disabled=${this.busy === e.id}
                          @click=${() => this.add(e)}>Add</button>`}
              <a class="docs" href=${e.docs} target="_blank" rel="noreferrer">Docs</a>
            </div>
          </div>`)}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { "mcp-gallery": McpGallery }
}

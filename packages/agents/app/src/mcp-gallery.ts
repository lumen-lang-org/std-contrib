// A gallery of MCP servers a person can browse and connect.
//
// The MCP tab asks for an endpoint, a transport and an auth kind — the right
// form for someone who already knows which server they want and where it
// lives, and the wrong first screen for someone who has heard of MCP and wants
// to see what is on offer. This is that first screen.
//
// --- why every hosted entry says Connect and not Add -------------------------
//
// This shelf used to offer Sentry with `authKind: "bearer"`, and it had never
// worked. Not "worked badly" — the endpoint answers every unauthenticated call
// with `401 WWW-Authenticate: Bearer realm="OAuth"` and accepts no pasted key
// at all. The same is true of Linear, Atlassian and Notion. A shelf of hosted
// connectors that all want OAuth cannot be a shelf of token fields.
//
// What makes the OAuth path worth taking rather than a chore is that all four
// publish a `registration_endpoint`: the engine registers itself at connect
// time, so there is no app to create, no client secret to paste, and nothing
// per-deployment to keep alive. One press, one consent screen, done. That is
// why the button on those cards is the whole interaction and why there is no
// form behind it.
//
// --- why there is no table behind this ---------------------------------------
//
// The obvious design is an `mcp_catalog` table, seeded by the operator. A
// catalogue row holds no state: nothing points at it, nothing edits it, it
// never differs per deployment, and the moment it is a row it needs a
// migration, a controller, seeding into every environment, and a story for
// what happens when the catalogue and the code disagree. A constant is edited
// in a pull request, which is exactly the review a curated list wants.
//
// What IS a row is the server a person connects — that already exists
// (mcpServersMapping, POST /servers), and this file's whole job is to create
// one and hand it to the flow. Connecting from a card and adding by hand
// converge on the same row.
//
// If a deployment ever needs its own catalogue, the seam is `CATALOGUE`: swap
// the constant for a fetch and nothing else here changes.

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SVGTemplateResult } from "lit";

/** One server on the shelf. `endpoint` is a suggestion, not a promise: a
 *  person may run their own copy, so the field stays editable afterwards. */
export type CatalogueEntry = {
  id: string;
  name: string;
  /** One line, in the reader's terms — what it lets an agent do, not how. */
  what: string;
  /** What the person has to supply. "" when it needs nothing but the button.
   *  Shown before they press it, because discovering a requirement afterwards
   *  is the annoyance this line exists to prevent. */
  needs: string;
  endpoint: string;
  transport: "http";
  /** "oauth" — press Connect and approve it. "bearer" — it wants a token you
   *  paste. "none" — it is on your own network and trusts whoever reaches it. */
  authKind: "none" | "bearer" | "oauth";
  /** Whether this is somebody else's service or one you run beside the engine.
   *  Worth saying on the card: a localhost address in a field is otherwise
   *  indistinguishable from a service that is simply down. */
  where: "hosted" | "local";
  /** Where to read about it. Every entry has one — a server nobody can look up
   *  is one nobody should sign in to. */
  docs: string;
  /** The brand's own mark, as a single path on a 24×24 grid, and the colour it
   *  is drawn in. Paths from simple-icons (CC0); the marks remain their
   *  owners' trademarks and are used here to identify the service, which is
   *  the only thing a logo on a connector card is for. */
  mark: string;
  tint: string;
};

// The shelf. Deliberately short: each of these is a server a person can
// plausibly reach today, and a list padded with things that only run behind
// somebody else's paywall would be a catalogue of disappointments.
//
// Endpoints are the public hosted ones where a public one exists, and a
// localhost default where the server is meant to run beside the engine.
//
// Not here, deliberately: Gmail, Google Calendar and Google Drive. Google
// publishes no hosted MCP server — the connectors of that name in other
// products are first-party integrations, not endpoints anyone can point at —
// so the only honest entry is the community Workspace server below, which you
// run yourself. Inventing three hosted cards that 404 would be worse than not
// offering them.
export const CATALOGUE: CatalogueEntry[] = [
  {
    id: "cat-linear",
    name: "Linear",
    what: "Read and file issues, and follow what a team is working on",
    needs: "",
    endpoint: "https://mcp.linear.app/mcp",
    transport: "http",
    authKind: "oauth",
    where: "hosted",
    docs: "https://linear.app/docs/mcp",
    mark: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
    tint: "#5E6AD2",
  },
  {
    id: "cat-atlassian",
    name: "Atlassian",
    what: "Search Jira issues and read Confluence pages",
    needs: "",
    endpoint: "https://mcp.atlassian.com/v1/mcp",
    transport: "http",
    authKind: "oauth",
    where: "hosted",
    docs: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    mark: "M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z",
    tint: "#0052CC",
  },
  {
    id: "cat-notion",
    name: "Notion",
    what: "Search a workspace and read or append to its pages",
    needs: "",
    endpoint: "https://mcp.notion.com/mcp",
    transport: "http",
    authKind: "oauth",
    where: "hosted",
    docs: "https://developers.notion.com/docs/mcp",
    mark: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
    tint: "#0F0F0F",
  },
  {
    id: "cat-sentry",
    name: "Sentry",
    what: "Read issues and stack traces from your projects",
    needs: "",
    endpoint: "https://mcp.sentry.dev/mcp",
    transport: "http",
    authKind: "oauth",
    where: "hosted",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
    mark: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
    tint: "#362D59",
  },
  {
    id: "cat-github",
    name: "GitHub",
    what: "Search code, read issues and open pull requests",
    // The one hosted entry that is still a pasted token: GitHub's
    // authorization server is github.com/login/oauth, which registers no
    // clients dynamically, so there is an app to create by hand or a token to
    // paste. The token is the shorter road.
    needs: "A personal access token — GitHub does not register apps automatically",
    endpoint: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    authKind: "bearer",
    where: "hosted",
    docs: "https://github.com/github/github-mcp-server",
    mark: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    tint: "#181717",
  },
  {
    id: "cat-workspace",
    name: "Google Workspace",
    what: "Read Gmail, Calendar and Drive",
    needs: "Runs beside the engine, with Google credentials it owns",
    endpoint: "http://127.0.0.1:8935/mcp",
    transport: "http",
    authKind: "none",
    where: "local",
    docs: "https://github.com/taylorwilsdon/google_workspace_mcp",
    mark: "M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73L.076 15.67l1.869 3.25 1.877 3.24 3.62-6.28 3.61-6.28-1.87-3.24zm1.884 12.7L5.516 22.16h14.968l1.869-3.245H9.134z",
    tint: "#1FA463",
  },
  {
    id: "cat-filesystem",
    name: "Filesystem",
    what: "Read and write files in a directory you choose",
    needs: "Runs beside the engine — start it yourself, then point this at it",
    endpoint: "http://127.0.0.1:8931/mcp",
    transport: "http",
    authKind: "none",
    where: "local",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    mark: "M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z",
    tint: "#8A8A94",
  },
  {
    id: "cat-git",
    name: "Git",
    what: "Read a repository's history, branches and diffs",
    needs: "Runs beside the engine, with the repository mounted",
    endpoint: "http://127.0.0.1:8932/mcp",
    transport: "http",
    authKind: "none",
    where: "local",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    mark: "M23.546 10.93 13.067.452a1.55 1.55 0 0 0-2.188 0L8.708 2.627l2.76 2.76a1.838 1.838 0 0 1 2.327 2.341l2.658 2.66a1.838 1.838 0 0 1 1.9 3.039 1.837 1.837 0 0 1-2.6 0 1.846 1.846 0 0 1-.404-1.996L12.86 8.955v6.525a1.84 1.84 0 1 1-1.512-.052V8.882a1.838 1.838 0 0 1-.998-2.411L7.63 3.75 .452 10.93a1.55 1.55 0 0 0 0 2.188l10.48 10.477a1.55 1.55 0 0 0 2.187 0l10.427-10.427a1.55 1.55 0 0 0 0-2.239",
    tint: "#F05032",
  },
  {
    id: "cat-fetch",
    name: "Fetch",
    what: "Fetch a web page and read it as text",
    needs: "Runs beside the engine",
    endpoint: "http://127.0.0.1:8933/mcp",
    transport: "http",
    authKind: "none",
    where: "local",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    mark: "M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2c1.68 0 3.24 1.98 4.02 5H7.98C8.76 3.98 10.32 2 12 2zM7.4 9h9.2c.26 .95 .4 1.95 .4 3s-.14 2.05-.4 3H7.4c-.26-.95-.4-1.95-.4-3s.14-2.05 .4-3zm-2.06 0c-.22.96-.34 1.96-.34 3s.12 2.04 .34 3H2.46A9.96 9.96 0 0 1 2 12c0-1.06.16-2.07.46-3h2.88zm13.32 0h2.88c.3 .93 .46 1.94 .46 3s-.16 2.07-.46 3h-2.88c.22-.96.34-1.96.34-3s-.12-2.04-.34-3zM3.34 7A10.03 10.03 0 0 1 8.1 2.62C7.3 3.75 6.66 5.25 6.26 7H3.34zm14.4 0c-.4-1.75-1.04-3.25-1.84-4.38A10.03 10.03 0 0 1 20.66 7h-2.92zM6.26 17c.4 1.75 1.04 3.25 1.84 4.38A10.03 10.03 0 0 1 3.34 17h2.92zm11.48 0h2.92a10.03 10.03 0 0 1-4.76 4.38c.8-1.13 1.44-2.63 1.84-4.38zM7.98 17h8.04c-.78 3.02-2.34 5-4.02 5s-3.24-1.98-4.02-5z",
    tint: "#5B8DEF",
  },
  {
    id: "cat-postgres",
    name: "PostgreSQL",
    what: "Query a database read-only and describe its schema",
    needs: "Runs beside the engine, with a connection string it owns",
    endpoint: "http://127.0.0.1:8934/mcp",
    transport: "http",
    authKind: "none",
    where: "local",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    mark: "M17.128 0a10.134 10.134 0 0 0-2.755.403l-.063.02A10.922 10.922 0 0 0 12.6.258C11.422.238 10.41.524 9.594 1 8.79.721 7.122.24 5.364.336 4.14.403 2.804.775 1.814 1.82.827 2.865.305 4.482.415 6.682c.03.607.203 1.597.49 2.879.284 1.28.646 2.62 1.007 3.85.36 1.231.628 2.336 1.174 3.15.264.406.626.815 1.15.982.526.169 1.11.05 1.579-.212.51-.284.887-.673 1.223-1.09.276.026.535.062.767.07.548.02 1.024-.078 1.585-.28.055-.02.11-.041.164-.062.06.51.121.879.244 1.259.152.472.36.895.665 1.226.31.336.72.573 1.183.673.435.094.875.055 1.276-.055.4-.11.75-.31 1.03-.594.28-.284.483-.65.6-1.08.055-.202.09-.42.11-.66.02.001.04.003.06.003.86 0 1.664-.163 2.34-.5.677-.335 1.228-.847 1.573-1.51.345-.66.478-1.44.365-2.31-.113-.87-.47-1.79-1.093-2.7.17-.79.24-1.6.24-2.4 0-1.5-.24-2.9-.72-4.05C21.36 1.9 20.55.9 19.5.4A5.29 5.29 0 0 0 17.128 0z",
    tint: "#336791",
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

/** What a card knows about the connector behind it, filled in by the page. */
export type EntryStatus = {
  /** The server row's id, when one exists for this endpoint. */
  serverId: string;
  /** "none" | "live" | "expiring" | "stale", as the engine reports it. */
  state: string;
};

/** One brand mark, drawn at the size the card gives it. */
export function brandMark(entry: CatalogueEntry): SVGTemplateResult {
  return svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    ><path d=${entry.mark} fill="currentColor"></path></svg>`;
}

@customElement("mcp-gallery")
export class McpGallery extends LitElement {
  static styles = css`
    *, *::before, *::after { box-sizing: border-box; }
    :host { display: block; }
    .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(264px, 1fr)); }
    .card { display: flex; flex-direction: column; gap: 6px; padding: 14px;
            border: 1px solid var(--border); border-radius: 12px;
            background: var(--bg-card); }
    .top { display: flex; align-items: center; gap: 10px; }
    /* The mark sits in a tinted well rather than loose on the card. A row of
       logos at their own colours and their own visual weights reads as a
       jumble; a constant well gives every one of them the same footprint,
       which is what makes the shelf scannable. */
    .logo { width: 30px; height: 30px; border-radius: 8px; flex: none;
            display: grid; place-items: center;
            background: color-mix(in srgb, currentColor 12%, transparent); }
    .logo svg { width: 17px; height: 17px; display: block; }
    /* A near-black brand mark disappears on a dark ground, so the well and the
       glyph both follow one colour that the theme is allowed to override. */
    @media (prefers-color-scheme: dark) {
      .logo { background: color-mix(in srgb, currentColor 22%, transparent); }
    }
    .name { font-size: 14px; font-weight: 600; color: var(--fg); }
    .what { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
    /* The requirement reads as a caveat, not as body copy: it is the one line
       that decides whether connecting will work for you. */
    .needs { font-size: 12px; color: var(--faint); line-height: 1.4; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 6px; }
    button { font: inherit; font-size: 13px; padding: 6px 14px; cursor: pointer;
             border: 1px solid var(--border); border-radius: 999px;
             background: var(--bg-card); color: var(--fg); }
    button:hover:not([disabled]) { background: var(--bg-user); border-color: var(--muted); }
    button[disabled] { opacity: .55; cursor: default; }
    /* Connect is the one action on this page worth pointing at. */
    button.go { background: var(--brand); border-color: var(--brand); color: var(--accent-fg); }
    button.go:hover:not([disabled]) { filter: brightness(1.06); background: var(--brand); }
    .docs { font-size: 12.5px; color: var(--muted); text-decoration: none; }
    .docs:hover { color: var(--fg); text-decoration: underline; }
    .have { display: inline-flex; align-items: center; gap: 5px;
            font-size: 12.5px; color: var(--ok); }
    .have nr-icon { color: var(--ok); }
    .stale { font-size: 12.5px; color: var(--warn, #b26a00); }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  `;

  /** The endpoints already configured, so the shelf can say which of these you
   *  have. Endpoints and not names: a person may rename a server, and the
   *  address is what actually decides whether it is the same one. */
  @property({ attribute: false }) taken: string[] = [];

  /** Connection state per endpoint, so an OAuth card can say Connect,
   *  Reconnect or Connected without the page reaching in. */
  @property({ attribute: false }) status: Map<string, EntryStatus> = new Map();

  @state() private busy = "";

  private already(e: CatalogueEntry): boolean {
    return this.taken.includes(e.endpoint);
  }

  private stateOf(e: CatalogueEntry): string {
    return this.status.get(e.endpoint)?.state ?? "none";
  }

  /** A connector you paste a token into, or run yourself: the row is created
   *  and the person finishes under MCP. */
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

  /** A connector you sign in to. The page creates the row if there is not one
   *  yet and then opens the consent screen — one press, from a cold shelf to a
   *  working connector, which is the whole point of the OAuth path. */
  private connect(e: CatalogueEntry): void {
    this.busy = e.id;
    this.dispatchEvent(new CustomEvent("connect-entry", { detail: e }));
    setTimeout(() => { this.busy = ""; }, 2500);
  }

  private action(e: CatalogueEntry) {
    if (e.authKind === "oauth") {
      const state = this.stateOf(e);
      if (state === "live" || state === "expiring") {
        return html`<span class="have"
          ><nr-icon name="check" size="small"></nr-icon>Connected</span
        ><button @click=${() => this.connect(e)} ?disabled=${this.busy === e.id}>Reconnect</button>`;
      }
      // "stale" is a connection that expired with no way back but a person,
      // which is a different sentence from never having connected at all.
      return html`
        ${state === "stale" ? html`<span class="stale">Expired</span>` : nothing}
        <button class="go" ?disabled=${this.busy === e.id}
          @click=${() => this.connect(e)}
        >${this.busy === e.id ? "Opening…" : state === "stale" ? "Reconnect" : "Connect"}</button>`;
    }
    if (this.already(e)) {
      return html`<span class="have"><nr-icon name="check" size="small"></nr-icon>Added</span>`;
    }
    return html`<button ?disabled=${this.busy === e.id} @click=${() => this.add(e)}>Add</button>`;
  }

  render() {
    return html`
      <div class="grid">
        ${CATALOGUE.map((e) => html`
          <div class="card">
            <div class="top" style=${`color:${e.tint}`}>
              <span class="logo">${brandMark(e)}</span>
              <span class="name">${e.name}</span>
            </div>
            <div class="what">${e.what}</div>
            ${e.needs === "" ? nothing : html`<div class="needs">${e.needs}</div>`}
            <div class="foot">
              ${this.action(e)}
              <a class="docs" href=${e.docs} target="_blank" rel="noreferrer">Docs</a>
            </div>
          </div>`)}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { "mcp-gallery": McpGallery }
}

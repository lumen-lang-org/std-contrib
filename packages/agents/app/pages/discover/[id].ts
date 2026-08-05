// One Discover story, at its own address.
//
// The feed and an article are two views inside the console, not two apps —
// moving between them must not throw away the shell, the sidebar, the socket
// and the identity and rebuild them, which is what a navigation does. But a
// story is the single most linkable thing on this site: it is what somebody
// sends a colleague, what a search engine indexes, and what a conversation
// started from an article should still be reachable beside a week later.
//
// So both have URLs and neither is a separate page. `/discover` opens the
// feed, `/discover/<id>` opens that story, and a click between the two pushes
// rather than navigates (`openArticle` / `closeArticle` in src/console.ts).
// This route exists for the cold arrival: a pasted link, a reload, a crawler.
//
// The feed itself is index.ts beside this — two files rather than one
// optional-parameter route, because the optional form left the client router
// with no `/discover` at all. The note in index.ts has the detail.
//
// No loader beyond the console's own. The feed and the article are public
// reads the elements make when they boot, and seeding them here would be a
// second place that knows what Discover needs.

import { LitElement, html } from "lit";
import { callerHeaders, engineBase } from "../_view.js";

// The socket handler, re-exported for the reason index.ts does it: the
// framework finds a page's handler by reading the module for this export.
export { socket } from "../../server/sockets.js";

// The console, client-side. The guard and the awaited half in `loader` are
// the pattern every page here follows; pages/index.ts sets out why at length.
if (!import.meta.env.SSR) {
  void import("../../src/console.js");
}

/* One article, read on the server. Same bargain as the feed's loader beside
 * it: a link to a story should arrive as the story, not as "Opening…". */
type Seeded = { article: unknown };
type LoaderArgs = {
  params: { id?: string };
  headers?: Record<string, unknown>;
  user?: { sub?: string; uuid?: string; email?: string; roles?: string[] } | null;
};

export async function loader({ params, headers, user }: LoaderArgs): Promise<Seeded> {
  if (import.meta.env.PROD) { await import("../../src/console.js"); }
  const id = params?.id ?? "";
  if (id === "") { return { article: null }; }
  try {
    const answer = await fetch(
      `${engineBase()}/discover/story/${encodeURIComponent(id)}`,
      { headers: { accept: "application/json", ...callerHeaders(headers, user) } });
    // A 404 is ORDINARY here — a refresh replaces a feed's rows, so an address
    // outlives what it points at by design. The element says so properly.
    if (!answer.ok) { return { article: null }; }
    return { article: (await answer.json()) as unknown };
  } catch (e) {
    console.warn("[article loader]", String(e).slice(0, 200));
    return { article: null };
  }
}


// A NAMED export, not `export default`, and that is load-bearing rather than
// style. The client router registers a page from its named class export; a
// default-exported one server-renders correctly and then hydrates to nothing
// — 200, real markup, and a blank screen or the router's own 404 the moment
// the bundle runs. `pages/index.ts`, `pages/stats.ts` and `pages/c/[id].ts`
// are all named and all work cold; `pages/settings/[[tab]].ts` was default
// and had been answering 404 to a pasted /settings link for as long as it
// existed, unnoticed because Settings is normally opened by pushState from
// inside the console and never loaded cold.
/* The path segment, decoded once.
 *
 *  The router hands the param exactly as it appears in the address, and a
 *  story id carries a colon — so /discover/biz-en%3A38aa5640 arrives as
 *  "biz-en%3A38aa5640". `readArticle` then encodes what it is given, the
 *  engine is asked for "biz-en%253A38aa5640", and answers 404. The feed's own
 *  links worked because they pass the decoded id as a property and never go
 *  through the address at all — which is why this only ever broke for someone
 *  opening a link.
 *
 *  Guarded: decodeURIComponent throws on a stray "%", and an id that cannot be
 *  decoded is better sent as-is than turned into an exception during render. */
function decodedId(raw: string | undefined): string {
  const said = (raw ?? "").trim();
  try { return decodeURIComponent(said); } catch { return said; }
}

export class PageDiscoverArticle extends LitElement {
  static properties = { id: { type: String }, loaderData: { type: Object } };
  declare id: string | undefined;
  loaderData: { article?: unknown } = {};

  /* NO `createRenderRoot`, and that omission is the whole fix.
   *
   * Overriding it to return `this` — rendering the console into the light DOM
   * — is the obvious thing and it produces TWO consoles. @lit-labs/ssr renders
   * every LitElement into a declarative shadow root whatever this method says,
   * so the server's <agent-console> arrives inside <template shadowrootmode>,
   * the browser adopts it, and Lit then renders a SECOND one beside the host.
   * The adopted one is hidden; the visible one never receives this route's
   * properties.
   *
   * That is exactly what broke Discover on production. The hidden console had
   * `view === "article"` and `openArticleAt` set, and measured 0x0; the
   * visible one had neither and drew the chat home. Every probe that asked
   * `document.querySelector("agent-console")` got the hidden one and reported
   * that everything was fine, which is why reverting the composer did not
   * help — the composer was never the problem.
   *
   * `pages/index.ts` carries this reasoning in full and keeps its shadow root
   * for it. `pages/settings/[[tab]].ts` does NOT, which is why a cold
   * /settings link has always shown a blank screen.
   *
   * The height chain comes from head.html, so nothing is lost by keeping the
   * shadow root. What it costs is that the console is not a document-level
   * node — nothing in src/ may assume it is, and the e2e helpers already
   * cross shadow roots to find it.
   */
  render() {
    return html`<agent-console .startView=${"article"}
      .openArticleAt=${decodedId(this.id)}
      .seedArticle=${this.loaderData?.article ?? null}></agent-console>`;
  }
}

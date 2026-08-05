// Discover, at its own address.
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
// TWO FILES and not one optional-parameter route, which is what this was
// first written as. `pages/discover/[[id]].ts` server-rendered `/discover`
// correctly and the CLIENT router still answered its own 404 for it: the
// optional form registers the parameterised path and not the bare one. The
// page arrived, the console booted inside it, and the router replaced the
// lot with "/discover doesn't exist". Caught by driving the deployed page
// rather than by reading its status code, which was 200 throughout.
//
// So the feed is this file and the article is [id].ts beside it.
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

/* The feeds, read on the SERVER so the first paint has news on it.
 *
 * Discover is the page a link lands on and the page a crawler reads, and both
 * used to get an empty column while the browser asked for what the server was
 * already able to fetch. The route is public — `GUEST_GETS` holds
 * `/api/discover` — so this needs no credential; the caller's own identity is
 * forwarded anyway, because a route that quietly reads as somebody else is a
 * habit worth not having.
 *
 * Failure returns nothing rather than an error page. The element asks again
 * on its own and says it better; an empty seed simply means the first paint
 * is the one it used to be. */
type Seeded = { feeds: unknown[] };
type LoaderArgs = {
  headers?: Record<string, unknown>;
  user?: { sub?: string; uuid?: string; email?: string; roles?: string[] } | null;
};

export async function loader({ headers, user }: LoaderArgs): Promise<Seeded> {
  if (import.meta.env.PROD) { await import("../../src/console.js"); }
  try {
    const answer = await fetch(`${engineBase()}/discover`, {
      headers: { accept: "application/json", ...callerHeaders(headers, user) },
    });
    if (!answer.ok) { return { feeds: [] }; }
    return { feeds: (await answer.json()) as unknown[] };
  } catch (e) {
    // Logged, never swallowed: a bare catch here turns a typo in this function
    // into an empty feed, which from outside is indistinguishable from "this
    // route does not server-render".
    console.warn("[discover loader]", String(e).slice(0, 200));
    return { feeds: [] };
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
export class PageDiscover extends LitElement {
  static properties = { loaderData: { type: Object } };
  /** Initialised rather than declared: an undefined property at first render
   *  is what a server render sees. */
  loaderData: { feeds?: unknown[] } = {};


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
    return html`<agent-console .startView=${"discover"}
      .seedFeeds=${this.loaderData?.feeds ?? null}></agent-console>`;
  }
}

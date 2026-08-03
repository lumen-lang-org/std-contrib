// Deployment settings, at their own address.
//
// They used to be an overlay over whatever conversation you happened to have
// open, and most of what is in them has nothing to do with a conversation:
// tracing endpoints, provider credentials, model rows, script images. Those
// are how the deployment is wired, not what a person is doing — and an
// overlay says the opposite, that this is a detour from the real screen.
//
// So: a route. What it buys, in order of how often it will matter — a URL per
// tab, so a link to Providers is a link to Providers; the browser's back
// button between tabs instead of a close button back to a conversation; and
// the full width, which the tables in Models and Model menu have wanted since
// they were written.
//
// The element is the SAME element. `console-settings` grows a `page` property
// that swaps the frame — no overlay, no fixed layer, a bounded content column
// — and nothing else about it changes. A second settings implementation for
// the page would be two things to keep in step, and the one that got edited
// would be whichever the reader happened to open.

import { LitElement, html } from "lit";

// Same guard, same reason as pages/index.ts and pages/c/[id].ts: a static
// import drags the console's whole module graph through Vite's SSR runner on
// every render of this route. The production half is in the loader, where the
// await is guaranteed to precede the render.
if (!import.meta.env.SSR) {
  void import("../../src/admin-page.js");
}

// Which tab the URL names. The path carries the tab's own name lowercased
// with its spaces hyphenated ("model-menu"), because a URL a person can guess
// is worth more than an index they cannot.
// Admin-zone tabs only. The user zone lives in the console's overlay; a slug
// for one of its tabs is simply unknown here and falls to Models below.
const TAB_OF: Record<string, string> = {
  "models": "Models",
  "model-menu": "Model menu",
  "providers": "Providers",
  "images": "Images",
  "mcp": "MCP",
  "sign-in": "Sign-in",
  "tracing": "Tracing",
  "search": "Search",
};

type LoaderArgs = { params: { tab?: string } };
type Opened = { tab: string };

export async function loader({ params }: LoaderArgs): Promise<Opened> {
  if (import.meta.env.PROD) { await import("../../src/admin-page.js"); }
  // An unknown slug opens Models rather than answering 404: the tab is a view
  // of one page, and a stale bookmark to a tab that was renamed should land
  // somewhere usable rather than on an error.
  return { tab: TAB_OF[(params?.tab ?? "").toLowerCase()] ?? "Models" };
}

export class PageAdminTab extends LitElement {
  // `tab` is an ATTRIBUTE — createPageElement does setAttribute for every
  // route param, so a params object never reaches the client — and
  // `loaderData` is the property set on the same element right after. Both,
  // because the loader's mapping from slug to tab name is the one the render
  // wants and the raw slug is what survives a client-side navigation.
  static properties = { tab: { type: String }, loaderData: { type: Object } };
  declare tab: string | undefined;
  loaderData: { tab?: string } = {};

  // No shadow styles: this page is a frame around one element that fills it.
  // The height comes from the chain in head.html, which every route shares.
  render() {
    const named = this.loaderData?.tab
      ?? TAB_OF[(this.tab ?? "").toLowerCase()]
      ?? "Models";
    return html`<admin-page .tab=${named}></admin-page>`;
  }
}

// No customElements.define: LumenJS defines a page's exported class when it
// mounts the route, and doing it twice throws NotSupportedError during module
// load — the page then does not render at all.
export default PageAdminTab;

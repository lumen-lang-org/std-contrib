// Tasks, at their own address.
//
// The same shape every other route here has: the page IS the console, and
// what differs is only what it opens with. The console reads `/tasks` out of
// the address on the way up, so this module hands it nothing — the route
// exists so that the address is real. A panel worth linking to is worth a URL,
// and a task is the most linkable thing in the product: it is the one screen
// somebody wants to send to themselves.

import { LitElement, html } from "lit";

// The socket handler, re-exported for the reason index.ts does it: the
// framework finds a page's handler by reading the module for this export.
export { socket } from "../server/sockets.js";

// The console, client-side. The guard and the awaited half in `loader` are the
// pattern every page here follows; pages/index.ts sets out why at length.
if (!import.meta.env.SSR) {
  void import("../src/console.js");
}

export async function loader(): Promise<Record<string, never>> {
  if (import.meta.env.PROD) { await import("../src/console.js"); }
  return {};
}

// A NAMED export, not `export default`, and that is load-bearing rather than
// style — the reason is written out in pages/discover/index.ts. The client
// router registers a page from its named class export; a default-exported one
// server-renders correctly and then hydrates to nothing. This page was written
// `export default` first and did exactly that: /tasks answered 200 with real
// markup, `console-tasks` was defined in the browser, and the screen was
// blank, because the router never mounted the route that would have rendered
// the console.
export class PageTasks extends LitElement {
  // No shadow root: the console sizes itself against the page's own height
  // chain (head.html), and a shadow root here would put a box between them.
  createRenderRoot() { return this; }

  render() {
    return html`<agent-console></agent-console>`;
  }
}

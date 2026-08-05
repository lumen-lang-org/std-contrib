// Starting points, at its own address.
//
// A standalone screen of the console, and every standalone screen needs a URL:
// without one it cannot be linked, reloaded, bookmarked, or reached by Back —
// and /starts answered the chat home, which reads as the page having lost its
// data rather than as the page not existing.
//
// The reasoning every route file here shares — why the shadow root stays, why
// the class export is named, and why the screen arrives as a property rather
// than as a `location.pathname` read inside the console — is in pages/_view.ts.
// The short version of the last one: `connectedCallback` never runs on the
// server, so a view chosen there is a view the first paint does not have.

import { LitElement, html } from "lit";

export { socket } from "../server/sockets.js";

if (!import.meta.env.SSR) {
  void import("../src/console.js");
}

export async function loader(): Promise<Record<string, never>> {
  if (import.meta.env.PROD) { await import("../src/console.js"); }
  return {};
}

export class PageStarts extends LitElement {
  render() {
    return html`<agent-console .startView=${"starts"}></agent-console>`;
  }
}

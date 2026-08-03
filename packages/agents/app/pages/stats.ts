// The index, in public.
//
// Same component the admin tab draws, with `mode="public"` — which is the
// whole difference in the browser, and none of the difference that matters.
// What a visitor may actually ask for is decided in server/search-proxy.ts:
// `/stats` and `/analytics` answer to anybody, the query endpoints do not.
// This page could set mode="admin" and the screen would still refuse to
// return a search result to a visitor.
//
// It exists because the numbers are the argument. "A markdown-first web index"
// is a sentence; two thousand documents across two hundred and forty domains,
// growing while you watch it, is the thing itself.

import { LitElement, css, html } from "lit";

// The guard and the loader are the pattern every page here follows, and the
// reasoning is written out at length in pages/index.ts: a static import drags
// the browser module graph through the SSR runner on every render, and a
// production server needs the definition awaited before it renders or the
// element arrives empty. Both halves, same as the console's own route.
if (!import.meta.env.SSR) {
  void import("../src/search-dash.js");
}

export async function loader(): Promise<Record<string, never>> {
  if (import.meta.env.PROD) { await import("../src/search-dash.js"); }
  return {};
}

export class PageStats extends LitElement {
  // Unlike the console's route this one is worth server-rendering: it is a
  // page a link points at, and the element draws its own loading state.
  render() {
    return html`
      <main class="page">
        <search-dash mode="public"></search-dash>
      </main>`;
  }

  // A reading page, so it takes a column rather than the full bleed the
  // console does. The padding is the settings page's, which is the only other
  // bounded content column in this app.
  // lit's css tag, not a hand-built CSSStyleSheet: this module is evaluated on
  // the server as well, where constructing one is not a thing to rely on.
  static styles = css`
    :host { display: block; height: 100%; overflow-y: auto; background: var(--bg); }
    .page { max-width: 1180px; margin: 0 auto; padding: 30px 26px 60px; }
    @media (max-width: 720px) { .page { padding: 20px 14px 40px; } }
  `;
}

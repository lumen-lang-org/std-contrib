// The console, as a route. This is index.html's <body> and src/main.ts in one
// file: it draws <agent-console>, and it loads the element that fills it.
//
// It has no styles. The height chain is one rule in head.html, and
// <agent-console> sizes itself from its own `:host` in src/console.ts.

import { LitElement, html, nothing } from "lit";
import { deliver, setEmit } from "../src/live.js";

// The live feed's server half. LumenJS finds a page's socket handler by this
// export — `fileHasSocket` reads the source for it, and the Socket.IO plugin
// loads this module in Node and calls `mod.socket`. Re-exported rather than
// written here because it is server code and belongs beside the proxy it
// shares an engine address with; server/sockets.ts is written to survive
// being bundled for the browser, which this re-export makes it.
export { socket } from "../server/sockets.js";

// The whole console, unmodified — src/ moved across untouched during the port
// rather than being rewritten, which is why the Kimi design came through
// pixel-identical. It pulls in ui.ts, the LumenUI bundle set, on the way, in
// the order ui.ts's comment block insists on.
//
// Imported dynamically and behind a guard, which is not a style choice. A
// page module in LumenJS is evaluated on the server too — for SSR, and, less
// obviously, by the Socket.IO plugin, which loads the page file to find a
// `socket()` export. A static import here drags the entire browser UI into
// Node, where the LumenUI bundle chain reaches a CommonJS `module` reference
// and throws.
//
// The guard is `import.meta.env.SSR`, not `typeof window`. @lit-labs/ssr
// installs a DOM shim before rendering, so `window` IS defined on the server
// and a window check lets the import through — where highlight.js (reached
// via the LumenUI canvas bundle) hits `module is not defined` inside Vite's
// SSR module runner, in the middle of rendering the page.
//
// The guard keeps that out of the render. It does not keep the module out of
// the server entirely, and the log says so: LumenJS walks a page's
// `ssrImportedModules` hunting for component loaders, Vite lists dynamic
// imports there too, and so `src/console.ts` is evaluated in Node exactly
// once per server start and throws that same error into that walk's try/catch.
// It is swallowed, the page renders, and nothing downstream notices — see
// finding 3 in MIGRATION-LUMENJS.md. Do not read the line in the dev log as
// evidence this guard is doing nothing; without it the throw lands in the
// render path instead of beside it.
//
// The import is `console.js` directly. src/main.ts was the Vite entry and held
// exactly this one line; phase 5 deleted it rather than keep a second door
// into the same module.
// Guarded, and the reason is measured, not defensive. A static import here
// drags the console's whole module graph — LumenUI, lit, the markdown
// renderer — through Vite's SSR runner on every render of this route: 1.4s to
// first byte, against 0.2s for /c/<id>, which guards the same import and
// server-renders MORE (20 hydration markers to this route's 18).
//
// Nothing is lost by not loading it here. The components a page renders are
// registered through the layout, and @lit-labs/ssr renders the custom element
// tags either way; what the guard removes is Node evaluating a browser
// application to produce markup it does not need.
if (!import.meta.env.SSR) {
  void import("../src/console.js");
}

export class PageIndex extends LitElement {
  // This page keeps its shadow root, and the reason is worth writing down
  // because the obvious change is wrong.
  //
  // Under Vite <agent-console> was a child of <body>, so
  // `document.querySelector("agent-console")` found it; here it is a child of
  // this element's shadow root, where that selector cannot reach. The tempting
  // answer is `createRenderRoot() { return this }` — render into the light DOM
  // and put the console back in the document tree. It produces TWO consoles.
  // @lit-labs/ssr renders every LitElement into a declarative shadow root
  // regardless of `createRenderRoot`, so the server's <agent-console> arrives
  // inside `<template shadowrootmode>`, the browser adopts it, and then Lit
  // renders a second one beside the host. The first is the one that is hidden;
  // both answer `document.querySelector`.
  //
  // So nothing outside may assume the console is a document-level node. The
  // e2e helpers read it through a Playwright locator, which crosses open
  // shadow roots; `src/` never looks for it at all.
  //
  // The two seams LumenJS's router offers a socket page, forwarded to
  // src/live.ts. The router assigns straight onto this element — `el.live =
  // payload` for each key the server pushed, `el.emit = fn` for the way back
  // — so these are plain accessors rather than reactive properties: nothing
  // here renders from them, and declaring them reactive would ask Lit to
  // schedule an update for every heartbeat.
  //
  // The names are the contract. `live` is the single property server/sockets.ts
  // pushes under, so one setter catches every kind of payload; `emit` is what
  // the router calls its injected sender. A browser that never got a socket
  // is handed neither, which is exactly how the console falls back.
  set live(payload: unknown) { deliver(payload); }
  get live(): unknown { return null; }

  #emit: ((event: string, payload?: unknown) => void) | null = null;
  set emit(fn: ((event: string, payload?: unknown) => void) | null) {
    this.#emit = fn;
    setEmit(fn);
  }
  get emit(): ((event: string, payload?: unknown) => void) | null { return this.#emit; }

  // The console is drawn in the browser and nowhere else.
  //
  // The server has nothing to say about it: `src/console.js` is imported behind
  // the SSR guard above, so `agent-console` is not even defined in Node, and
  // what SSR would emit is an empty `<agent-console></agent-console>` sitting
  // in a declarative shadow root. That empty element is not free. The browser
  // adopts the shadow root, `page-index` upgrades and Lit renders its own
  // `<agent-console>` into the same root — and whether the adopted one is
  // cleared first is a race with the custom-element upgrade. When it loses, the
  // page ends up with TWO consoles, both of which upgrade, both of which draw a
  // full shell and start their own pollers. It shows up as
  // `locator('agent-console').locator('nr-chatbot') resolved to 2 elements`,
  // intermittently, in whichever spec happened to look first.
  //
  // Until this SSR-worked-once-per-server bug was fixed in the framework, every
  // render after the first failed and fell back to CSR, so nothing was ever
  // emitted here and the race could not happen. Fixing the framework is right;
  // pretending this page has server-side markup worth sending is not. Returning
  // nothing on the server keeps the whole shell client-rendered — which is what
  // it was written, measured and screenshot-compared as — and leaves SSR
  // working for pages that actually have something to render.
  render() {
    return html`<agent-console></agent-console>`;
  }
}

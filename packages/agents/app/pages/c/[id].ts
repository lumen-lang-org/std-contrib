// One conversation, at its own address.
//
// The page is the console — the same element, the same shell, the same
// everything. What differs is that the id is in the path rather than in a
// query, so a link says what it points at and the browser's history is a list
// of conversations rather than a list of visits to `/`.
//
// It renders `<agent-console>` exactly as `pages/index.ts` does and hands it
// the id; the console does the rest, because opening a conversation was
// already a thing it knew how to do.
//
// There is no loader, and the reason is worth writing down because adding one
// looks trivial and is not.
//
// Fetching the transcript server-side is easy — identity is on the request now
// (pages/_middleware.ts), so the engine would answer as the caller. Handing it
// to the console is the hard half: `ChatSession.open` does not merely display
// turns, it joins each round's step rows and reasoning onto the answer that
// follows them, and that transformation lives inside the session. Seeding the
// first paint means running it on the server, not passing raw turns to a
// property — a half-copy of that join would drift from the real one and show a
// conversation claiming work it does not display.
//
// So the shell is server-rendered and the conversation arrives a beat later.
// Closing that gap is a refactor of the session, not a loader.

import { LitElement, html } from "lit";
import { deliver, setEmit } from "../../src/live.js";

// The socket handler, re-exported for the same reason index.ts does it: the
// framework finds a page's handler by reading the module for this export, and
// it belongs beside the proxy it shares an engine address with.
export { socket } from "../../server/sockets.js";

// The console: always in the browser, and on the server only in a production
// build. Three cases, and the middle one is the whole reason this is not a
// plain import.
//
// In the BROWSER it is loaded and not awaited — the page is already painted
// from server markup and this is what gives it behaviour.
//
// On a DEV SERVER it is deliberately absent. A static import here makes Vite
// pull the console's entire module graph — LumenUI, lit, the markdown
// renderer — through its SSR runner on every single render: measured at 2.0s
// to first byte against 0.33s with this guard. That is a dev-server cost and
// nothing else; the transform is on-demand and uncached.
//
// On a PRODUCTION SERVER it is imported, and awaited, because that is what
// server-renders the console at all. Without it @lit-labs/ssr has no
// definitions to render and the route answers a 9KB shell with two shadow
// roots and no transcript — a client-rendered SPA wearing SSR's clothes.
// With it: 24 shadow roots, 190KB of real DOM, the same bytes dev produces,
// for 45ms of TTFB. The server bundle is pre-built, so none of the dev cost
// above applies.
//
// The production-server half is NOT here — it is the first line of `loader`
// below, and it has to be. Rendering must not begin before the custom
// elements are defined, so the import has to be awaited; a top-level `await`
// fails the build ("Top-level await is not available in the configured target
// environment"), and an un-awaited `import()` races the render and answers
// the empty shell on the first request of a cold process. `loader` is already
// async and already awaited by the framework before it renders, which makes
// it the one place that ordering is guaranteed.
//
// Historical note, because the comment this replaces said otherwise: the
// guard was once unconditional to keep highlight.js and codejar out of Node,
// where they reach `module is not defined` and `const globalWindow = window`.
// That is now handled at the source, inside src/ui.ts, which guards
// `code-editor` and `canvas` individually. Verified by building with this
// import unguarded — it renders in Node with no error.
if (!import.meta.env.SSR) {
  import("../../src/console.js");
}

/** The conversation, fetched on the server as the person asking for it.
 *
 *  Identity is on the request (pages/_middleware.ts), and the engine scopes a
 *  conversation to its owner — so this forwards the caller's own X-USER and
 *  nothing else. Without it the engine answers 404, which is the correct
 *  answer to "someone else's conversation" and the reason this cannot be a
 *  server-side fetch with server credentials.
 *
 *  Both halves are read, because the console needs both: the turns, and the
 *  step rows and reasoning that belong to each round. `ChatSession.apply`
 *  joins them — the same function `open` uses, so there is one copy of that
 *  logic and the first paint cannot disagree with the reload.
 *
 *  Failure returns nothing rather than an error page: a bad id, a
 *  conversation that is not yours, an engine restarting — in every case the
 *  client asks too and says it better. */

/** What the page is handed. Named rather than written inline at the signature,
 *  and that is not only taste: LumenJS strips this function out of the client
 *  bundle by text, and its strip started counting braces at the first `{` after
 *  the parameter list — which, with the shape written inline, was the one
 *  inside `Promise<{ … }>`. It closed the *type*, left the body behind as an
 *  orphaned block, and `npx lumenjs build` failed with `Unexpected "}"`
 *  pointing at the line that closes this function. Only the build: the dev
 *  server takes another path, so the page worked all the way up to the image.
 *  Fixed upstream in `dev-server/plugins/vite-plugin-loaders.ts`; a name here
 *  is what lets the vendored build in `vendor/` cope until that ships. */
type Past = { steps: unknown[]; thoughts: unknown[] };
type Preloaded = { id: string; turns: unknown[]; past: Past };
// The framework hands a loader `{ params, query, url, headers, locale, user }`
// — never a `request` (dev-server/ssr-render.ts). Asking for one gave
// `undefined` on every call, so the identity was always empty and the engine
// answered nothing; the loader then swallowed its own ReferenceError and
// returned an empty conversation, which read from outside exactly like "SSR
// does not work here".
type LoaderArgs = {
  params: { id?: string };
  headers?: Record<string, unknown>;
  user?: { sub?: string; uuid?: string; email?: string; roles?: string[] } | null;
};

export async function loader({ params, headers, user }: LoaderArgs): Promise<Preloaded> {
  // Define the console's custom elements before anything renders. See the note
  // above the browser-side import at the top of this file: this is the only
  // point where "loaded" is guaranteed to precede "rendered", and without it
  // @lit-labs/ssr has no definitions and answers a 9KB shell with no
  // transcript — SSR in name only.
  //
  // Production only, and the condition is a compile-time constant so the dev
  // bundle keeps none of this. On a dev server the same import costs 2.0s of
  // TTFB against 0.33s without, because Vite transforms the whole graph per
  // render; in a pre-built server bundle it costs 45ms once, then nothing —
  // `import()` caches, so every later request is a resolved promise.
  if (import.meta.env.PROD) { await import("../../src/console.js"); }
  const id = params?.id ?? "";
  const empty = { id, turns: [], past: { steps: [], thoughts: [] } };
  if (id === "") { return empty; }
  const engine = (process.env.AGENTS_API ?? "http://127.0.0.1:8100").replace(/\/$/, "");
  // The header when something upstream stamped it; otherwise the parsed user
  // the middleware put on the request, rebuilt into the document the engine
  // reads.
  const raw = headers?.["x-user"];
  const stamped = Array.isArray(raw) ? String(raw[0]) : (raw === undefined ? "" : String(raw));
  const xUser = stamped !== "" ? stamped
    : (user ? JSON.stringify({
        uuid: user.uuid ?? user.sub ?? "",
        username: user.email ?? "",
        email: user.email ?? "",
        roles: Array.isArray(user.roles) ? user.roles : [],
      }) : "");
  const headersOut = xUser === "" ? {} : { "X-USER": xUser };
  const key = encodeURIComponent(id);
  try {
    const [t, p] = await Promise.all([
      fetch(`${engine}/threads/${key}`, { headers: headersOut }),
      fetch(`${engine}/threads/${key}/steps?seq=all`, { headers: headersOut }),
    ]);
    if (!t.ok) { return empty; }
    return {
      id,
      turns: (await t.json()) as unknown[],
      past: p.ok ? (await p.json()) as Past : { steps: [], thoughts: [] },
    };
  } catch (e) {
    // Logged, never swallowed. A bare `catch { return empty }` here turned a
    // ReferenceError in this function into an empty conversation, which from
    // outside is indistinguishable from "this route does not server-render" —
    // and cost most of an evening chasing the framework instead of the typo.
    console.warn("[conversation loader]", String(e).slice(0, 200));
    return empty;
  }
}

export class PageConversation extends LitElement {
  // The route parameter, handed in by the router.
  // `id` is an ATTRIBUTE, not a property: createPageElement does
  // `el.setAttribute(key, value)` for every route param (runtime/router.ts), so
  // a `params` object never arrives on the client. `loaderData` is a property,
  // set on the same element right after.
  static properties = { id: { type: String }, loaderData: { type: Object } };
  declare id: string | undefined;
  /** What the loader read, handed straight to the console. Initialised rather
   *  than `declare`d — social's pages do the same, and an undefined property
   *  at first render is what a server render sees. */
  loaderData: { turns?: unknown[]; past?: unknown } = {};

  // The shadow root stays, for the reason pages/index.ts spells out at length:
  // rendering into the light DOM to put <agent-console> back in the document
  // tree produces TWO consoles, both upgrading and both starting pollers. It
  // was tried here and it did exactly that.

  render() {
    const id = this.id ?? "";
    // `.conversation` rather than an attribute: an id is data for the element,
    // and the console reads it as a property when it boots.
    return html`<agent-console .conversation=${id}
      .seedTurns=${this.loaderData?.turns ?? []}
      .seedPast=${this.loaderData?.past ?? { steps: [], thoughts: [] }}></agent-console>`;
  }
}

// No customElements.define here. LumenJS defines a page's exported class
// itself when it mounts the route, and doing it twice throws
// NotSupportedError from the registry — which happens during module load, so
// the page does not render at all.
export default PageConversation;

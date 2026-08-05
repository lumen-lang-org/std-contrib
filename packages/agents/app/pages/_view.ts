// One console screen at one address, said once.
//
// The console holds several standalone screens — Discover, Tasks, Artifacts,
// Knowledge, Starting points, the graph — and every one of them used to be a
// property flip with no address. That is fine until somebody wants to send a
// link, reload, press Back, bookmark, or have a crawler read the page: all six
// need a URL, and none of them work without one.
//
// So each screen gets a route file beside this one, and each is three lines
// long because everything they share is here.
//
// WHY A `startView` PROPERTY rather than reading `location.pathname` inside
// the console: `connectedCallback` never runs on the server, so a view chosen
// there is a view the first paint does not have. The console applies this in
// `willUpdate`, which runs in both places, and the server emits the real
// screen instead of a shell that fills in a beat later.
//
// WHY EACH FILE KEEPS ITS SHADOW ROOT: `createRenderRoot() { return this }` is
// the obvious way to put <agent-console> back in the document tree and it
// produces TWO consoles — @lit-labs/ssr renders every LitElement into a
// declarative shadow root whatever that method says, the browser adopts the
// server's, and Lit renders a second beside it. The adopted one is hidden and
// holds the route's properties; the visible one has none of them. pages/
// index.ts carries the full reasoning and pages/c/[id].ts records having hit
// it too. Nothing outside may assume the console is a document-level node.
//
// WHY A NAMED CLASS EXPORT: the client router registers a page from one, and
// a default-exported route server-renders correctly and then hydrates to
// nothing.

/** The engine, as this server reaches it. */
export function engineBase(): string {
  return (process.env.AGENTS_API ?? "http://127.0.0.1:8100").replace(/\/$/, "");
}

/** The caller's identity, rebuilt for the engine the way pages/c/[id].ts does
 *  it — the stamped header when something upstream set one, otherwise the user
 *  the middleware parsed onto the request. Empty is a guest, which every
 *  public route below is happy to serve. */
export function callerHeaders(
  headers?: Record<string, unknown>,
  user?: { sub?: string; uuid?: string; email?: string; roles?: string[] } | null,
): Record<string, string> {
  const raw = headers?.["x-user"];
  const stamped = Array.isArray(raw) ? String(raw[0]) : (raw === undefined ? "" : String(raw));
  const xUser = stamped !== "" ? stamped
    : (user ? JSON.stringify({
        uuid: user.uuid ?? user.sub ?? "",
        username: user.email ?? "",
        email: user.email ?? "",
        roles: Array.isArray(user.roles) ? user.roles : [],
      }) : "");
  return xUser === "" ? {} : { "X-USER": xUser };
}

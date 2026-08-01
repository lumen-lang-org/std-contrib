// The two facts a run needs before a browser is opened: which port the console
// under test listens on, and which name the artifacts host answers to.
//
// Neither is a fact about a test, which is why they are read from the
// environment and not written in one. They live here rather than in
// playwright.config.ts because a spec needs the second of them and a spec
// importing the config to get it would make the config a module the workers
// evaluate for its side effects as well as its export.

// Which port the console under test listens on.
//
// 5173 is the console's own default and stays the default here, so the
// documented `npx playwright test` is unchanged on a machine with nothing else
// running. It is a variable because one machine already breaks that
// assumption: the host that serves lumen-agents.the-agent.dev runs a console on
// 5173 bound to the docker bridge, so the suite's `reuseExistingServer` probe
// against 127.0.0.1 finds nothing, starts a second server, and that server
// cannot bind a port the first one holds. What the operator sees is `webServer`
// timing out after sixty seconds with no mention of a port conflict in it.
//
//   AGENTS_CONSOLE_PORT=5273 npx playwright test
//
// is the answer there, and it is one value: the server's port, the base URL and
// the preview host's port all come from here and cannot drift apart.
export const PORT = process.env.AGENTS_CONSOLE_PORT ?? "5173";

// Which name the artifacts host answers to — a fact about the deployment.
//
// The engine serves an artifact as `text/html` to exactly one Host: the one in
// its own `AGENTS_PREVIEW_HOST`, compared whole, port included. Every other name
// gets inert `text/plain`. So the value here has to be the value the engine was
// started with, and this is the same variable so that it can be exactly that.
//
// Which fixes its shape, and the shape is the engine's: a host, optionally with
// a port, never a URL — the engine compares it to an inbound `Host` header.
// preview-live.spec.ts used to read it and hand it straight to `page.goto`,
// so the *correct* value, `lumen-artifacts.the-agent.dev`, was not absolute and
// resolved against the console's base URL instead. Six preview tests then
// navigated to `http://console/lumen-artifacts.the-agent.dev/preview/…`, got
// the console's own markup, and failed on an `<h1>` that was never going to be
// in it — a value read in the wrong shape wearing the costume of a broken
// preview. A scheme may be written and is kept; one is supplied when it is not.
export const PREVIEW_HOST =
  process.env.AGENTS_PREVIEW_HOST ?? `artifacts.51.91.124.105.nip.io:${PORT}`;

/** An absolute origin for a value written as a host, a host:port or a URL. */
export function originOf(value: string): string {
  return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`).origin;
}

export const PREVIEW_ORIGIN = originOf(PREVIEW_HOST);
export const PREVIEW_HOSTNAME = new URL(PREVIEW_ORIGIN).hostname;

// One header the built image sets and the dev server does not, and one frame
// it would refuse.
//
// `lumenjs serve` installs a Content-Security-Policy (shared/security-headers
// .ts) with a fixed default; `lumenjs dev` installs none. So this rule cannot
// be found by running the console the way it is developed — it appears for the
// first time in the image, which is what makes it phase 5's problem rather
// than phase 2's. The framework's default ends:
//
//     default-src 'self'; ... frame-ancestors 'none'
//
// and names no `frame-src`, so frames fall back to `default-src 'self'`. The
// artifacts panel puts `previewUrl()` in an `<iframe>` (src/artifact-panel.ts),
// and that URL is deliberately NOT this origin: an artifact is a body a model
// wrote, and it renders as itself only on a host that holds nothing worth
// stealing. Same-origin-only frames mean every artifact preview in the shipped
// image is a blank rectangle with a console error, while the identical page
// under `npm run dev` renders it.
//
// So the policy is widened by exactly one directive, and the widening obeys
// three rules:
//
//   1. **It only edits a policy that is already there.** No header, no
//      opinion — `lumenjs dev` stays byte-identical to what phases 2–4 tested,
//      and a future framework version that stops setting a CSP does not
//      acquire one from here.
//   2. **It adds `frame-src`, and nothing else.** Not `frame-ancestors`, not
//      `script-src`, not a rewrite of the default. The one thing the console
//      does that the framework's default did not anticipate is embed the
//      artifacts host.
//   3. **It names one origin.** The origin the page will actually ask for —
//      the same value `pages/_layout.ts` writes into the `agents-preview-
//      origin` meta tag, resolved the same way. A wildcard would let any
//      site the model can name be framed by the console.
//
// Where it runs: `build/serve.ts` applies the security headers *before* the
// global `lumenjs.server.js` chain, so a `setHeader` here overwrites what it
// wrote. That ordering is the reason this can be an app-level middleware at
// all rather than a patch to the framework.

import type { IncomingMessage, ServerResponse } from "node:http";

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

// One fact, written twice — the same duplication `boundTo()` in
// pages/_middleware.ts carries, and for the same reason. `pages/_layout.ts`
// resolves the preview origin for the meta tag the browser reads; this file
// resolves it for the header that decides whether the browser is allowed to
// load it. They must agree, and this module may not import that one: the
// layout is a Lit element in the client graph, and pulling it into the server
// middleware bundle would drag the whole page module in behind it.
//
// Change either and change both.
const DEFAULT_PREVIEW_ORIGIN = "https://lumen-artifacts.the-agent.dev";

function previewOrigin(): string {
  return (process.env.AGENTS_PREVIEW_ORIGIN ?? DEFAULT_PREVIEW_ORIGIN)
    .trim()
    .replace(/\/+$/, "");
}

/** Widen the framework's CSP so the artifacts host may be framed.
 *
 *  An empty `AGENTS_PREVIEW_ORIGIN` is a deployment saying it has nowhere
 *  isolated to put artifacts. `previewUrl()` then builds a same-origin link
 *  through `/api`, where the engine answers text/plain and the bytes are
 *  inert — `default-src 'self'` already allows that frame, so there is
 *  nothing to widen and nothing is written. */
export function previewFrameCsp(): Middleware {
  const origin = previewOrigin();

  return (_req, res, next) => {
    if (origin === "") return next();

    const current = res.getHeader("Content-Security-Policy");
    if (typeof current !== "string" || current === "") return next();
    // Already said — by a newer framework default, or by a second pass of this
    // middleware. Saying it twice is not additive in CSP: the *first*
    // occurrence of a directive wins and later ones are ignored, so appending
    // to a policy that already has one is at best noise.
    if (/(^|;)\s*frame-src\s/i.test(current)) return next();

    const widened = current.replace(/;\s*$/, "") + `; frame-src 'self' ${origin}`;
    res.setHeader("Content-Security-Policy", widened);
    next();
  };
}

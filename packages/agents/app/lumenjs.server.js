// Global Connect middleware, the convention LumenJS reads in both `dev` and
// `serve` (shared/user-server-middleware.ts).
//
// Three entries, and the order between them is most of what this file
// contains. `server/csp.ts` widens a response header the built server sets
// before this chain runs; `pages/_middleware.ts` decides who the caller is;
// `server/api-proxy.ts` forwards the request to the engine. Identity that is
// established after the forward is identity the engine never sees, so the
// dispatch goes ahead of the proxy — and it has to be spliced here rather than
// left to the framework's own `pages/` middleware scan, which runs this whole
// chain before it. The reasoning, and why the `auth` integration cannot be
// used instead, is at the top of server/auth-builtin.ts.
//
// `AUTH=none` contributes an empty array here, so the community console still
// reaches the proxy through exactly the code path it did before phase 4.
//
// The file has to be .js because the framework looks for that name. In dev it
// is loaded through Vite's `ssrLoadModule`, which resolves the TypeScript
// imports below. In prod `lumenjs serve` imports it with plain Node, which
// cannot — `Unknown file extension ".ts"`, warned and swallowed, leaving a
// server with no proxy and no auth that answers `/whoami` with the SPA's own
// HTML. So the image does not ship this file: the Dockerfile bundles it with
// esbuild and copies the result to this path, which is why `server/nudge.ts`
// keeps its registry on `globalThis` (two bundles, two module scopes, one
// registry).
import { previewFrameCsp, openerPolicy } from "./server/csp.ts";
import { authChain } from "./pages/_middleware.ts";
import { apiProxy } from "./server/api-proxy.ts";
import { staticAssets } from "./server/static-assets.ts";
// After the auth chain, deliberately: half of what it serves is public and
// half is an operator's, and it can only tell them apart once the chain above
// has said who is asking. See the head of the file for the split.
import { searchProxy } from "./server/search-proxy.ts";

// Assets first: /favicon.ico and /og.png carry no identity and proxy nowhere,
// so nothing earlier in the chain has anything to say about them.
export default [
  staticAssets(),
  previewFrameCsp(),
  // After the framework's security headers, so the override sticks.
  openerPolicy(),
  ...authChain,
  searchProxy(),
  apiProxy(),
];

// Who a socket is, asked from a place that cannot know.
//
// The three engine questions in server/sockets.ts are asked with the
// browser's own credentials — that is the rule phase 3 wrote down and phase 4
// does not get to bend. Under `AUTH=proxy` that is easy: the gateway put an
// `X-USER` on the handshake and the poller copies it. Under `AUTH=builtin`
// there is no such header. The browser holds a session cookie, and turning a
// cookie into an identity means AES-GCM, a secret, and a revocation lookup —
// three things a file bundled for the browser may not touch.
//
// So the socket does not do it. pages/_middleware.ts, which is server-only and
// already holds the session machinery, installs a resolver here; sockets.ts
// asks for one. In `none` and `proxy` nothing is installed and `sockets.ts`
// behaves exactly as it did before this file existed — the same handshake
// headers, copied the same way.
//
// Why this matters and is not a nicety: with `AGENTS_TRUST_PROXY_AUTH` on and
// no `X-USER`, `tagsFromHeader` answers `[""]` — the unowned bucket, which is
// every pre-gateway row. A builtin socket that polled without an identity
// would therefore push one owner's conversations into a signed-in stranger's
// sidebar, on a timer, with nobody having asked for anything. The seam exists
// to close that.
//
// --- why globalThis ---------------------------------------------------------
//
// The same reason server/nudge.ts does it, and the reasoning there is the full
// version: the installer and the reader are loaded by two different module
// systems. In `lumenjs dev` both go through Vite's `ssrLoadModule` and share a
// scope; under `lumenjs serve` sockets.ts is inlined into the page's Rollup
// bundle while the middleware is compiled beside it — two copies of this file,
// and a resolver set on one that the other never sees. A seam that works in
// dev and quietly resolves nobody in the shipped image is worse than none.
//
// No `node:` imports, for the reason server/engine.ts has none: sockets.ts
// imports this file, and sockets.ts is bundled for the browser through
// pages/index.ts's `export { socket }`.

/** Handshake headers in, an `X-USER` document out. `""` means "nobody is
 *  signed in on this connection", which is not the same as no resolver. */
export type IdentityResolver = (
  headers: Record<string, unknown>,
) => Promise<string>;

// Versioned for the same reason nudge.ts's key is: two copies of this file
// disagreeing about the shape behind one key is worse than two seams.
const KEY = "__agentsConsoleIdentityV1__";

interface Slot { resolve: IdentityResolver | null }

function slot(): Slot {
  const scope = globalThis as unknown as Record<string, unknown>;
  const found = scope[KEY];
  if (found && typeof found === "object") return found as Slot;
  const made: Slot = { resolve: null };
  scope[KEY] = made;
  return made;
}

/** Said once, by the only module that can answer the question. Passing `null`
 *  puts the seam back the way `none` and `proxy` leave it. */
export function setIdentityResolver(fn: IdentityResolver | null): void {
  slot().resolve = fn;
}

/** Whether anything here will answer. Asked separately from `resolveIdentity`
 *  because the two cases are not the same instruction: with no resolver the
 *  caller must leave the handshake's own headers alone, and with a resolver
 *  answering `""` it must remove the header entirely. */
export function hasIdentityResolver(): boolean {
  return slot().resolve !== null;
}

/** The `X-USER` document for this connection, or `""` for nobody. Never
 *  throws — a socket that cannot name its browser must poll as nobody, not
 *  fall over — and answers `""` when no resolver is installed, which callers
 *  are expected to distinguish with `hasIdentityResolver()` first. */
export async function resolveIdentity(
  headers: Record<string, unknown>,
): Promise<string> {
  const fn = slot().resolve;
  if (fn === null) return "";
  try {
    return await fn(headers);
  } catch {
    return "";
  }
}

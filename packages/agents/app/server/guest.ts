// Anonymous visitors, and the console's own answer to them.
//
// joule.sh lets somebody hold a conversation before they have an account. That
// used to be the gateway's: `authenticateOrGuest` in its main.lua minted an
// `nk-guest` cookie, answered `/whoami` itself, and stamped the `X-USER` the
// engine scopes rows to. Identity moved here (pages/_middleware.ts), so this
// moved with it — a console that owns sign-in and does not own the tier below
// it owns nothing, because the interesting case is the visitor who has not
// signed in yet.
//
// --- byte-compatible with what the gateway minted, deliberately ---------------
//
// Every guest conversation already in the engine is owned by a `guest:<32 hex>`
// tag out of a cookie the lua signed. Change the token format, the key, or the
// X-USER document and every one of those becomes unreachable — not deleted,
// which would at least be visible, but silently owned by nobody. So this is a
// reimplementation of a wire format, not a redesign of one:
//
//   token    base64url(payloadJSON) "." base64url(HMAC-SHA256(key, segment1))
//   payload  { sub, guest: true, anonymous: true, iat, exp }
//   sub      "guest:" + 32 lowercase hex
//   cookie   nk-guest, Path=/, 30 days, HttpOnly, Secure, SameSite=Lax
//   X-USER   {"uuid":…,"username":"guest","email":"","anonymous":true,"roles":[]}
//
// The `:` in the sub is load-bearing and is the lua's idea: it cannot appear in
// a real uuid, so a guest tag can never collide with a signed-in owner's, and
// the engine's own gates key on the prefix.
//
// --- the key is ours now, and seeded rather than shared -----------------------
//
// The lua derived its key as HMAC(LUMENJS_JWT_SECRET, "guest-token-v1") — the
// nuraly session secret, one step removed. Reading that variable here would
// have put nuraly back in Joule's identity path through the back door, which is
// the whole thing this move exists to stop. So the console takes its own
// `AUTH_GUEST_SECRET`, and for continuity it is SEEDED with the value that
// derivation produced. Same bytes, no shared source: rotating nuraly's secret
// cannot silently log out every Joule guest, and nothing here reads an
// environment variable belonging to another product.
//
// Unset, guests are off and every caller falls back to the 401 it had before —
// which is the correct posture for the dev host and for a laptop.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

/** 30 days, the lua's `GUEST_TOKEN_TTL`. */
const TTL_SECONDS = 30 * 24 * 3600;

/** New guest identities one address may mint per UTC day — the lua's
 *  `GUEST_MINTS_PER_DAY`. It is an anti-abuse floor, not the product's limit:
 *  the ceiling that matters is the per-guest message quota, which the engine
 *  meters and this knows nothing about. */
const MINTS_PER_DAY = 20;

const COOKIE = "nk-guest";

/** The signing key, or `null` when guests are off.
 *
 *  Hex in the environment, raw bytes in the HMAC — the lua's key is the raw
 *  32-byte output of its derivation, so a hex string used directly as the key
 *  would verify nothing that already exists. */
function guestKey(): Buffer | null {
  const hex = (process.env.AUTH_GUEST_SECRET ?? "").trim();
  if (hex === "") return null;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    console.error(
      "[guest] AUTH_GUEST_SECRET is not 64 hex characters. Guests are off — " +
      "a key of the wrong shape verifies no cookie this deployment has issued.",
    );
    return null;
  }
  return Buffer.from(hex, "hex");
}

/** Whether this deployment offers guest access at all. */
export function guestsEnabled(): boolean {
  return guestKey() !== null;
}

function sign(key: Buffer, segment: string): string {
  return crypto.createHmac("sha256", key).update(segment).digest("base64url");
}

export interface GuestToken { token: string; sub: string }

/** A fresh guest identity.
 *
 *  `randomBytes` and not anything cheaper: a predictable guest id is somebody
 *  else's metered quota, and the lua says so at its own mint. */
function issue(key: Buffer): GuestToken {
  const sub = "guest:" + crypto.randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    sub, guest: true, anonymous: true, iat: now, exp: now + TTL_SECONDS,
  });
  const segment = Buffer.from(payload, "utf8").toString("base64url");
  return { token: `${segment}.${sign(key, segment)}`, sub };
}

/** The `sub` a valid guest cookie carries, or `null`.
 *
 *  The shape checks are the lua's and they are not decoration: the sub is
 *  spliced into a JSON document below without escaping, so "only what we mint"
 *  has to be a property of the parser rather than a hope about the signer.
 *  `timingSafeEqual` because this is a signature comparison. */
export function verify(token: string | undefined, key: Buffer): string | null {
  if (typeof token !== "string" || token === "") return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;
  const segment = token.slice(0, dot);
  const given = token.slice(dot + 1);

  const expected = sign(key, segment);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload: { sub?: unknown; guest?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.guest !== true) return null;
  if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) return null;
  const sub = payload.sub;
  if (typeof sub !== "string" || !/^guest:[0-9a-f]{32}$/.test(sub)) return null;
  return sub;
}

// --- the per-address mint cap --------------------------------------------------
//
// The lua used `ngx.shared.guest_mint`, a dict shared across nginx workers.
// This process is one process, so a Map is the same thing with less ceremony —
// and the counter is anti-abuse rather than accounting, so a restart forgetting
// it is a cost, not a correctness bug.
//
// Keyed on (address, UTC day) exactly as the lua keyed it, and swept on write
// rather than on a timer: the map only grows while requests arrive, so the
// thing that grows it is the right thing to bound it.

const mints = new Map<string, number>();
let sweptOn = "";

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The caller's address, restored through the proxies in front.
 *
 *  `X-Forwarded-For` is a list appended to hop by hop, so the FIRST entry is
 *  the client and everything after it is infrastructure. Trusted here because
 *  the console is not publicly bound — the only way to reach it is through the
 *  gateway, which sets the header from the address Cloudflare restored.
 *
 *  Getting this wrong is not a small error: without the restore every visitor
 *  shares the edge's address, and a cap of 20 a day is then either meaningless
 *  or a denial of service against everybody behind that edge. */
function addressOf(req: IncomingMessage): string {
  const raw = req.headers["x-forwarded-for"];
  const list = Array.isArray(raw) ? raw[0] : raw;
  const first = (list ?? "").split(",")[0]?.trim();
  if (first) return first;
  // Optional chaining because not every caller has one: a websocket handshake
  // reaches this module as a bag of headers with no socket on it, and
  // `req.socket.remoteAddress` on that is a TypeError inside the identity
  // resolver — which surfaces as a feed that silently never connects.
  return req.socket?.remoteAddress ?? "unknown";
}

/** Whether this address may mint another guest today. */
function mayMint(req: IncomingMessage): boolean {
  const day = utcDay();
  if (sweptOn !== day) { mints.clear(); sweptOn = day; }
  const key = `${addressOf(req)}|${day}`;
  const used = (mints.get(key) ?? 0) + 1;
  mints.set(key, used);
  return used <= MINTS_PER_DAY;
}

// --- what the middleware asks for ----------------------------------------------

/** The `X-USER` document a guest is.
 *
 *  A literal, like the lua's, and for the lua's reason: every field but the sub
 *  is constant and the sub has been shape-checked to 32 hex, so there is
 *  nothing here that needs escaping. It must stay byte-compatible with
 *  `guestXUser` in main.lua — the engine reads `uuid` out of it and
 *  `src/api.ts` reads `anonymous` to decide whether to draw the guest strip. */
export function guestXUser(sub: string): string {
  return `{"uuid":"${sub}","username":"guest","email":"","anonymous":true,"roles":[]}`;
}

export interface Guest {
  /** The identity document to stamp on anything going to the engine. */
  xUser: string;
  /** Set when a cookie has to be written back — a fresh mint. */
  setCookie?: string;
}

/** The guest this request already IS, never a new one.
 *
 *  For callers with nowhere to put a `Set-Cookie`: a websocket handshake, which
 *  reaches identity as a bag of headers. Minting there would spend this
 *  address's daily allowance on a cookie the browser is never handed — the
 *  visitor stays anonymous and the counter moves anyway. The page load that
 *  preceded the socket is what mints; this only reads. */
export function guestFromCookie(req: IncomingMessage): Guest | null {
  const key = guestKey();
  if (key === null) return null;
  const held = (req.headers.cookie ?? "").match(/(?:^|;\s*)nk-guest=([^;]+)/)?.[1];
  const known = verify(held ? decodeURIComponent(held) : undefined, key);
  return known === null ? null : { xUser: guestXUser(known) };
}

/** Resolve this request to a guest: the cookie it carries, or a new one.
 *
 *  `null` means no guest — either the deployment has none, or this address has
 *  minted its allowance for the day. The caller turns that back into the 401 it
 *  would have answered anyway, so being over the cap looks exactly like guests
 *  being off, which is the honest thing for it to look like.
 *
 *  Never called before the signed-in check. A browser holding both cookies
 *  after signing in is its user, never its old guest — the same ordering the
 *  lua documents, and the reason this takes no view on which is better. */
export function resolveGuest(req: IncomingMessage): Guest | null {
  const key = guestKey();
  if (key === null) return null;

  const known = guestFromCookie(req);
  if (known !== null) return known;

  if (!mayMint(req)) return null;
  const { token, sub } = issue(key);
  return {
    xUser: guestXUser(sub),
    // Secure is unconditional: this cookie is a credential — it spends a
    // metered quota — and the only deployment that serves guests is behind
    // TLS. A local http console gets a cookie the browser declines to store,
    // which reads as "guests do not work on localhost" rather than as a
    // cookie quietly travelling in clear.
    setCookie: `${COOKIE}=${token}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  };
}

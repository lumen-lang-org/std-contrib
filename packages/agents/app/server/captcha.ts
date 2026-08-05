// The bot challenge in front of signing in and signing up.
//
// Configured in the admin area, not deployed: the engine holds the site key in
// a settings row and the secret in its encrypted store (`/captcha` in
// ../api.ts), and this fetches both. Same arrangement as the OAuth providers
// next door, for the same reason — rotating a key should not be a rebuild.
//
// --- why the token arrives in a HEADER ------------------------------------------
//
// Turnstile hands the browser a token and every example posts it as a form
// field. This takes it as `x-captcha-token` instead, and the reason is
// mechanical rather than aesthetic: the check has to happen BEFORE
// `handleAuthRoutes` runs, and that function reads the request body itself. A
// middleware that reads the body first has consumed the stream, so the
// framework's own parse sees nothing and every login fails with "email and
// password are required" — and putting the body back is a pile of stream
// surgery that would sit forever between this app and an upstream it does not
// patch. A header is read from an object that is already in memory. Nothing is
// consumed, nothing is replayed, and the framework's route is untouched.
//
// --- what a failure means here --------------------------------------------------
//
// Fails CLOSED on a refused token and OPEN on an unreachable verifier. Those
// are different risks: a refused token is the challenge doing its job, while
// Cloudflare being unreachable is an outage that would otherwise take the login
// form down with it. A bot that can also take down siteverify has better things
// to do than sign up here.

import type { IncomingMessage } from "node:http";

/** What the engine says this deployment's challenge is. */
interface Resolved {
  enabled: boolean;
  provider?: string;
  siteKey?: string;
  secret?: string;
}

/** The verification endpoint per provider.
 *
 *  hCaptcha and reCAPTCHA speak the same request and response shape as
 *  Turnstile — `secret` + `response`, and a `success` boolean back — which is
 *  the only reason supporting all three costs a map rather than three clients. */
const VERIFY_URL: Record<string, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  recaptcha: "https://www.google.com/recaptcha/api/siteverify",
};

let cache: { at: number; value: Resolved } = { at: 0, value: { enabled: false } };
/* Ten seconds, not sixty.
 *
 * The re-read on refusal below makes turning the challenge OFF instant. It
 * does nothing for turning it ON: when the cache says "off" this path answers
 * "ok" without asking anyone, so a deployment that has just switched the
 * challenge on keeps admitting unchallenged sign-ups for the rest of the
 * window — a free minute, on the one control whose whole job is to be in the
 * way. Sixty seconds of that is a poor trade for a lookup on a route nobody
 * hits in a loop.
 *
 * Not zero, and not a read per request: an unauthenticated route that makes
 * the console call the engine on every attempt is an amplifier a flood can
 * point at the engine. Ten seconds bounds the exposure without offering that. */
const TTL_MS = 10_000;

/** The configured challenge, cached for a minute.
 *
 *  A minute for the same reason `socialProviders` uses one: sign-in is not a
 *  hot path, but an operator who turns the challenge on should see it without a
 *  restart. On an engine that cannot be reached the LAST KNOWN answer stands
 *  rather than dropping to off — a blip must not quietly remove the challenge,
 *  which is the direction that matters for something whose whole job is to be
 *  in the way. */
export async function challenge(fresh = false): Promise<Resolved> {
  const now = Date.now();
  if (!fresh && now - cache.at < TTL_MS) return cache.value;
  const engine = (process.env.AGENTS_API ?? "http://127.0.0.1:8100").replace(/\/$/, "");
  try {
    const res = await fetch(engine + "/captcha/resolved", {
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as Resolved;
    cache = { at: now, value: body && typeof body === "object" ? body : { enabled: false } };
  } catch {
    cache = { at: now, value: cache.value };
  }
  return cache.value;
}

/** The site key the login form should render a widget for, or `null`.
 *
 *  Deliberately separate from the verification path: this is public (it is
 *  meant to be in a page), the secret is not, and nothing that answers a
 *  browser should be able to reach the second by asking for the first. */
export async function siteChallenge(): Promise<{ provider: string; siteKey: string } | null> {
  const c = await challenge();
  if (!c.enabled || !c.siteKey) return null;
  return { provider: c.provider ?? "turnstile", siteKey: c.siteKey };
}

export type Verdict = "ok" | "missing" | "refused";

/** Whether this request carries a token the provider vouches for.
 *
 *  `ok` when the challenge is off, which keeps every caller free of a "is it
 *  configured" branch — a deployment with no challenge is one where every
 *  request passes it. */
export async function verifyRequest(req: IncomingMessage): Promise<Verdict> {
  const c = await challenge();
  if (!c.enabled || !c.secret) return "ok";

  const raw = req.headers["x-captcha-token"];
  const token = (Array.isArray(raw) ? raw[0] : raw ?? "").trim();
  if (token === "") {
    /* No token — but is the challenge still on?
     *
     * The cache above is deliberately sticky in ONE direction: a blip that
     * makes the engine unreachable must not quietly remove a challenge. Its
     * cost is the other direction, and it is worse than it looks. Turn the
     * challenge OFF and `/auth/providers` stops advertising it at once, so
     * the form stops drawing a widget — while this path keeps demanding a
     * token for up to a minute. Nobody can sign in in that window, the card
     * says "Complete the challenge" with no challenge on screen to complete,
     * and the operator who just turned it off has no way to read that as a
     * cache.
     *
     * So a refusal costs one fresh read before it is a refusal. It is the
     * only place the staleness can hurt somebody, it happens once per
     * blocked attempt rather than per request, and it cannot weaken the
     * failure mode the cache exists for: an unreachable engine leaves the
     * last known answer standing, so this re-read either confirms the
     * challenge or finds it genuinely gone. */
    const now = await challenge(true);
    if (!now.enabled || !now.secret) return "ok";
    return "missing";
  }

  const url = VERIFY_URL[c.provider ?? "turnstile"] ?? VERIFY_URL.turnstile;
  const form = new URLSearchParams({ secret: c.secret, response: token });
  // The caller's address, so the provider can score it. First entry of
  // X-Forwarded-For for the reason server/guest.ts gives: the list is appended
  // to hop by hop, so the client is at the front.
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "").split(",")[0]?.trim();
  if (ip) form.set("remoteip", ip);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "ok";           // see the header note: open on outage
    const body = (await res.json()) as { success?: boolean };
    return body?.success === true ? "ok" : "refused";
  } catch {
    // Unreachable or timed out. Open, and loudly — an operator watching the log
    // should be able to tell "nobody is being challenged" from "everybody is
    // passing", because the two look identical from outside.
    console.warn("[captcha] verifier unreachable — allowing this sign-in unchallenged");
    return "ok";
  }
}

// The providers an operator configured, as far as a login form needs them.
//
// Its own module because there are two login surfaces and they must agree.
// `src/login-overlay.ts` is the card the console raises over a signed-out
// page; `pages/auth/_form.ts` is the standalone page at /auth/login. A
// provider that appears on one and not the other is a bug nobody would think
// to look for, so the row shape, the marks and the URL are decided once here.
//
// It must stay importable from a page module, which is the constraint that
// keeps this file free of components and of `customElements.define`: a page is
// evaluated on the SERVER as well, and a define at module scope runs there
// too. That is why `pages/auth/_form.ts` imports this rather than importing
// the overlay it would otherwise share the code with.

import { html, svg, type TemplateResult } from "lit";

/** One row of `GET /auth/providers` — an id to navigate to and a label to
 *  print. Never a client id and never a secret; see the route's own note in
 *  pages/_middleware.ts. */
export interface Social { id: string; label: string; kind: string }

/** Which buttons this deployment can honour, or none.
 *
 *  Every failure is the same failure and none of them is shown: a route that
 *  is not there (`AUTH=none` mounts no middleware at all), an engine that did
 *  not answer, a body that is not what it should be. The password form under
 *  these is the way in that always works, and an error line about a button
 *  that was never going to appear would only be noise on it. */
export async function askProviders(): Promise<Social[]> {
  return (await askLoginConfig()).providers;
}

/** The bot challenge this deployment renders, if any. */
export interface Challenge { provider: string; siteKey: string }

export interface LoginConfig { providers: Social[]; challenge: Challenge | null }

/** Everything the sign-in form needs to draw itself, in one ask. */
export async function askLoginConfig(): Promise<LoginConfig> {
  try {
    const res = await fetch("/auth/providers", { headers: { accept: "application/json" } });
    if (!res.ok) { return { providers: [], challenge: null }; }
    const body = (await res.json()) as { providers?: Social[]; challenge?: Challenge | null };
    return {
      providers: Array.isArray(body?.providers) ? body.providers : [],
      challenge: body?.challenge?.siteKey ? body.challenge : null,
    };
  } catch {
    return { providers: [], challenge: null };
  }
}

// --- the challenge widget --------------------------------------------------------
//
// Three providers, one shape: each ships a script that turns an element
// carrying a site key into a widget, and hands back a token through a callback.
// The differences are the script URL, the class name and the global — so this
// is a table and one render call rather than three integrations.

const WIDGET: Record<string, { src: string; cls: string; global: string }> = {
  turnstile: {
    src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    cls: "cf-turnstile", global: "turnstile",
  },
  hcaptcha: {
    src: "https://js.hcaptcha.com/1/api.js?render=explicit",
    cls: "h-captcha", global: "hcaptcha",
  },
  recaptcha: {
    src: "https://www.google.com/recaptcha/api.js?render=explicit",
    cls: "g-recaptcha", global: "grecaptcha",
  },
};

const loading = new Map<string, Promise<unknown>>();

/** Load a provider's script once per page, however many cards ask for it.
 *
 *  The overlay can be raised, dismissed and raised again, and `/auth/login` is
 *  a page that may be visited after it — appending the tag each time would load
 *  three copies of the same script and register the global three times. */
function loadScript(provider: string): Promise<unknown> {
  const spec = WIDGET[provider];
  if (!spec) return Promise.reject(new Error("unknown challenge provider"));
  const held = loading.get(provider);
  if (held) return held;
  const started = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = spec.src;
    tag.async = true;
    tag.defer = true;
    tag.onload = () => resolve(undefined);
    tag.onerror = () => reject(new Error("challenge script blocked"));
    document.head.appendChild(tag);
  });
  loading.set(provider, started);
  return started;
}

/** Draw the widget into `host` and call `onToken` when it solves.
 *
 *  The widget renders into a LIGHT-DOM element on purpose. Every one of these
 *  scripts finds its container with `document.querySelector` and injects an
 *  iframe into it, and neither survives being handed a node inside a shadow
 *  root — the card would show an empty box with no error anywhere. So the
 *  caller passes an element it has parented into the document, and the token
 *  comes back through this callback rather than through the DOM.
 *
 *  A rejected load is not fatal and must not be: `verifyRequest` on the server
 *  fails open when the verifier is unreachable, and a browser that cannot fetch
 *  the script is the same outage seen from the other side. The form stays
 *  usable and the server decides. */
export async function renderChallenge(
  c: Challenge, host: HTMLElement, onToken: (token: string) => void,
): Promise<void> {
  await loadScript(c.provider);
  const api = (window as unknown as Record<string, any>)[WIDGET[c.provider]!.global];
  if (!api?.render) return;
  api.render(host, {
    sitekey: c.siteKey,
    callback: (token: string) => onToken(token),
    // A token is single-use and short-lived. On expiry the widget solves again
    // by itself and hands back a fresh one; clearing ours in between stops a
    // stale token being posted and refused for a reason the person cannot see.
    "expired-callback": () => onToken(""),
    "error-callback": () => onToken(""),
  });
}

/** Where pressing a provider sends someone.
 *
 *  `GET /__nk_auth/login/<id>` is the framework's own route — it mints the
 *  state, the PKCE verifier and the authorization URL and answers a 302. So
 *  nothing about OAuth is implemented in this console; both forms draw a link.
 *
 *  `returnTo` is a path and never a URL, the same rule `src/api.ts` follows
 *  when it writes one: `//evil.example` is protocol-relative and would land a
 *  freshly signed-in person off-site. */
export function startUrl(p: Social, returnTo: string): string {
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return `/__nk_auth/login/${encodeURIComponent(p.id)}?returnTo=${encodeURIComponent(safe)}`;
}

/** The brand marks, inline, and the one place in this console that is not an
 *  `<nr-icon>`.
 *
 *  Not an exception to app/CLAUDE.md's rule so much as the edge it stops at: a
 *  brand mark is not in the icon set and cannot be — `nr-icon` draws the NAME
 *  when it has no glyph, so `name="github"` would put the word "github" on the
 *  button. (Checked against icon-paths: the set has `log-in` and `mail`, and
 *  neither `github` nor `google`.) An emoji is still forbidden here for the
 *  reason it is everywhere else, so a path is what is left. `currentColor`
 *  keeps it taking its colour from the theme, which is the property that rule
 *  is really protecting.
 *
 *  Only the two marks the ready-made shelf in `settings.ts` offers. A provider
 *  an operator adds by issuer gets its label and no mark, which is correct
 *  rather than unfinished — this file cannot know what an arbitrary issuer's
 *  logo is, and inventing one would be worse than the label alone. */
const MARKS: Record<string, TemplateResult> = {
  github: svg`<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47
    7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
    1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
    0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1
    2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08
    2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54
    1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>`,
  google: svg`<path fill="currentColor" d="M15.68 8.18c0-.57-.05-1.11-.15-1.64H8v3.1h4.3a3.68
    3.68 0 0 1-1.6 2.42v2h2.59c1.51-1.4 2.39-3.45 2.39-5.88ZM8 16c2.16 0 3.97-.72
    5.29-1.94l-2.59-2c-.72.48-1.63.77-2.7.77-2.08 0-3.84-1.4-4.47-3.29H.85v2.07A8 8 0 0
    0 8 16ZM3.53 9.54a4.8 4.8 0 0 1 0-3.08V4.39H.85a8 8 0 0 0 0 7.22l2.68-2.07ZM8
    3.17c1.18 0 2.23.4 3.06 1.2l2.29-2.29C11.97.79 10.16 0 8 0A8 8 0 0 0 .85
    4.39l2.68 2.07C4.16 4.57 5.92 3.17 8 3.17Z"/>`,
};

/** The mark for a row, or nothing.
 *
 *  Keyed on `kind` first and `id` second, which is the seam the engine's own
 *  column already draws: GitHub is `kind: "github"` because it is OAuth2 with
 *  no discovery document, while Google is an ordinary `oidc` row whose id is
 *  what names it. An issuer nobody anticipated matches neither and gets its
 *  label alone.
 *
 *  `aria-hidden`, because the link says "Continue with GitHub" beside it and a
 *  screen reader announcing the logo as well would say it twice. */
export function mark(p: Social): TemplateResult | string {
  const path = MARKS[p.kind] ?? MARKS[p.id];
  return path ? html`<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>` : "";
}

/** The shared look of a provider row, as CSS both forms paste into their own
 *  `static styles`.
 *
 *  A string rather than a `css` tagged template, because Lit will not let one
 *  stylesheet be interpolated into another without `unsafeCSS`, and a shared
 *  constant that has to be laundered through `unsafeCSS` at both call sites is
 *  worse than the two `css` tags reading it. Every value is a token with a
 *  fallback, so it works on a card that renders before the theme has. */
export const SOCIAL_CSS = `
  .social { display: flex; flex-direction: column; gap: 8px; }
  /* An <a> and not a button: this is a navigation to the framework's route,
     which answers a 302 to the provider. Nothing to submit and nothing to
     await, so there is no busy state to get wrong. */
  .prov {
    display: flex; align-items: center; justify-content: center; gap: 9px;
    padding: 10px 14px; border-radius: 12px;
    border: 1px solid var(--border, rgba(0,0,0,.12));
    background: var(--bg-card, #fff); color: var(--fg, rgba(0,0,0,.9));
    font: 600 13.5px/1.4 inherit; text-decoration: none; cursor: pointer;
    transition: background-color .15s cubic-bezier(.23,1,.32,1);
  }
  .prov:hover { background: var(--bg-sunken, rgba(0,0,0,.04)); }
  .prov:focus-visible { outline: 2px solid var(--focus, #000); outline-offset: 2px; }
  .prov svg { width: 16px; height: 16px; flex: none; }
  /* The rule with the word sitting on it, so "or" reads as a separator between
     two ways in rather than as a label on the form below. */
  .or { display: flex; align-items: center; gap: 10px;
        color: var(--muted, #667); font-size: 12px; }
  .or::before, .or::after {
    content: ""; flex: 1; height: 1px;
    background: var(--border, rgba(0,0,0,.12));
  }
`;

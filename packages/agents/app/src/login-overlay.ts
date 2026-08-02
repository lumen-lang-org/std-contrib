// Signing in, without leaving the console.
//
// The console used to answer a 401 by navigating to `/auth/login` — nuraly's
// own page, proxied under this hostname. That worked, and it cost four gateway
// locations serving another application's single-page build: its entry chunk,
// every module that chunk imports, its stylesheets by package name, and its
// loader routes. Three of today's outages were one of those prefixes being
// wrong. None of them were about signing in.
//
// So the page goes and the credentials stay here. What does NOT move is the
// endpoint: `POST /__nk_auth/login` is the framework's, it holds the password
// hashing, the TOTP branch, the email-verification refusal and the cookie
// writing, and none of that should exist twice. This element is a form and an
// error line in front of it.

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
// Plain constants, so this stays within the rule below: no component imports.
import { BRAND } from "./brand.js";
// No component imports here on purpose. `src/ui.ts` holds the one combination
// of LumenUI bundles that can coexist, and adding a per-component entry beside
// them registers a tag twice — or, as happened here, pulls in a component whose
// own requiredComponents are not satisfied ("nr-icon is not registered"), which
// throws during module load and blanks the whole console rather than this card.
// The console imports ui.ts before anything renders; that is the registration.

/** The one place a caller reads a LumenUI field: `.value` is what nr-input,
 *  nr-select and nr-textarea all agree on, unlike their event details. */
const valueOf = (root: ShadowRoot | null, id: string): string =>
  (root?.getElementById(id) as unknown as { value?: string } | null)?.value ?? "";

@customElement("login-overlay")
export class LoginOverlay extends LitElement {
  static styles = css`
    /* Its own backdrop rather than nr-overlay: this is not a surface inside
       the app, it is what stands in front of an app you may not use yet, and
       it must render before anything else has decided it can. */
    :host {
      position: fixed; inset: 0; z-index: 2000;
      display: grid; place-items: center;
      background: color-mix(in srgb, var(--bg-rail, #1f2429) 82%, transparent);
      backdrop-filter: blur(2px);
    }
    .card {
      /* border-box, and it is the whole of the phone bug it fixes. A shadow
         root gets no reset from the page, so this card was content-box: the
         min() below sized the CONTENT at 92vw and then the 28px of padding a
         side and the border went on top — 359 + 56 + 2 = 417px of card on a
         390px screen, sign-in button off the right edge. The width rule was
         always correct; it was measuring the wrong box. */
      box-sizing: border-box;
      width: min(92vw, 380px);
      background: var(--bg-card, #fff);
      border: 1px solid var(--border, rgba(0,0,0,.12));
      /* The composer's radius, because this is the same design language and
         the first surface a person meets should say so. */
      border-radius: 24px;
      padding: 28px 28px 24px;
      box-shadow: 0 4px 12px rgba(0,0,0,.04), 0 12px 32px -8px rgba(0,0,0,.16);
      display: flex; flex-direction: column; gap: 14px;
    }
    /* The wordmark, dot and all — the first surface a person meets was the
       one place the product went unnamed. The dot cycles hue the way the
       chat's empty-state dot does; filter-driven rather than a JS interval,
       because this card renders before the app's modules and must not wait
       for them. Ambient, so it respects a reduced-motion ask. */
    /* The hero's own numbers (chatbot empty-state: 700, -0.02em), scaled
       down — same face, same weight, so the card and the empty page read as
       one mark and not two logos. */
    .mark { font: 700 40px var(--display, inherit); letter-spacing: -0.02em;
            text-align: center; }
    .mark .dot { color: hsl(340 72% 58%); display: inline-block;
                 animation: login-dot 8s linear infinite; }
    @keyframes login-dot { to { filter: hue-rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .mark .dot { animation: none; } }
    p.lede { margin: -6px 0 4px; color: var(--muted, #667); font-size: 13.5px;
             text-align: center; }
    nr-input { display: block; width: 100%; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 4px; }
    .row nr-button { flex: 1; }
    /* Reserved whether or not it is filled: a message that appears must not
       move the button out from under the pointer going to press it. */
    .why { min-height: 18px; font-size: 13px; color: var(--danger, #a8321f); }
    .note { font-size: 12.5px; color: var(--muted, #667); }
    .note a { color: inherit; }
  `;

  @state() private busy = false;
  @state() private why = "";

  private async submit(): Promise<void> {
    if (this.busy) { return; }
    const email = valueOf(this.shadowRoot, "email").trim();
    const password = valueOf(this.shadowRoot, "password");
    if (email === "" || password === "") {
      this.why = "Email and password, please.";
      return;
    }
    this.busy = true;
    this.why = "";
    try {
      const res = await fetch("/__nk_auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // The cookies are set; the console has to re-ask everything it drew
        // while signed out — the thread list, the agents, its own identity.
        // A reload is the honest way to do that: the server injects identity
        // into the document, so re-rendering from it is what the rest of the
        // app already assumes.
        location.reload();
        return;
      }
      // The endpoint's own words where it has them — it distinguishes a wrong
      // password from an unverified address from a TOTP challenge, and a
      // single "login failed" would throw that away.
      const said = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (res.status === 401) { this.why = said?.error ?? "That email and password do not match."; }
      else if (res.status === 403) { this.why = said?.error ?? "This account is not verified yet."; }
      else { this.why = said?.error ?? `Sign-in failed (${res.status}).`; }
    } catch {
      this.why = "Could not reach the server. Try again.";
    } finally {
      this.busy = false;
    }
  }

  render() {
    return html`
      <div class="card" @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { void this.submit(); } }}>
        <!-- The wordmark IS the heading. "Sign in" under it said what the
             button already says, twice on one small card. -->
        <div class="mark">${BRAND}<span class="dot">.</span></div>
        <p class="lede">Your conversations are private to your account.</p>
        <nr-input id="email" type="email" placeholder="Email" autocomplete="username"></nr-input>
        <nr-input id="password" type="password" placeholder="Password"
                  autocomplete="current-password"></nr-input>
        <div class="why" role="alert" aria-live="polite">${this.why}</div>
        <div class="row">
          <nr-button ?disabled=${this.busy} @click=${() => { void this.submit(); }}>
            ${this.busy ? "Signing in…" : "Sign in"}
          </nr-button>
        </div>
        <!-- Reset and signup stay on the pages that own them: they send mail,
             they have their own rate limits, and neither is a thing you do
             often enough to be worth a second form in here. -->
        <div class="note"><a href="/auth/forgot-password">Forgot your password?</a></div>
      </div>
    `;
  }

  firstUpdated(): void {
    (this.shadowRoot?.getElementById("email") as HTMLElement | null)?.focus();
  }
}

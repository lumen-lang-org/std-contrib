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
//
// The social buttons follow the same rule one step further. A provider is a
// row an operator added in the admin area's Sign-in screen, and pressing one
// is a plain navigation to `GET /__nk_auth/login/<id>` — the framework's own
// route, which mints the state, the PKCE verifier and the authorization URL.
// Nothing about OAuth is implemented here; this file draws a link.
//
// Which links to draw comes from `GET /auth/providers`, and asking rather than
// knowing is deliberate: `pages/_middleware.ts` is the only file that may read
// `AUTH`, and a deployment whose login is served by a gateway in front answers
// with an empty list. So this card is the same card in all three modes.

import { LitElement, css, html, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
// Plain constants, so this stays within the rule below: no component imports.
import { BRAND } from "./brand.js";
// The provider list, the marks and the URL — shared with pages/auth/_form.ts
// so the two login surfaces cannot disagree about what this deployment offers.
import { askLoginConfig, mark, renderChallenge, startUrl, SOCIAL_CSS,
         type Challenge, type Social } from "./social-login.js";
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
      /* The same pair the console's own sheets use: the ground dims, the card
         rises into it. Written here rather than shared because this element
         renders in front of the console and cannot depend on its stylesheet —
         it has to work before the app has decided anything. */
      animation: overlay-veil .2s cubic-bezier(.23,1,.32,1);
    }
    @keyframes overlay-veil { from { opacity: 0; } }
    @keyframes overlay-rise {
      from { opacity: 0; transform: translateY(12px) scale(.985); }
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
      /* A beat behind the backdrop, so the two read as one gesture — the room
         dims, then the card is there — rather than as two things that
         happened to start together. */
      animation: overlay-rise .24s cubic-bezier(.23,1,.32,1) .04s both;
      /* The rail's ink, and stated rather than inherited. A shadow root does
         inherit the color property, but from whatever the host sat inside —
         which for a fixed overlay is the document, and the card ended up a
         shade lighter than every label in the sidebar behind it. --fg is what
         src/sidebar.ts gives a thread title; this is the first surface of the
         same product and should read as the same weight of text. */
      color: var(--fg, rgba(0,0,0,.9));
      /* The field placeholders are drawn inside nr-input's shadow root, out of
         reach of any rule here — but a custom property crosses that boundary,
         and --nr-placeholder is the one the component reads. Left at its own
         default they were #a8a8a8, the lightest text on a card that had just
         been darkened everywhere else. */
      --nr-placeholder: var(--muted, rgba(0,0,0,.45));
      /* And the button's own, for the same reason. The nr-button default type
         is tokenised but its fallbacks are a palette of its own — #536471 text
         on a #eff3f4 border — which on this card left the primary action as
         the FAINTEST thing on it, fainter than the note under it. Named
         rather than restyled: the component's shape, states and focus ring are
         all still its own, and only the two colours the theme has an opinion
         about are answered here. */
      --nuraly-button-default-color: var(--fg, rgba(0,0,0,.9));
      --nuraly-button-default-border: var(--border, rgba(0,0,0,.12));
    }
    /* The wordmark, dot and all — the first surface a person meets was the
       one place the product went unnamed. The dot cycles hue the way the
       chat's empty-state dot does; filter-driven rather than a JS interval,
       because this card renders before the app's modules and must not wait
       for them. Ambient, so it respects a reduced-motion ask. */
    /* The hero's own numbers AND its own family, copied verbatim from the
       chatbot host rule rather than routed through --display: the two tokens
       resolve to different faces on some platforms (system-ui vs
       -apple-system picks a different J), and "matching" through a different
       variable is how the card kept reading as a second logo. If the
       component's stack ever changes, change this with it — the price of the
       card rendering before the component exists. */
    .mark { font-weight: 700; font-size: 40px; letter-spacing: -0.02em;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
                         'Roboto', 'Helvetica Neue', Arial, sans-serif;
            text-align: center; }
    .mark .dot { color: hsl(340 72% 58%); display: inline-block;
                 animation: login-dot 8s linear infinite; }
    @keyframes login-dot { to { filter: hue-rotate(360deg); } }
    /* All three of this element's animations, switched off together — and
       AFTER the rules that set them, which is the whole reason this block is
       down here rather than beside the ones it cancels. Written above .card,
       the media query lost on source order and the card still rose while the
       backdrop obeyed; measured under an emulated reduce, not assumed. */
    @media (prefers-reduced-motion: reduce) {
      :host, .card, .mark .dot { animation: none; }
    }
    /* --fg and not --muted, the same correction the .thread note in sidebar.ts
       records: --muted is rgba(0,0,0,.45), which lands around 140,140,140 on
       this card and was the faintest thing on the first screen a person
       meets. Size carries the hierarchy here, not opacity. */
    p.lede { margin: -6px 0 4px; color: var(--fg, rgba(0,0,0,.9));
             font-size: 13.5px; text-align: center; }
    nr-input { display: block; width: 100%; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 4px; }
    .row nr-button { flex: 1; }

    /* The providers an operator configured, styled once in
       src/social-login.ts so /auth/login draws the same row. */
    ${unsafeCSS(SOCIAL_CSS)}

    /* Reserved whether or not it is filled: a message that appears must not
       move the button out from under the pointer going to press it. */
    .why { min-height: 18px; font-size: 13px; color: var(--danger, #a8321f); }
    .note { font-size: 12.5px; color: var(--fg, rgba(0,0,0,.9)); }
    .note a { color: inherit; }
    /* The other thing a person on this card may want to do. A text button, not
       a second nr-button: creating an account must read as smaller than
       signing in, because on this screen it is the rarer of the two. */
    .later { background: none; border: 0; padding: 6px; cursor: pointer;
             font: inherit; font-size: 13px; color: var(--fg, rgba(0,0,0,.9));
             text-align: center; text-decoration: none; }
    .later:hover { text-decoration: underline; }
  `;

  /* Soft: the quota wall, not the locked door. The thread behind stays
     readable, the backdrop and a "Not now" button both dismiss, and the card
     explains itself through `note`. Default (hard) mode is the real 401 and
     changes not at all: no dismissal, no note, same form. */
  @property({ type: Boolean }) soft = false;
  /* The sentence above the form when there is something to explain — the
     quota wall's "you have used your free messages". Empty draws the default
     lede. */
  @property() note = "";

  @state() private busy = false;
  @state() private why = "";
  /* Empty until the ask below answers, and empty forever in a deployment that
     offers none — so the card renders its password form immediately and grows
     the buttons a moment later rather than waiting on a fetch to draw at all. */
  @state() private social: Social[] = [];
  /* The bot challenge, if this deployment configured one. */
  @state() private challenge: Challenge | null = null;
  /* The token the widget last handed us. Empty means unsolved or expired —
     the server refuses either way, so this is not a gate, only a payload. */
  #captcha = "";

  private dismiss(): void {
    if (!this.soft) { return; }
    this.dispatchEvent(new CustomEvent("dismiss"));
  }

  connectedCallback(): void {
    super.connectedCallback();
    // The backdrop IS the host, so a click on it can only be caught here; the
    // card stops its own clicks below so pressing the form is never a close.
    this.addEventListener("click", () => { this.dismiss(); });
    void askLoginConfig().then((c) => {
      this.social = c.providers;
      this.challenge = c.challenge;
    });
  }

  /** The page a provider should hand somebody back to.
   *
   *  The overlay stands over the page a person was already on, so that page IS
   *  the return — there is nothing to remember and nothing to read out of a
   *  query string. `startUrl` re-checks it anyway. */
  private here(): string {
    return location.pathname + location.search;
  }

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
        // The token travels as a header rather than in the body: the server
        // has to check it BEFORE the framework's route reads the body, and a
        // middleware that read the body first would consume the stream out
        // from under it (server/captcha.ts says this at length).
        headers: {
          "content-type": "application/json",
          ...(this.#captcha === "" ? {} : { "x-captcha-token": this.#captcha }),
        },
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
      <div class="card"
        @click=${(e: Event) => { e.stopPropagation(); }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") { void this.submit(); }
          if (e.key === "Escape") { this.dismiss(); }
        }}>
        <!-- The wordmark IS the heading. "Sign in" under it said what the
             button already says, twice on one small card. -->
        <div class="mark">${BRAND}<span class="dot">.</span></div>
        <p class="lede">${this.note !== "" ? this.note
          : "Your conversations are private to your account."}</p>

        <!-- Above the fields, not below them: a person who has an account with
             one of these is done in one press, and burying the shortcut under
             the form they do not need to fill is the wrong order. -->
        ${this.social.length === 0 ? "" : html`
          <div class="social">
            ${this.social.map((p) => html`
              <a class="prov" href=${startUrl(p, this.here())}>
                ${mark(p)}
                <span>Continue with ${p.label}</span>
              </a>`)}
          </div>
          <div class="or"><span>or</span></div>`}

        <nr-input id="email" type="email" placeholder="Email" autocomplete="username"></nr-input>
        <nr-input id="password" type="password" placeholder="Password"
                  autocomplete="current-password"></nr-input>
        <!-- The challenge widget renders into a light-DOM child projected
             here. It cannot render inside this shadow root: every provider's
             script finds its container with document.querySelector and
             injects an iframe, and neither step crosses a shadow boundary —
             the card would show an empty gap and no error. -->
        <slot name="challenge"></slot>
        <div class="why" role="alert" aria-live="polite">${this.why}</div>
        <div class="row">
          <nr-button ?disabled=${this.busy} @click=${() => { void this.submit(); }}>
            ${this.busy ? "Signing in…" : "Sign in"}
          </nr-button>
        </div>
        <!-- Was "Not now", and only under the soft flag. Two problems with
             that: a card offering no way to GET an account is a dead end for
             everyone who does not have one, and the dismissal was the more
             prominent of the two things a stuck person could press. So this
             slot is registration, and it is there in both modes.

             The soft wall keeps its way out — the backdrop and Escape both
             still dismiss, which is what the flag has always gated — and a
             quota wall that no longer advertises "not now" as its headline
             answer is the better wall anyway. -->
        <a class="later" href=${`/auth/signup?returnTo=${encodeURIComponent(this.here())}`}
           >Create an account</a>
        <!-- Reset and signup stay on the pages that own them: they send mail,
             they have their own rate limits, and neither is a thing you do
             often enough to be worth a second form in here. -->
        <div class="note"><a href="/auth/forgot-password">Forgot your password?</a></div>
      </div>
    `;
  }

  /** Parent a light-DOM host for the widget and let the provider draw into it.
   *
   *  In `updated` rather than `firstUpdated`: the challenge arrives from a
   *  fetch, so the first render almost never has it. Guarded by the element
   *  already existing, which is what makes re-rendering cheap. */
  updated(): void {
    if (this.challenge === null || this.querySelector("[slot=challenge]") !== null) { return; }
    const host = document.createElement("div");
    host.setAttribute("slot", "challenge");
    this.appendChild(host);
    void renderChallenge(this.challenge, host, (token) => { this.#captcha = token; })
      .catch(() => { /* blocked or offline — the server decides, see captcha.ts */ });
  }

  firstUpdated(): void {
    (this.shadowRoot?.getElementById("email") as HTMLElement | null)?.focus();
  }
}

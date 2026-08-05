// The sign-in card, shared by /auth/login and /auth/signup.
//
// Underscore-prefixed so LumenJS's page scanner skips it (build/scan.ts) —
// this is a component, not a route. Same convention apps/social uses for its
// `_lib` folders.
//
// It only exists under `AUTH=builtin`. In `none` there is nothing to sign into
// and in `proxy` the gateway serves its own login; pages/_middleware.ts is
// what makes those true, and this file makes no attempt to check the mode. A
// visitor who reaches /auth/login in the wrong mode gets a form whose POST
// 404s, which is the honest outcome — a page that lies about being able to log
// you in would be worse.
//
// Everything it posts to is LumenJS's: `/__nk_auth/login` and
// `/__nk_auth/signup`, from `auth/config.ts`'s ROUTE_DEFAULTS. The paths are
// repeated in server/auth-builtin.ts's config and the two lists have to agree.

import { LitElement, html, css, unsafeCSS } from "lit";
// The provider list, the marks and the URL. Shared with src/login-overlay.ts,
// which is the console's other login surface — a provider that appeared on one
// and not the other would be a bug nobody would think to look for. It is that
// module and not the overlay itself because a page is evaluated on the server
// too, and the overlay carries a `customElements.define` at module scope.
import { askLoginConfig, mark, renderChallenge, startUrl, SOCIAL_CSS,
  type Challenge, type Social } from "../../src/social-login.js";

// The LumenUI registration list, whole and unmodified.
//
// Not `@nuraly/lumenui/input/bundle` + `@nuraly/lumenui/button/bundle`, which
// is what this page actually needs: each bundle inlines its own copy of its
// dependencies, and two that share one throw `define(...) has already been
// used` during module load (app/CLAUDE.md). src/ui.ts holds the one
// combination that coexists, and importing anything else alongside it is the
// same trap from a new direction. It is heavier than a login page deserves —
// the canvas bundle carries an editor this form never draws — and paying that
// once is cheaper than maintaining a second list that has to stay compatible
// with the first.
//
// Guarded for the same reason pages/index.ts guards its console import: a page
// module is evaluated on the server too, and the bundle chain reaches a
// CommonJS `module` reference there. `import.meta.env.SSR`, not `typeof
// window` — @lit-labs/ssr shims `window`, so a window check lets it through.
if (!import.meta.env.SSR) {
  import("../../src/ui.js");
}

/** The value a LumenUI field is carrying, read off the element.
 *
 *  The same helper src/settings.ts keeps, for the same reason: nr-input and
 *  nr-textarea describe their event payloads differently and `.value` is what
 *  they agree on. */
function valueOf(e: Event): string {
  return (e.target as unknown as { value?: string }).value ?? "";
}

/** Where to go after signing in.
 *
 *  A path, never a URL — the same rule `toLogin()` in src/api.ts follows when
 *  it writes this parameter, and `safeReturnTo` in the framework applies it
 *  again server-side. Checked here as well because this side is what calls
 *  `location.assign`, and a `//evil.example` would be a protocol-relative URL
 *  that sends a freshly signed-in user off-site. */
function returnTo(): string {
  const asked = new URLSearchParams(location.search).get("returnTo") ?? "";
  return asked.startsWith("/") && !asked.startsWith("//") ? asked : "/";
}

/** The card, as a base class rather than as its own custom element.
 *
 *  `pages/auth/login.ts` and `pages/auth/signup.ts` extend it and set `mode`,
 *  and LumenJS defines each of them as `page-auth-login` / `page-auth-signup`
 *  (shared/utils.ts::filePathToTagName). So there is no `customElements.define`
 *  in this file — which is not tidiness: a define at module scope runs during
 *  the server-side evaluation of the page too, and one that ran twice under
 *  HMR would throw the same "already been used" the bundle note above is about.
 *
 *  It also puts `:host` on the page element itself, which is what wants the
 *  full-height ground: head.html's height chain names `page-index` and stops
 *  there, so an auth page has to carry its own. */
export class AuthCard extends LitElement {
  static properties = {
    mode: { type: String },
    busy: { state: true },
    error: { state: true },
    social: { state: true },
    challenge: { state: true },
  };

  /** "login" or "signup". */
  mode: "login" | "signup" = "login";
  busy = false;
  error = "";
  /** The providers this deployment can honour. Empty until the ask below
   *  answers, and empty forever where none are configured — so the password
   *  form paints at once and the buttons arrive rather than being waited on. */
  social: Social[] = [];
  /** The bot challenge this deployment renders, or null where there is none.
   *  Same shape and same source as the overlay's. */
  challenge: Challenge | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    // The challenge is asked for on BOTH cards, unlike the provider buttons
    // below it. pages/_middleware.ts challenges /__nk_auth/login and
    // /__nk_auth/signup alike, so a signup card that drew no widget would post
    // without a token and be refused — which is exactly what this whole page
    // did until now, on both routes: the overlay in src/login-overlay.ts drew
    // the challenge and this card did not, so turning the challenge on broke
    // /auth/login and /auth/signup while the console's own sign-in kept
    // working. Two surfaces, one contract.
    void askLoginConfig().then((c) => {
      this.challenge = c.challenge;
      // Only on the login card. Signing up through a provider is the
      // provider's own signup, so the button would say "Continue with GitHub"
      // and mean something different on each of the two cards this class
      // draws.
      if (this.mode === "login") { this.social = c.providers; }
    });
  }

  #email = "";
  #password = "";
  #name = "";
  /* The last token the widget handed over. Empty until it solves, and emptied
     again when it expires — a stale token is refused for a reason the person
     cannot see, so it is better to send none. */
  #captcha = "";

  static styles = css`
    /* Kimi's hero surface: a white card on the warm ground, 24px radius, the
       only bordered thing on the screen, floating on a soft double shadow.
       KIMI-DESIGN.md's composer measurements, applied to the one card this
       page has. */
    :host {
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: var(--bg-rail);
      padding: 24px; box-sizing: border-box;
    }
    .card {
      width: 100%; max-width: 380px; background: var(--bg-card);
      border: 1px solid rgba(0,0,0,.17); border-radius: 24px;
      padding: 32px 32px 28px;
      box-shadow: 0 4px 12px rgba(0,0,0,.03), 0 5px 16px -4px rgba(0,0,0,.07);
    }
    /* The sidebar's wordmark, so the login and the console are the same
       product. src/sidebar.ts draws exactly this. */
    .brand { font: 600 15px var(--display); letter-spacing: -0.01em;
             color: var(--fg); }
    .brand .dot { color: var(--brand); }
    h1 { margin: 18px 0 24px; font: 700 22px/1.2 var(--display);
         letter-spacing: -0.02em; color: var(--fg); }

    .f { margin-bottom: 14px; }
    nr-input { display: block; width: 100%; }

    /* A primary action is ink, not a hue — head.html's note on --accent. */
    .go {
      width: 100%; margin-top: 22px; padding: 11px 16px;
      border: 0; border-radius: 12px; cursor: pointer;
      background: var(--accent); color: var(--accent-fg);
      font: 600 14px/1.4 var(--display);
      transition: background-color .15s cubic-bezier(.23,1,.32,1);
    }
    .go:hover:not(:disabled) { background: var(--accent-hover); }
    .go:disabled { background: rgba(0,0,0,.15); cursor: default; }
    .go:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .err {
      display: flex; align-items: center; gap: 8px; margin-top: 16px;
      color: var(--danger); font-size: 13px; line-height: 1.4;
    }
    .err nr-icon { flex: none; }

    .alt { margin: 20px 0 0; text-align: center; font-size: 13px;
           color: var(--muted); }
    .alt a { color: var(--fg); font-weight: 600; text-decoration: none; }
    .alt a:hover { text-decoration: underline; }

    /* The providers an operator configured. Styled once in
       src/social-login.ts so the overlay draws the same row; the two rules
       below are this card's own spacing, which its flow does not give it. */
    ${unsafeCSS(SOCIAL_CSS)}
    .social { margin-bottom: 16px; }
    .or { margin-bottom: 16px; }
  `;

  #field(id: string, label: string, type: string, on: (v: string) => void) {
    return html`
      <div class="f">
        <nr-input id=${id} type=${type} ?disabled=${this.busy}
          @nr-input=${(e: Event) => on(valueOf(e))}
          @input=${(e: Event) => on(valueOf(e))}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this.#submit(); }}>
          <span slot="label">${label}</span>
        </nr-input>
      </div>`;
  }

  async #submit(): Promise<void> {
    if (this.busy) return;
    if (this.#email === "" || this.#password === "") {
      this.error = "Email and password are both needed.";
      return;
    }
    this.busy = true;
    this.error = "";
    const signup = this.mode === "signup";
    const where = signup
      ? "/__nk_auth/signup"
      : `/__nk_auth/login?returnTo=${encodeURIComponent(returnTo())}`;
    try {
      const res = await fetch(where, {
        method: "POST",
        // `accept: application/json` is what puts the framework's route in
        // cookie-and-JSON mode rather than answering a 302 — see
        // auth/routes/login.js. The Set-Cookie rides along either way.
        // The challenge token as a header, not a form field. server/captcha.ts
        // reads x-captcha-token and says why at length: the framework owns the
        // body of these two routes, so adding a member to it would be adding a
        // field to somebody else's schema.
        headers: {
          "content-type": "application/json", accept: "application/json",
          ...(this.#captcha === "" ? {} : { "x-captcha-token": this.#captcha }),
        },
        body: JSON.stringify(
          signup
            ? { email: this.#email, password: this.#password, name: this.#name }
            : { email: this.#email, password: this.#password },
        ),
      });
      const body = await res.text();
      if (!res.ok) {
        let why = `HTTP ${res.status}`;
        try { why = (JSON.parse(body) as { error?: string }).error ?? why; } catch { /* not JSON */ }
        this.error = why;
        this.busy = false;
        return;
      }
      // A full navigation rather than a router push: the console's whole
      // module graph has to load as a signed-in document, and every request
      // it makes on the way needs the cookie that was just set.
      location.assign(returnTo());
    } catch (err) {
      this.error = (err as Error)?.message ?? "Could not reach the server.";
      this.busy = false;
    }
  }

  render() {
    const signup = this.mode === "signup";
    return html`
      <div class="card">
        <span class="brand">Agents<span class="dot">.</span></span>
        <h1>${signup ? "Create an account" : "Sign in"}</h1>

        <!-- Above the fields, not below them: somebody who has an account with
             one of these is done in one press, and burying the shortcut under
             a form they do not need to fill is the wrong order. -->
        ${this.social.length === 0 ? "" : html`
          <div class="social">
            ${this.social.map((p) => html`
              <a class="prov" href=${startUrl(p, returnTo())}>
                ${mark(p)}
                <span>Continue with ${p.label}</span>
              </a>`)}
          </div>
          <div class="or"><span>or</span></div>`}

        ${signup ? this.#field("a-name", "Name", "text", (v) => { this.#name = v; }) : ""}
        ${this.#field("a-email", "Email", "email", (v) => { this.#email = v; })}
        ${this.#field("a-password", "Password", "password", (v) => { this.#password = v; })}

        <!-- The widget draws into a light-DOM child projected here, not into
             this shadow root. Turnstile renders an iframe and reads the
             document around it; src/login-overlay.ts reached the same
             arrangement and this follows it rather than discovering the same
             thing twice. Empty and zero-height where no challenge is
             configured, which is every deployment that has not turned one on. -->
        <slot name="challenge"></slot>

        <button id="a-submit" class="go" ?disabled=${this.busy} @click=${() => void this.#submit()}>
          ${this.busy ? "Working…" : signup ? "Create account" : "Sign in"}
        </button>

        ${this.error === "" ? "" : html`
          <p class="err" id="a-error">
            <nr-icon name="alert-circle" size="small"></nr-icon>
            <span>${this.error}</span>
          </p>`}

        <p class="alt">
          ${signup
            ? html`Already have an account? <a href="/auth/login">Sign in</a>`
            : html`No account yet? <a href="/auth/signup">Create one</a>`}
        </p>
      </div>`;
  }

  /** Parent a light-DOM host for the widget and let the provider draw into it.
   *
   *  In `updated` rather than `firstUpdated` because the challenge arrives
   *  from a fetch and the first render almost never has it. Guarded by the
   *  host already existing, so re-rendering costs a querySelector and the
   *  widget is never drawn twice — a second render would leave two challenges
   *  on the card and only one of them wired to the token. */
  updated(): void {
    if (this.challenge === null || this.querySelector("[slot=challenge]") !== null) { return; }
    const host = document.createElement("div");
    host.setAttribute("slot", "challenge");
    this.appendChild(host);
    void renderChallenge(this.challenge, host, (token) => { this.#captcha = token; })
      .catch(() => { /* blocked or offline — the server decides, see captcha.ts */ });
  }
}

// The bot challenge: configured in /admin, drawn on both login surfaces,
// enforced on the two routes that create or claim an account.
//
// It earns a file of its own because it is the one feature here that can lock
// every person out of the deployment, including the operator who turned it on,
// and because each of its three halves failed independently in ways the others
// hid:
//
//   * The engine could not store `enabled`. The console sent a JSON boolean,
//     `jsonText` answers "" for anything that is not a string, and the row was
//     written as false — with a 200 and no error anywhere. The checkbox came
//     back unticked and nothing in the UI could say why.
//   * /auth/login drew no widget. The console's own overlay did, so sign-in
//     kept working from inside the app while the standalone page — the one a
//     signed-out link goes to — posted with no token and was refused.
//   * A wrong secret refuses everybody, and looks exactly like a wrong
//     password from the outside.
//
// So this asserts the round trip, both surfaces, and that a real person can
// still get in while the challenge is on.
//
//   CONSOLE_URL=https://joule.sh npx playwright test e2e/captcha.spec.ts
//
// Credentials come from packages/agents/app/.env — the admin half needs an
// operator, and skips without one. The whole file restores whatever the
// deployment was set to before it ran: a spec that leaves a challenge switched
// on with a bad secret is a spec that takes the site down.

import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { open, ready } from "./console.js";

const USER = process.env.JOULE_TEST_USER ?? "";
const PASS = process.env.JOULE_TEST_PASS ?? "";
const API = process.env.AGENTS_API ?? "http://127.0.0.1:8100";

interface Captcha {
  provider: string;
  siteKey: string;
  enabled: boolean;
  configured?: boolean;
}

/** One element, through however many shadow roots. */
const FIND = `(sel) => {
  const find = (root, depth = 0) => {
    if (depth > 16) return null;
    for (const el of root.querySelectorAll("*")) {
      if (el.matches && el.matches(sel)) return el;
      if (el.shadowRoot) { const hit = find(el.shadowRoot, depth + 1); if (hit) return hit; }
    }
    return null;
  };
  return find(document);
}`;

/** Every match, through however many shadow roots.
 *
 *  Needed as well as FIND because a plain `document.querySelector` for
 *  `console-settings` answers null — the element is itself inside the
 *  console's shadow root, so a query written at document level silently
 *  matches nothing. A spec that then clicks `saves[saves.length - 1]` clicks
 *  undefined, waits, and asserts against a page nobody touched: it passed
 *  while proving nothing, which is worse than failing. */
const ALL = `(sel) => {
  const out = [];
  const walk = (root, depth = 0) => {
    if (depth > 16) return;
    for (const el of root.querySelectorAll("*")) {
      if (el.matches && el.matches(sel)) out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };
  walk(document);
  return out;
}`;

/** Wait until the CONSOLE agrees with the engine about the challenge.
 *
 *  server/captcha.ts caches the resolved challenge for a minute, deliberately
 *  and with a comment saying why. So flipping the row and asserting on the
 *  next line tests the cache, not the feature — which is exactly how the first
 *  version of this file failed: it turned the challenge off, signed in, and
 *  was refused by a console still holding the previous minute's answer.
 *
 *  Polled rather than slept, so a console that has already picked the change up
 *  costs one request instead of a flat minute. */
async function settle(page: Page, want: boolean): Promise<void> {
  const deadline = Date.now() + 75_000;
  for (;;) {
    const res = await page.request.get("/auth/providers");
    const body = (await res.json()) as { challenge?: unknown };
    if ((body.challenge !== null && body.challenge !== undefined) === want) { return; }
    if (Date.now() > deadline) {
      throw new Error(`the console still disagrees after 75s — wanted challenge ${want ? "on" : "off"}`);
    }
    await page.waitForTimeout(3000);
  }
}

async function captchaRow(request: APIRequestContext): Promise<Captcha> {
  return (await request.get(`${API}/captcha`)).json() as Promise<Captcha>;
}

async function setCaptcha(request: APIRequestContext, row: Captcha): Promise<number> {
  const res = await request.put(`${API}/captcha`, {
    data: { provider: row.provider, siteKey: row.siteKey, enabled: row.enabled },
  });
  return res.status();
}

test.describe("the bot challenge", () => {
  test("the engine stores the flag it was sent", async ({ request }) => {
    // The regression that started this file. It is asserted against the API
    // rather than the form because the form was innocent: it sent exactly what
    // it should and the engine dropped it.
    const before = await captchaRow(request);
    test.skip(before.configured !== true,
      "no secret stored on this deployment — nothing can be turned on");

    try {
      expect(await setCaptcha(request, { ...before, enabled: true }), "the PUT was accepted").toBe(200);
      const on = await captchaRow(request);
      // A JSON boolean, read back as a JSON boolean. The old engine answered
      // false here to a body that said true, which is the whole bug.
      expect(on.enabled, "true was stored as true").toBe(true);

      expect(await setCaptcha(request, { ...before, enabled: false })).toBe(200);
      expect((await captchaRow(request)).enabled, "and false as false").toBe(false);
    } finally {
      await setCaptcha(request, before);
    }
  });

  test("a challenge cannot be turned on with no site key", async ({ request }) => {
    // Half a challenge refuses everybody. The engine is what refuses this, not
    // the form, so that a script or a second console cannot do it either.
    const before = await captchaRow(request);
    try {
      const res = await request.put(`${API}/captcha`, {
        data: { provider: before.provider || "turnstile", siteKey: "", enabled: true },
      });
      expect(res.status(), "an empty site key with enabled is refused").toBe(400);
      expect((await captchaRow(request)).enabled,
        "and nothing was written on the way out").toBe(before.enabled);
    } finally {
      await setCaptcha(request, before);
    }
  });

  test("the site key is offered to the login form, and the secret never is",
    async ({ request, page }) => {
      test.setTimeout(180_000);
      const before = await captchaRow(request);
      test.skip(before.configured !== true || before.siteKey.trim() === "",
        "no challenge configured on this deployment");
      try {
        await setCaptcha(request, { ...before, enabled: true });
        await settle(page, true);
        const res = await page.request.get("/auth/providers");
        expect(res.status()).toBe(200);
        const body = await res.text();
        const config = JSON.parse(body) as { challenge: { provider: string; siteKey: string } | null };
        expect(config.challenge, "the challenge is offered").not.toBeNull();
        expect(config.challenge!.siteKey, "as the site key the operator set")
          .toBe(before.siteKey);
        // The one assertion that is about safety rather than about wiring: the
        // secret is stored encrypted and the console's server is the only
        // thing that ever reads it. If it ever appears here it is on every
        // login page of the deployment.
        expect(body, "and the secret is not in the reply").not.toContain("0x4AAAAAAA");
        expect(/secret/i.test(body), "no member called secret at all").toBeFalsy();
      } finally {
        await setCaptcha(request, before);
      }
    });

  test("both login surfaces draw the widget when it is on", async ({ request, page }) => {
    test.setTimeout(180_000);
    const before = await captchaRow(request);
    test.skip(before.configured !== true || before.siteKey.trim() === "",
      "no challenge configured on this deployment");
    try {
      await setCaptcha(request, { ...before, enabled: true });
      await settle(page, true);

      // 1. The standalone page. This is the half that was missing: the console
      // rendered its challenge and this page did not, so /auth/login posted
      // without a token and every sign-in from a link was refused.
      await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000);
      const onPage = await page.evaluate(() => ({
        script: [...document.querySelectorAll("script")]
          .some((s) => /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha/.test(s.src)),
        host: document.querySelector("[slot=challenge]") !== null,
      }));
      expect(onPage.script, "/auth/login loaded the provider's script").toBeTruthy();
      expect(onPage.host, "and parented a host for the widget").toBeTruthy();

      // 2. The console's own overlay, which a guest reaches from the header.
      await open(page);
      await ready(page);
      await page.evaluate(([src]) => {
        const el = (new Function("return " + src)())(".guest-signin") as HTMLElement | null;
        el?.click();
      }, [FIND]);
      await page.waitForTimeout(4000);
      // Through the shadow roots: the overlay is a child of the console's,
      // so a document-level query for it answers null however well the widget
      // rendered.
      const inApp = await page.evaluate(([src]) =>
        (new Function("return " + src)())("login-overlay [slot=challenge]").length > 0, [ALL]);
      expect(inApp, "the overlay parented one too").toBeTruthy();
    } finally {
      await setCaptcha(request, before);
    }
  });

  test("a sign-in with no token is refused, with a sentence rather than a status",
    async ({ request, page }) => {
      test.setTimeout(180_000);
      const before = await captchaRow(request);
      test.skip(before.configured !== true || before.siteKey.trim() === "",
        "no challenge configured on this deployment");
      test.skip(USER === "" || PASS === "", "put credentials in packages/agents/app/.env");
      try {
        await setCaptcha(request, { ...before, enabled: true });
        await settle(page, true);
        // The real password, so a rejection can only be the challenge. A wrong
        // password would prove nothing — it is refused either way.
        const res = await page.request.post("/__nk_auth/login", {
          headers: { "content-type": "application/json", accept: "application/json" },
          data: { email: USER, password: PASS },
          failOnStatusCode: false,
        });
        expect(res.status(), "refused").toBe(400);
        const said = (await res.json()) as { error?: string };
        // The card renders `error` verbatim, so this string is what a person
        // reads. A bare 400 would paint "HTTP 400" on the sign-in card.
        expect(said.error ?? "", "and said what to do about it").toMatch(/challenge/i);
      } finally {
        await setCaptcha(request, before);
      }
    });

  test("with the challenge off, the same sign-in works", async ({ request, page }) => {
    // The control. Without it the test above proves only that something
    // refuses a POST, not that the challenge is what refused it.
    test.setTimeout(180_000);
    test.skip(USER === "" || PASS === "", "put credentials in packages/agents/app/.env");
    const before = await captchaRow(request);
    try {
      await setCaptcha(request, { ...before, enabled: false });
      await settle(page, false);
      const res = await page.request.post("/__nk_auth/login", {
        headers: { "content-type": "application/json", accept: "application/json" },
        data: { email: USER, password: PASS },
        failOnStatusCode: false,
      });
      expect(res.status(), "accepted with no challenge in the way").toBeLessThan(400);
    } finally {
      await setCaptcha(request, before);
    }
  });

  test("the admin form saves the checkbox and shows it saved", async ({ request, page }) => {
    test.skip(USER === "" || PASS === "", "put credentials in packages/agents/app/.env");
    const before = await captchaRow(request);
    test.skip(before.configured !== true, "no secret stored — the engine will refuse enabled");

    await signIn(page);
    await page.goto("/admin/sign-in", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);

    try {
      // Tick it the way a person does, and press the form's own Save.
      await page.evaluate(([src]) => {
        const box = (new Function("return " + src)())("#cap-enabled") as
          (HTMLElement & { checked: boolean }) | null;
        if (box === null) { return; }
        box.checked = true;
        box.dispatchEvent(new CustomEvent("nr-change",
          { detail: { checked: true }, bubbles: true, composed: true }));
      }, [FIND]);
      await page.waitForTimeout(500);
      const pressed = await page.evaluate(([src]) => {
        const saves = ((new Function("return " + src)())("button.primary") as HTMLElement[])
          .filter((b) => /^\s*Save\s*$/i.test(b.textContent ?? ""));
        saves[saves.length - 1]?.click();
        return saves.length;
      }, [ALL]);
      // Asserted, because the first version of this clicked nothing: the Save
      // it looked for was behind a shadow root, `saves` was empty, and every
      // assertion after it described a page that had not been saved.
      expect(pressed, "a Save button was found and pressed").toBeGreaterThan(0);
      await page.waitForTimeout(4000);

      // Both halves, because either alone hid the bug: the row has to be
      // stored AND the form has to come back showing what was stored. It
      // returned unticked from a 200 for weeks.
      expect((await captchaRow(request)).enabled, "the engine holds it on").toBe(true);
      const shown = await page.evaluate(([src]) => {
        const box = (new Function("return " + src)())("#cap-enabled") as
          (HTMLElement & { checked: boolean }) | null;
        return box === null ? null : box.checked;
      }, [FIND]);
      expect(shown, "and the form still shows it ticked").toBe(true);
    } finally {
      await setCaptcha(request, before);
    }
  });
});

/** Sign in through the console's overlay, the way the other specs do. */
async function signIn(page: Page): Promise<void> {
  await open(page);
  await ready(page);
  await page.evaluate(([user, pass, src]) => {
    const find = new Function("return " + src)() as (s: string) => Element | null;
    (find(".guest-signin") as HTMLElement | null)?.click();
    window.setTimeout(() => {
      const set = (el: Element | null, v: string) => {
        if (el === null) { return; }
        (el as HTMLInputElement).value = v;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      };
      set(find("input[type=email]"), user);
      set(find("input[type=password]"), pass);
      const overlay = find("login-overlay") as (Element & { shadowRoot: ShadowRoot | null }) | null;
      const root = overlay?.shadowRoot ?? document;
      const go = [...root.querySelectorAll("button, nr-button")]
        .find((b) => /sign in|continue|log in/i.test(b.textContent ?? ""));
      (go as HTMLElement | undefined)?.click();
    }, 1000);
  }, [USER, PASS, FIND]);
  await page.waitForTimeout(7000);
}

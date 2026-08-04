// Every screen, opened once.
//
// Not a replacement for the specs that drive a feature — it asserts almost
// nothing about behaviour. What it catches is the class of failure those specs
// cannot: a screen that throws while rendering, a route the gateway does not
// serve, a tab whose module fails to import, an icon name that resolves to no
// glyph. All of those look like a working deployment from every other angle,
// because the thing that broke is the one screen nobody opened today.
//
// It earns its place from experience: a stray backtick inside a `css` comment
// compiles cleanly and throws at import, and took down every /admin tab at
// once while the site answered 200 and the chat worked perfectly.
//
//   CONSOLE_URL=https://joule.sh npx playwright test e2e/screens.spec.ts
//
// Signed-in screens need credentials — packages/agents/app/.env, the same ones
// signin.spec.ts uses. Without them the admin sweep skips and the public
// screens still run.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { open, ready } from "./console.js";

const USER = process.env.JOULE_TEST_USER ?? "";
const PASS = process.env.JOULE_TEST_PASS ?? "";

/** The admin tabs, as their routes. Taken from the zone list in settings.ts —
 *  if a tab is added there and not here, this file is the reminder. */
const ADMIN = [
  "models", "model-menu", "providers", "mcp", "images",
  "search", "sign-in", "tracing", "banner",
];

/** The surfaces the rail opens, and the element each one is only open when it
 *  has mounted. A node count cannot stand in for these: the console paints
 *  hundreds of nodes with nothing open at all. */
const OPENS: Record<string, string> = {
  knowledge: "knowledge-page",
  agents: ".gallery",
  connectors: ".gallery",
  starts: ".starts-page",
};
const RAIL = Object.keys(OPENS);

/** Errors a browser logs that say nothing about this console. */
function ours(text: string): boolean {
  if (/Cross-Origin-Opener-Policy/i.test(text)) { return false; }
  // A favicon or a source map that 404s is not a broken screen.
  if (/favicon|\.map\b/i.test(text)) { return false; }
  return true;
}

/** Watch a page for the failures that do not show up as a bad status. */
function watch(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && ours(m.text())) { errors.push(m.text().slice(0, 200)); }
  });
  return { errors };
}

/** Whether a named element exists anywhere, through shadow roots. */
async function has(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const find = (root: ParentNode, depth = 0): Element | null => {
      if (depth > 14) { return null; }
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(sel)) { return el; }
        if (el.shadowRoot !== null) {
          const hit = find(el.shadowRoot, depth + 1);
          if (hit !== null) { return hit; }
        }
      }
      return null;
    };
    return find(document) !== null;
  }, selector);
}

/** Whether anything was actually painted, reaching through shadow roots. */
async function painted(page: Page): Promise<number> {
  return page.evaluate(() => {
    const count = (root: ParentNode, depth = 0): number => {
      if (depth > 12) { return 0; }
      let n = 0;
      for (const el of root.querySelectorAll("*")) {
        n += 1;
        if (el.shadowRoot !== null) { n += count(el.shadowRoot, depth + 1); }
      }
      return n;
    };
    return count(document);
  });
}

/** Icon names that drew no glyph. `nr-icon` renders the NAME as text when it
 *  has no path for it, so a wrong name is a word sitting where a picture
 *  should be — visible to a person, invisible to every other assertion. */
async function blankIcons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walk = (root: ParentNode, depth = 0): void => {
      if (depth > 12) { return; }
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName === "NR-ICON" && el.shadowRoot !== null
            && el.shadowRoot.querySelector("svg") === null
            && (el as HTMLElement).offsetParent !== null) {
          out.push(el.getAttribute("name") ?? "(unnamed)");
        }
        if (el.shadowRoot !== null) { walk(el.shadowRoot, depth + 1); }
      }
    };
    walk(document);
    return [...new Set(out)];
  });
}

async function signIn(page: Page): Promise<void> {
  await page.evaluate(({ user, pass }) => {
    const find = (sel: string, root: ParentNode = document, depth = 0): Element | null => {
      if (depth > 16) { return null; }
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(sel)) { return el; }
        if (el.shadowRoot !== null) {
          const hit = find(sel, el.shadowRoot, depth + 1);
          if (hit !== null) { return hit; }
        }
      }
      return null;
    };
    const opener = find(".guest-signin") as HTMLElement | null;
    if (opener === null) { return; }
    opener.click();
    window.setTimeout(() => {
      const set = (el: Element | null, v: string) => {
        if (el === null) { return; }
        (el as HTMLInputElement).value = v;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      };
      set(find("input[type=email]"), user);
      set(find("input[type=password]"), pass);
      const overlay = find("login-overlay");
      const root = (overlay as Element & { shadowRoot: ShadowRoot | null })?.shadowRoot ?? document;
      const go = [...root.querySelectorAll("button, nr-button")]
        .find((b) => /sign in|continue|log in/i.test(b.textContent ?? ""));
      (go as HTMLElement | undefined)?.click();
    }, 1000);
  }, { user: USER, pass: PASS });
  await page.waitForTimeout(6000);
}

test("the screens a visitor can reach render", async ({ page }) => {
  const seen = watch(page);
  await open(page);
  await ready(page);
  expect(await painted(page), "the console painted").toBeGreaterThan(40);
  expect(await blankIcons(page), "every icon drew a glyph").toEqual([]);
  expect(seen.errors, "nothing threw").toEqual([]);
});

test("the public stats page renders", async ({ page }) => {
  const seen = watch(page);
  const answer = await page.goto("/stats", { waitUntil: "domcontentloaded" });
  expect(answer?.status(), "/stats answers").toBeLessThan(400);
  await page.waitForTimeout(4000);
  expect(await painted(page), "it painted").toBeGreaterThan(40);
  expect(seen.errors, "nothing threw").toEqual([]);
});

test("the sign-in and sign-up pages render", async ({ page }) => {
  for (const path of ["/auth/login", "/auth/signup"]) {
    const seen = watch(page);
    const answer = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(answer?.status(), `${path} answers`).toBeLessThan(400);
    await page.waitForTimeout(2500);
    expect(await painted(page), `${path} painted`).toBeGreaterThan(20);
    expect(seen.errors, `${path} threw nothing`).toEqual([]);
  }
});

test("every surface the rail opens renders", async ({ page }) => {
  test.skip(USER === "" || PASS === "", "put credentials in packages/agents/app/.env");
  const seen = watch(page);
  await open(page);
  await ready(page);
  await signIn(page);

  for (const nav of RAIL) {
    await page.evaluate((which) => {
      const find = (sel: string, root: ParentNode = document, depth = 0): Element | null => {
        if (depth > 16) { return null; }
        for (const el of root.querySelectorAll("*")) {
          if (el.matches(sel)) { return el; }
          if (el.shadowRoot !== null) {
            const hit = find(sel, el.shadowRoot, depth + 1);
            if (hit !== null) { return hit; }
          }
        }
        return null;
      };
      (find(`[data-nav="${which}"]`) as HTMLElement | null)?.click();
    }, nav);
    await page.waitForTimeout(2500);
    // Something has to have OPENED. The console paints hundreds of nodes with
    // nothing open at all, so a node count cannot tell a working rail row from
    // a dead one.
    // What each row actually opens, taken from the locators e2e/console.ts
    // already uses rather than guessed. The first version guessed
    // `console-knowledge`, which does not exist — the element is
    // `knowledge-page` — and the assertion failed for the right reason.
    expect(await has(page, OPENS[nav]), `${nav} opened ${OPENS[nav]}`).toBeTruthy();
    expect(await blankIcons(page), `${nav} drew every icon`).toEqual([]);
    // Close whatever opened, so the next one starts from the same place.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }
  expect(seen.errors, "nothing threw across the rail").toEqual([]);
});

test("every admin tab renders", async ({ page }) => {
  test.skip(USER === "" || PASS === "", "put credentials in packages/agents/app/.env");
  await open(page);
  await ready(page);
  await signIn(page);

  const broke: string[] = [];
  for (const tab of ADMIN) {
    const seen = watch(page);
    const answer = await page.goto(`/admin/${tab}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const drew = await painted(page);
    const blank = await blankIcons(page);
    // Collected rather than asserted one at a time: one broken tab should not
    // hide the state of the eight after it, which is the whole point of a
    // sweep.
    // Still ON the tab, and the settings element actually mounted.
    //
    // Node count alone is not evidence: an anonymous visitor asking for
    // /admin/models is redirected to "/" and paints 428 nodes of perfectly
    // good console — so this sweep passed green while proving nothing about
    // the nine tabs it claimed to have opened.
    const where = new URL(page.url()).pathname;
    const mounted = await has(page, "console-settings");
    if ((answer?.status() ?? 500) >= 400) { broke.push(`${tab}: HTTP ${answer?.status()}`); }
    else if (!where.startsWith(`/admin/${tab}`)) { broke.push(`${tab}: bounced to ${where} — not signed in?`); }
    else if (!mounted) { broke.push(`${tab}: no console-settings mounted`); }
    else if (drew < 40) { broke.push(`${tab}: painted ${drew} nodes`); }
    else if (blank.length > 0) { broke.push(`${tab}: icons drew no glyph — ${blank.join(", ")}`); }
    else if (seen.errors.length > 0) { broke.push(`${tab}: ${seen.errors[0]}`); }
  }
  expect(broke, "every admin tab rendered").toEqual([]);
});

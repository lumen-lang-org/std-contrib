// The way in, for somebody who is not signed in.
//
// A deployment that admits guests has a harder job here than one that does
// not: nothing is broken for a visitor who never signs in, so a sign-in that
// has quietly stopped working looks exactly like a sign-in nobody wanted. The
// only thing that catches it is driving it.
//
// It runs against a deployment that offers guests — joule.sh does — and skips
// itself anywhere else rather than failing, the same shape as auth.spec.ts.
//
//   JOULE_TEST_USER=… JOULE_TEST_PASS=… \
//     CONSOLE_URL=https://joule.sh npx playwright test e2e/signin.spec.ts
//
// The credentials live in `packages/agents/app/.env`, which is gitignored, and
// this file reads them from the environment. They are deliberately not written
// down here: this repository is PUBLIC (lumen-lang-org/std-contrib), so a
// password in this file is a password anyone can read and use.
//
// playwright.config.ts loads that .env before the suite runs, so `npx
// playwright test e2e/signin.spec.ts` works with no exports of your own.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { open, ready } from "./console.js";

const USER = process.env.JOULE_TEST_USER ?? "";
const PASS = process.env.JOULE_TEST_PASS ?? "";

/** Reach through open shadow roots for one element.
 *
 *  Playwright's own selectors pierce shadow DOM for CSS, but the checks here
 *  are about what a person can SEE — and `body.innerText` stops at the first
 *  shadow boundary, which is how this suite first reported that joule.sh shows
 *  no sign-in at all. It shows one; the reading was wrong. */
async function deep(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const find = (root: ParentNode, depth = 0): Element | null => {
      if (depth > 16) { return null; }
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

async function deepText(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const find = (root: ParentNode, depth = 0): Element | null => {
      if (depth > 16) { return null; }
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(sel)) { return el; }
        if (el.shadowRoot !== null) {
          const hit = find(el.shadowRoot, depth + 1);
          if (hit !== null) { return hit; }
        }
      }
      return null;
    };
    return find(document)?.textContent?.trim() ?? "";
  }, selector);
}

test("a guest is offered a way in", async ({ page }) => {
  await open(page);
  await ready(page);
  test.skip(!(await deep(page, ".guest-strip")), "this deployment does not admit guests");

  // The offer has to be on the screen, not only in a menu two levels down: a
  // visitor who has to find it will not.
  expect(await deep(page, ".guest-signin"), "the header offers Sign in").toBeTruthy();
  expect(await deepText(page, ".who"), "and says who you currently are").toBe("Guest");
});

test("pressing it opens somewhere to type", async ({ page }) => {
  await open(page);
  await ready(page);
  test.skip(!(await deep(page, ".guest-strip")), "this deployment does not admit guests");

  await page.evaluate(() => {
    const find = (root: ParentNode, depth = 0): Element | null => {
      if (depth > 16) { return null; }
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(".guest-signin")) { return el; }
        if (el.shadowRoot !== null) {
          const hit = find(el.shadowRoot, depth + 1);
          if (hit !== null) { return hit; }
        }
      }
      return null;
    };
    (find(document) as HTMLElement | null)?.click();
  });
  await page.waitForTimeout(2000);

  expect(await deep(page, "login-overlay"), "the overlay opens").toBeTruthy();
  expect(await deep(page, "input[type=email]"), "with an email field").toBeTruthy();
  expect(await deep(page, "input[type=password]"), "and a password field").toBeTruthy();
});

test("signing in stops you being a guest", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  await open(page);
  await ready(page);
  test.skip(!(await deep(page, ".guest-strip")), "this deployment does not admit guests");

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
    (find(".guest-signin") as HTMLElement | null)?.click();
    // The fields are LumenUI components: the value goes on the element and the
    // component learns about it the same way it learns about typing.
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
    }, 1200);
  }, { user: USER, pass: PASS });

  // The whole of the assertion: the footer stops saying Guest and the ration
  // strip goes. Either alone can be true while the sign-in half-worked.
  await expect.poll(async () => deepText(page, ".who"), { timeout: 25000 })
    .not.toBe("Guest");
  expect(await deep(page, ".guest-strip"), "the guest ration is gone").toBeFalsy();
  expect(await deep(page, "login-overlay"), "and the overlay closed itself").toBeFalsy();
});

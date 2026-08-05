// Getting a spec signed in and talking, against a real deployment.
//
// Shared by the recorded-conversation specs: the builtin login driven the way
// a person drives it, and the composer found where it lives. Kept apart from
// record.ts, which is about watching a page rather than being somebody on it.
//
// The credentials come from packages/agents/app/.env (JOULE_TEST_USER /
// JOULE_TEST_PASS), which is gitignored — this repository is public. Specs
// skip rather than fail when they are absent.

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { Report, Turn, codeBlocks, deepText, drain, lastAnswer, probe } from "./record.js";
import { ready } from "./console.js";

export const USER = process.env.JOULE_TEST_USER ?? "";
export const PASS = process.env.JOULE_TEST_PASS ?? "";

export function composer(page: Page): Locator {
  return page.locator('agent-console nr-chatbot [contenteditable="true"]').first();
}

/** Sign in through the overlay, the way a person does. The fields are LumenUI
 *  components, so the value is set on the element and announced the way typing
 *  would announce it — the dance signin.spec.ts proved. Returns false when the
 *  deployment offers no way in, which is the caller's cue to skip. */
export async function signIn(page: Page): Promise<boolean> {
  const offered = await page.evaluate(() => {
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
    const way = find(".guest-signin") as HTMLElement | null;
    way?.click();
    return way !== null;
  });
  if (!offered) { return false; }

  await page.waitForTimeout(1200);
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
  }, { user: USER, pass: PASS });

  // Longer than it used to be, and retried once, because signing in is no
  // longer just a POST: the deployment gates the form with a bot challenge,
  // whose widget has to load from its own origin and issue a token before the
  // credentials go anywhere. A headless browser gets through it, and takes a
  // variable few seconds to do so — 25s was enough on some runs and not
  // others, which showed up as one test in three failing on "Guest" while the
  // other two signed in fine. A flaky sign-in reads as a broken feature in
  // whichever spec drew the short straw.
  const landed = async (ms: number) =>
    await expect.poll(() => deepText(page, ".who"), { timeout: ms })
      .not.toBe("Guest").then(() => true, () => false);

  if (await landed(45000)) { return true; }

  // One more press. A challenge that expired between load and submit refuses
  // the first attempt and passes the second; pressing again is what a person
  // does, and it is the difference between a spec that is flaky and one that
  // reports a real failure.
  await page.evaluate(() => {
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
    const overlay = find("login-overlay");
    const root = (overlay as Element & { shadowRoot: ShadowRoot | null })?.shadowRoot ?? document;
    const go = [...root.querySelectorAll("button, nr-button")]
      .find((b) => /sign in|continue|log in/i.test(b.textContent ?? ""));
    (go as HTMLElement | undefined)?.click();
  });
  await expect.poll(() => deepText(page, ".who"), { timeout: 45000 }).not.toBe("Guest");
  return true;
}

/** Signed in if the deployment wants that; true when the page is usable. */
export async function beSomebody(page: Page): Promise<boolean> {
  const who = await deepText(page, ".who");
  if (who !== "Guest") { return true; }
  return await signIn(page);
}

/** Pick a model from the composer's picker by its menu label, the way a
 *  person does: open the trigger, press the row. */
export async function pickModel(page: Page, label: string): Promise<void> {
  const picker = page.locator("agent-console model-picker");
  await picker.locator("button.trigger").click();
  await picker.locator("button.row", { hasText: label }).first().click();
}

/** Send one line and wait for the answer to finish arriving.
 *
 *  Finished means all three at once: one more finished assistant message than
 *  before, no loading skeleton, a newest bot message that actually says
 *  something, and a transcript that held still for four seconds. The first
 *  draft waited on stillness alone and declared turns done while the model
 *  was still thinking — a page showing "Agent is working..." holds perfectly
 *  still; and the bot count alone is not an answer either, because the turn
 *  hangs its card on an empty placeholder message the moment it starts.
 *  Three-minute ceiling; a turn slower than that is a finding, not a wait. */
export async function converse(page: Page, report: Report, said: string): Promise<void> {
  await drain(page); // discard samples that belong to no turn
  const before = await probe(page);

  await composer(page).click();
  await composer(page).pressSequentially(said);
  const t0 = Date.now();
  await composer(page).press("Enter");

  let last = -1, still = 0;
  await expect.poll(async () => {
    const now = await probe(page);
    const settled = now.bots > before.bots && !now.busy
      && (await lastAnswer(page)) !== "";
    if (settled && now.total === last) { still += 1; } else { still = 0; }
    last = now.total;
    return still;
  }, { timeout: 180_000, intervals: [1000] }).toBeGreaterThanOrEqual(4);

  const flow = await drain(page);
  report.turns.push({
    said,
    ms: Date.now() - t0,
    samples: flow.samples,
    status: flow.status,
    answer: (await lastAnswer(page)).slice(0, 500),
    code: await codeBlocks(page),
  } satisfies Turn);
}

/** Get into the console, whichever door this deployment leaves open.
 *
 *  `open()` assumes a visitor is admitted, and on joule.sh that is true until
 *  it is not: guests are minted per address per day, and a machine that has run
 *  this suite a few times is sent to `/auth/login` instead of the console — at
 *  which point every spec fails on "agent-console not found", which reads as a
 *  broken deployment rather than as a spent allowance.
 *
 *  So: land, and if the door is the login page, sign in there rather than
 *  through the overlay a guest gets. False means there are no credentials to
 *  try, which is the caller's cue to skip. */
export async function enterConsole(page: Page, path = "/"): Promise<boolean> {
  await page.goto(path);
  if (!page.url().includes("/auth/login")) {
    await ready(page);
    if (!(await beSomebody(page))) { return false; }
    // Signing in through the overlay reloads the console so it can ask
    // /whoami again; arriving afterwards is what makes the next click land on
    // the page it was aimed at.
    await page.goto(path);
    await ready(page);
    return true;
  }
  if (USER === "" || PASS === "") { return false; }

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
    const set = (el: Element | null, v: string) => {
      if (el === null) { return; }
      (el as HTMLInputElement).value = v;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    set(find("input[type=email]"), user);
    set(find("input[type=password]"), pass);
  }, { user: USER, pass: PASS });

  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const every = (root: ParentNode = document, depth = 0, out: Element[] = []): Element[] => {
      if (depth > 16) { return out; }
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot !== null) { every(el.shadowRoot, depth + 1, out); }
      }
      return out;
    };
    const go = every().find((el) => /^(button|nr-button)$/i.test(el.tagName)
      && /sign in|continue|log in/i.test(el.textContent ?? ""));
    (go as HTMLElement | undefined)?.click();
  });

  // Asked rather than waited for, and that is not fussiness: the form does not
  // always navigate on success — it can set the session and leave the browser
  // where it is — so a waitForURL sits out its whole timeout on a sign-in that
  // worked. What is true either way is that the address stops answering with
  // the login page, so that is what is polled. The pause between tries is the
  // bot challenge, which has to load and issue a token before the credentials
  // go anywhere.
  for (let tries = 0; tries < 9; tries += 1) {
    await page.waitForTimeout(5000);
    await page.goto(path);
    if (!page.url().includes("/auth/login")) {
      await ready(page);
      return true;
    }
  }
  // Credentials were offered and did not get in. A skip here would report as a
  // deployment with no login rather than as a login that is broken.
  expect(page.url()).not.toContain("/auth/login");
  return true;
}

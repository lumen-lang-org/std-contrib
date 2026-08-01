// The AUTH tri-state, seen from a browser.
//
// Phase 4's claim is that one console serves three deployments and the console
// itself never learns which one it is in — so these tests assert the
// deployment's behaviour, not the mode's name. Nothing here reads
// `process.env.AUTH`, imports the middleware, or checks a flag: it visits the
// console the way a person does and reads what happens.
//
// Every test skips itself on a server that is not in the mode it is about, the
// same judgement e2e/live.spec.ts makes about a server with no socket. Point
// it at a builtin console to prove the builtin half:
//
//   AUTH=builtin AUTH_SESSION_SECRET=... AUTH_BUILTIN_ADMINS=you@example.com \
//     npx lumenjs dev --port 5174
//   CONSOLE_URL=http://127.0.0.1:5174 npx playwright test e2e/auth.spec.ts
//
// Against `npm run dev`, which is `AUTH=none`, all of these skip and the file
// proves nothing while passing — which is why the lines above are in the file.

import { expect, test, type Page } from "@playwright/test";
import { shell, sidebar } from "./console.js";

/** A different account per run, so the suite never depends on a row a previous
 *  run left behind and never has to delete one. There is no "unregister"
 *  route, so a fixed address would make the first run and the tenth run
 *  different tests — and app/CLAUDE.md's rule is that a fixture may not cost
 *  more than it proves. */
const who = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.test`;
const PASSWORD = "an-adequately-long-passphrase";

/** Whether this console holds its own users.
 *
 *  Asked of the front door rather than of the configuration: a `builtin`
 *  server sends a signed-out visitor to its own sign-in card, and neither of
 *  the other two modes has a card to send them to. `none` renders the console;
 *  `proxy` behind its gateway never sees a signed-out visitor at all. */
async function isBuiltin(page: Page): Promise<boolean> {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  return new URL(page.url()).pathname === "/auth/login";
}

/** The card. Its own page element, so one locator reaches all of it. */
const card = (page: Page) => page.locator("page-auth-login, page-auth-signup");

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/auth/signup");
  const form = card(page);
  await expect(form.locator(".card")).toBeVisible();
  // `#a-email input` reaches inside the LumenUI field — Playwright pierces
  // open shadow roots for CSS (app/CLAUDE.md).
  await form.locator("#a-email input").fill(email);
  await form.locator("#a-password input").fill(PASSWORD);
  await form.locator("#a-submit").click();
}

test("a signed-out visitor is sent to the sign-in card, not to an empty console", async ({ page }) => {
  test.skip(!(await isBuiltin(page)), "this console does not hold its own users");

  // The bug this replaces is worth naming: without the redirect the console
  // draws its whole shell to a logged-out visitor and every region reports
  // nothing — a product that looks like it is working and looks empty.
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2F$/);
  await expect(card(page).locator("h1")).toHaveText("Sign in");
  await expect(shell(page)).toHaveCount(0);
});

test("signing up reaches the console, and the rail knows who you are", async ({ page }) => {
  test.skip(!(await isBuiltin(page)), "this console does not hold its own users");

  const email = who();
  await signUp(page, email);

  await expect(shell(page)).toBeVisible();
  // The console asked `/whoami` and got an answer — which is the whole test of
  // the middleware's document shape, read off the pixels rather than off the
  // response. `name()` in src/sidebar.ts shows the part before the @.
  await expect(sidebar(page).locator(".who")).toHaveText(email.split("@")[0]);
});

test("a wrong password is refused and says so", async ({ page }) => {
  test.skip(!(await isBuiltin(page)), "this console does not hold its own users");

  const email = who();
  await signUp(page, email);
  await expect(shell(page)).toBeVisible();

  await page.goto("/logout");
  await page.goto("/auth/login");
  const form = card(page);
  await form.locator("#a-email input").fill(email);
  await form.locator("#a-password input").fill("not-the-password");
  await form.locator("#a-submit").click();

  // Assert on text, never on emptiness: `toBeEmpty()` reads light-DOM children
  // and answers "empty" for anything that renders into a shadow root
  // (app/CLAUDE.md).
  await expect(form.locator("#a-error")).toHaveText(/Invalid credentials/);
  await expect(shell(page)).toHaveCount(0);
});

test("signing out from the rail ends the session", async ({ page }) => {
  test.skip(!(await isBuiltin(page)), "this console does not hold its own users");

  await signUp(page, who());
  await expect(shell(page)).toBeVisible();

  // The rail's own control, at the path src/sidebar.ts writes — `/logout`,
  // which the gateway answers in the deployment that file was written for and
  // pages/_middleware.ts aliases here. Driving the menu rather than the URL is
  // what makes this a test of the seam.
  await sidebar(page).locator(".me").click();
  await sidebar(page).locator(".menu div", { hasText: "Sign out" }).click();

  await expect(page).toHaveURL(/\/auth\/login$/);
  // And the session is actually gone, not just navigated away from.
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth\/login/);
});

test("a crafted returnTo is not a way off-site", async ({ page }, testInfo) => {
  test.skip(!(await isBuiltin(page)), "this console does not hold its own users");

  // `//elsewhere/` is a protocol-relative URL, which is what makes this worth
  // a test: it starts with a slash, so a naive "is it a path" check passes it
  // and a freshly signed-in browser lands on somebody else's site. Dropped on
  // the client side because that is the side that calls `location.assign`; the
  // framework's `safeReturnTo` drops it again on the POST.
  //
  // A hostname with no dot in it, and that is not squeamishness about naming
  // example.com: `lumenjs dev` tests `req.url.includes('.')` against the whole
  // URL, query string included, when deciding whether a request is for a page
  // — so any page URL carrying a dot anywhere in its query 404s. Upstream
  // defect, dev only, recorded in MIGRATION-LUMENJS.md. `//elsewhere/` is the
  // same protocol-relative shape and exercises the same branch.
  await page.goto("/auth/signup?returnTo=//elsewhere/");
  const form = card(page);
  await form.locator("#a-email input").fill(who());
  await form.locator("#a-password input").fill(PASSWORD);
  await form.locator("#a-submit").click();

  await expect(shell(page)).toBeVisible();
  const landed = new URL(page.url());
  expect(landed.origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
  expect(landed.pathname).toBe("/");
});

test("the engine is never asked a question on behalf of nobody", async ({ page }) => {
  test.skip(!(await isBuiltin(page)), "this console does not hold its own users");

  // The security half, said as a network assertion: a signed-out browser's
  // `/api` call is refused here and never forwarded. With the engine's trust
  // gate on, a forwarded call with no X-USER is the unowned tag — every row
  // that predates ownership — so "proxied headerless" and "refused" are not
  // two spellings of the same outcome.
  const refused = await page.request.get("/api/threads?limit=1", {
    headers: { accept: "application/json" },
  });
  expect(refused.status()).toBe(401);

  // And the header a browser sends for itself is not the one that goes
  // upstream: this request claims to be someone and is still refused.
  const forged = await page.request.get("/api/threads?limit=1", {
    headers: { accept: "application/json", "x-user": '{"uuid":"somebody-else"}' },
  });
  expect(forged.status()).toBe(401);
});

test("an ordinary user cannot rewrite the menu everybody picks from", async ({ page }) => {
  test.skip(!(await isBuiltin(page)), "this console does not hold its own users");

  // A fresh account, which is every account: `registerUser` gives out no roles
  // and there is no screen that grants one, so this is what a signed-in
  // non-operator is.
  await signUp(page, who());
  await expect(shell(page)).toBeVisible();

  // The configuration routes carry no engine-side authorisation by design
  // (GATEWAY.md, "the accepted gap"), and nuraly.io's one location
  // authenticates without checking a role — so before this guard existed, a
  // signed-in user could insert a menu row at rank 0 and lead everybody else's
  // composer with it, or repoint the router at the most expensive candidate.
  const inserted = await page.request.post("/api/model-choices", {
    headers: { accept: "application/json" },
    data: { id: "e2e-not-allowed", label: "Free GPUs", kind: "config", configId: "c-double" },
  });
  expect(inserted.status()).toBe(403);

  const repointed = await page.request.put("/api/model-routers/rt-menu", {
    headers: { accept: "application/json" },
    data: { id: "rt-menu", enabled: false },
  });
  expect(repointed.status()).toBe(403);

  const keyed = await page.request.put("/api/providers/anthropic/key", {
    headers: { accept: "application/json" },
    data: { apiKey: "not-a-real-key" },
  });
  expect(keyed.status()).toBe(403);

  // Reading is untouched, and has to be: this is the list the composer draws
  // its picker from, for everybody.
  const menu = await page.request.get("/api/models/choices", {
    headers: { accept: "application/json" },
  });
  expect(menu.status()).toBe(200);
});

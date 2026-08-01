// The chat pane, driven the way a person drives it.
//
// Every other spec here checks that the pane renders. None of them ever sent a
// message — which is how the composer sat dead through fifty-odd passing
// tests: nr-chatbot needs a controller attached, and without one Enter logs a
// warning and returns. These tests type into the real composer and watch for
// the request.

import { expect, test } from "@playwright/test";
import { open, shell } from "./console.js";

// The composer is a contenteditable div, not a textarea — worth naming once
// rather than rediscovering per test.
function composer(page: import("@playwright/test").Page) {
  return page.locator('agent-console nr-chatbot [contenteditable="true"]').first();
}

test.beforeEach(async ({ page }) => {
  await open(page);
  await expect(shell(page)).toBeVisible();
});

test("typing a message and pressing Enter reaches the API", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/threads")) calls.push(`${r.method()} ${u.pathname}`);
  });

  await composer(page).click();
  await composer(page).type("what can you do?");
  await composer(page).press("Enter");

  // A conversation is opened lazily on the first message, then the turn is
  // posted to it. Both are the point: neither happened before.
  await expect
    .poll(() => calls.filter((c) => c.startsWith("POST")).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  expect(calls.some((c) => c === "POST /api/threads")).toBeTruthy();
  expect(calls.some((c) => /^POST \/api\/threads\/.+\/messages$/.test(c))).toBeTruthy();
});

test("what was typed appears in the transcript", async ({ page }) => {
  const said = `ping ${Date.now()}`;
  await composer(page).click();
  await composer(page).type(said);
  await composer(page).press("Enter");

  await expect(page.locator("agent-console nr-chatbot")).toContainText(said, { timeout: 20_000 });
});

test("whatever the API answered is what the transcript shows", async ({ page }) => {
  // No credential is configured for the seeded chat model, so the API refuses
  // in a sentence. A refusal is an answer: it belongs in the transcript where
  // it can be read, not swallowed into an empty pane.
  //
  // The assertion is against the API's own words rather than a guess at them,
  // so it holds whether the model replies or declines.
  let answered = "";
  page.on("response", async (r) => {
    if (!/\/api\/threads\/.+\/messages$/.test(new URL(r.url()).pathname)) return;
    try {
      const body = await r.json() as { ok: boolean; text: string; error: string };
      answered = body.ok ? body.text : body.error;
    } catch { /* not the JSON we were after */ }
  });

  await composer(page).click();
  await composer(page).type("hello");
  await composer(page).press("Enter");

  await expect.poll(() => answered, { timeout: 30_000 }).not.toBe("");
  // Not toBeEmpty: that reads light-DOM children, and this component renders
  // into a shadow root — so it answers "empty" however much is on screen.
  await expect(page.locator("agent-console nr-chatbot"))
    .toContainText(answered.slice(0, 40), { timeout: 20_000 });
  // And the composer is usable again rather than stuck mid-send.
  await expect(composer(page)).toBeVisible();
});

test("an empty message is not sent", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/threads")) calls.push(r.method());
  });

  await composer(page).click();
  await composer(page).press("Enter");
  await page.waitForTimeout(1500);

  expect(calls.filter((c) => c === "POST")).toHaveLength(0);
});

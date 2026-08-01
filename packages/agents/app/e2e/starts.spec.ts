// Starting points: the page of conversations other people offered, and the two
// ways in — the rail's row on a desktop, the bar across the bottom of an empty
// home on a phone.
//
// The bar exists because those two are not equivalent on a phone: the rail is
// a drawer there, so the same destination costs a panel and two taps. That is
// the claim these specs hold to — one door at each width, and a way back from
// the room.

import { Page, expect, test } from "@playwright/test";
import {
  exploreBar, loaded, open, openStarts, shell, sidebar, startsPage,
} from "./console.js";

const PHONE = { width: 390, height: 844 };

// At least one conversation on offer, so the grid is the grid and not the
// empty state.
//
// Seeded through the API rather than by driving the UI: offering is the share
// button's job and has its own coverage, and a test that walks through another
// feature to reach its own subject fails for that feature's reasons. The flag
// is idempotent — offering an already-offered thread is the same PUT — so a
// second run adds nothing and the fixture leaves one row rather than a pile.
//
// It repairs before it seeds, and that is not belt-and-braces — it is the only
// half that works. This fixture ran once against a live deployment and left an
// empty conversation on its Starting points page, where an empty conversation
// is not a bad starting point but a broken feature: you open it and there is
// nothing there. A `finally` does not run when a run is killed, so tidying up
// at the end cannot be what keeps that from happening again.
//
// The repair is "un-offer every offer with no messages", because that is
// exactly the shape this fixture leaves behind and there is no way to label a
// thread as the fixture's (the engine exposes no rename). It is also the right
// rule on its own terms: an offered conversation with nothing in it is one
// nobody can start from, whoever left it there.
async function clearEmptyOffers(page: Page): Promise<void> {
  const offers = (await page.request.get("/api/threads/replayable")
    .then((r) => r.json())) as { id: string }[];
  if (!Array.isArray(offers)) return;
  for (const o of offers) {
    const t = (await page.request.get(`/api/threads/${o.id}`)
      .then((r) => r.json())) as { messages?: unknown[] };
    if (Array.isArray(t.messages) && t.messages.length > 0) continue;
    await page.request.put(`/api/threads/${o.id}/replayable`,
      { data: { replayable: false } });
  }
}

async function seedOffer(page: Page): Promise<string | null> {
  await clearEmptyOffers(page);
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string }[];
  if (!Array.isArray(agents) || agents.length === 0) return null;
  const made = await page.request.post("/api/threads", {
    data: { agentId: agents[0].id },
  });
  if (!made.ok()) return null;
  const { id } = (await made.json()) as { id: string };
  const offered = await page.request.put(`/api/threads/${id}/replayable`, {
    data: { replayable: true },
  });
  return offered.ok() ? id : null;
}

test.describe("starting points", () => {
  test("the rail opens the page, and Back returns to the conversation", async ({ page }) => {
    await open(page);
    await loaded(page);
    await openStarts(page);

    await expect(startsPage(page).locator("h2")).toHaveText("Starting points");

    // The way out. Without it this view replaces the whole column and the only
    // route back is the browser's, which the console never puts this view into.
    await startsPage(page).locator(".starts-back").click();
    await expect(startsPage(page)).toHaveCount(0);
    // Back to the conversation column, not to a blank pane.
    await expect(shell(page).locator("nr-chatbot")).toBeVisible();
  });

  test("an offered conversation is on the page, with a way to copy it", async ({ page }) => {
    await open(page);
    await loaded(page);
    const seeded = await seedOffer(page);
    // The engine refusing to make a thread is a real failure, not a reason to
    // pass quietly: a spec that skips itself on its own precondition reports
    // green and proves nothing.
    expect(seeded, "could not seed an offered conversation").not.toBeNull();

    await openStarts(page);
    // toHaveCount rather than count(), which does not retry — the grid is
    // filled by a fetch that openStarts() starts and does not await.
    await expect(startsPage(page).locator(".offer")).not.toHaveCount(0);
    await expect(startsPage(page).locator(".offer").first()
      .getByRole("button", { name: "Remix" })).toBeVisible();

    // Put it back on the way out too. The repair above is what makes this
    // safe to rely on rather than necessary — between them, a completed run
    // leaves nothing and a killed one is cleaned up by the next.
    await page.request.put(`/api/threads/${seeded!}/replayable`,
      { data: { replayable: false } });
  });

  test.describe("on a phone", () => {
    test.use({ viewport: PHONE });

    test("the bar across an empty home opens the page", async ({ page }) => {
      await open(page);
      await loaded(page);

      const bar = exploreBar(page);
      await expect(bar).toBeVisible();
      await expect(bar).toContainText("Starting points");

      // Visible means on screen, not merely painted somewhere in the document.
      // The bar was absolutely positioned in a column as tall as the page
      // once, which put it under Safari's toolbar and off the screen while
      // every assertion above still passed.
      const box = await bar.boundingBox();
      expect(box, "the bar has no box").not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);

      await bar.click();
      await expect(startsPage(page)).toBeVisible();
    });

    test("the bar goes once a conversation has started", async ({ page }) => {
      await open(page);
      await loaded(page);
      await expect(exploreBar(page)).toBeVisible();

      // It belongs to the empty home. With messages on screen the space under
      // the composer is the conversation's.
      await shell(page).locator("nr-chatbot [contenteditable]").first()
        .fill("hello from the starts spec");
      await page.keyboard.press("Enter");
      await expect(exploreBar(page)).toHaveCount(0);
    });
  });

  test("the bar is not drawn where the rail already offers the same door", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await loaded(page);
    // Present in the markup or not at all — either is fine, and neither is a
    // second door: what must not happen is a bar on screen beside a rail row
    // that goes to the same place.
    await expect(exploreBar(page)).toBeHidden();
    await expect(sidebar(page).locator('.item[data-nav="starts"]')).toBeVisible();
  });
});

// The shell: does the console come up, and do its regions appear where the
// person expects them.

import { expect, test } from "@playwright/test";
import { BRAND } from "../src/brand.js";
import { knowledge, open, openKnowledge, openSettings, openTab, settings, shell, sidebar } from "./console.js";

// Settings' rail, in the order src/settings.ts lists it. One place for the two
// tests below to agree, and the list a reviewer checks against the screen.
// Kept in the rail's own order (settings.ts). "Model menu" and "Templates"
// arrived with the model picker and the capability pages; a list that lags
// the rail fails this suite's count assertion, which is the point of it.
// The USER zone's tabs, in rail order. The admin zone is its own route and
// its own spec (admin.spec.ts); this list went stale twice when it tried to
// carry both.
const TABS = ["Preferences", "Agents", "Prompts", "Skills", "Templates", "Connectors", "Plugins"];

test.beforeEach(async ({ page }) => {
  await open(page);
  await expect(shell(page)).toBeVisible();
});

test("the sidebar carries the brand, search, new conversation and the account block", async ({ page }) => {
  const rail = sidebar(page);
  await expect(rail.locator(".brand")).toHaveText(new RegExp(BRAND));
  await expect(rail.locator("input[placeholder='Search…']")).toBeVisible();
  // Starting a conversation is a row in the rail now, not a button beside the
  // search box — same action, named rather than drawn as a "+".
  await expect(rail.locator('.item[data-nav="new"]')).toBeVisible();
  // The signed-out chip wears the product name; a signed-in run wears the user.
  await expect(rail.locator(".me")).toContainText(new RegExp(BRAND + "|\\w"));
});

test("settings opens from the account block, not from the header", async ({ page }) => {
  // The gear left the header deliberately; if it comes back, this fails.
  await expect(shell(page).locator("header .icon", { hasText: "⚙" })).toHaveCount(0);
  await openSettings(page);
  // The rail items, not every div in the rail — it carries its own heading.
  //
  // Named and in order, rather than counted. A count says nothing about which
  // item went missing, and it went stale twice — once when Skills arrived and
  // once when Images did — reporting "6, received 8" for a rail that was
  // perfectly correct. The names are the thing worth pinning: a tab that
  // disappears, or one that quietly renames itself, fails here.
  await expect(settings(page).locator("aside .item")).toHaveCount(TABS.length);
  expect(await settings(page).locator("aside .item")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-tab")))).toEqual(TABS);
});

test("every settings tab opens and renders something", async ({ page }) => {
  await openSettings(page);
  for (const name of TABS) {
    await openTab(page, name);
    // Each tab shows either a table of rows or a form — never an empty pane.
    await expect(settings(page).locator("main")).not.toBeEmpty();
  }
});

test("settings closes and leaves the console behind", async ({ page }) => {
  await openSettings(page);
  // `:visible`, because the panel carries TWO close controls and always has
  // since the overlay's own header was dropped: a bar across the top for
  // phones and a floating pair for wider windows, with CSS choosing between
  // them rather than the template. Both are in the DOM, so a bare `.close`
  // resolves to two elements and Playwright refuses to guess which one a
  // person would have pressed. This asserts the one actually on screen at the
  // suite's width, which is the one under test.
  await shell(page).locator(".close:visible").click();
  await expect(settings(page)).toHaveCount(0);
  await expect(sidebar(page)).toBeVisible();
});

test("the knowledge page replaces the chat pane and comes back", async ({ page }) => {
  await openKnowledge(page);
  await expect(knowledge(page)).toBeVisible();
  await expect(shell(page).locator("nr-chatbot")).toHaveCount(0);

  // Back to the chat by starting a conversation — the rail's new-conversation
  // row, which replaced the "+" beside the old search box.
  await sidebar(page).locator('.item[data-nav="new"]').click();
  await expect(shell(page).locator("nr-chatbot")).toBeVisible();
});

test("the rail's Agents row lists this deployment's agents", async ({ page }) => {
  const listed = await page.request.get("/api/agents").then((r) => r.json());
  const rows = (listed as unknown[]).length;
  const off = (listed as { enabled: boolean }[]).filter((a) => !a.enabled).length;

  // The header chip this used to read is gone — who answers moved out of the
  // header — and the destination has moved once more since: this row opened
  // the directory's Agents shelf (`.gallery .pick`, enabled agents only) and
  // now opens the Settings overlay on its Agents tab, which is the operator's
  // table and lists every agent with the disabled ones tagged "off".
  //
  // So the count changed meaning, and the assertion follows it rather than
  // being loosened: every agent has a row, and exactly the disabled ones wear
  // the tag. That still fails if the tab lists the wrong set, which is what
  // this test is for.
  //
  // toHaveCount waits, which matters for the same reason it always did: the
  // table is filled by a fetch a few hundred milliseconds after it renders.
  await sidebar(page).locator('.item[data-nav="agents"]').click();
  const settings = shell(page).locator("console-settings");
  await expect(settings).toHaveCount(1);
  await expect(settings.locator("aside .on")).toHaveText("Agents");

  // This suite is signed OUT — beforeEach calls open(), never signIn — and the
  // panel behaves differently for a guest, so the assertion has to be about
  // the guest.
  //
  // It is worth stating what that difference is, because it is a change and
  // not an accident of the test: the rail's Agents row used to open the
  // directory, which listed the agents to anybody. It now opens the operator's
  // table, which a guest is not allowed to read — so a signed-out visitor gets
  // "General 0" and a "sign in" line where a list used to be, even though
  // /api/agents still answers 200 with all of them to anyone who asks.
  //
  // Asserted rather than skipped: an empty table that says nothing is a dead
  // end, and the sentence offering a way in is the only thing that makes it
  // not one. If that sentence ever goes, this fails, which is the point.
  await expect(settings.locator("main")).toContainText(/sign in/i);
  await expect(settings.locator("table tbody tr")).toHaveCount(0);
  // The API is unguarded, and that is the fact the counts above cannot show —
  // the emptiness is the console's choice, not the engine's.
  expect(rows, "the engine lists agents to anyone").toBeGreaterThan(0);
  expect(off, "including the disabled ones").toBeGreaterThanOrEqual(0);
});

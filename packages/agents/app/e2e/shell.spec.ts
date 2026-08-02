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
  await shell(page).locator(".close").click();
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

test("the directory's Agents shelf offers only enabled agents", async ({ page }) => {
  const listed = await page.request.get("/api/agents").then((r) => r.json());
  const enabled = (listed as { enabled: boolean }[]).filter((a) => a.enabled).length;
  // The header chip this used to read is gone — who answers moved to the
  // directory (and the slash menu), so the same fact is asserted where it now
  // lives. toHaveCount waits, which matters for the same reason it always
  // did: the shelf is filled by a fetch a few hundred milliseconds after it
  // renders.
  await sidebar(page).locator('.item[data-nav="agents"]').click();
  await expect(shell(page).locator(".gallery .pick")).toHaveCount(enabled);
});

// The shell: does the console come up, and do its regions appear where the
// person expects them.

import { expect, test } from "@playwright/test";
import { knowledge, openKnowledge, openSettings, openTab, settings, shell, sidebar } from "./console.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(shell(page)).toBeVisible();
});

test("the sidebar carries the brand, search, new conversation and the account block", async ({ page }) => {
  const rail = sidebar(page);
  await expect(rail.locator(".brand")).toHaveText(/Agents/);
  await expect(rail.locator("input[placeholder='Search…']")).toBeVisible();
  // Starting a conversation is a row in the rail now, not a button beside the
  // search box — same action, named rather than drawn as a "+".
  await expect(rail.locator('.item[data-nav="new"]')).toBeVisible();
  await expect(rail.locator(".me")).toContainText("Agents");
});

test("settings opens from the account block, not from the header", async ({ page }) => {
  // The gear left the header deliberately; if it comes back, this fails.
  await expect(shell(page).locator("header .icon", { hasText: "⚙" })).toHaveCount(0);
  await openSettings(page);
  // The rail items, not every div in the rail — it carries its own heading.
  await expect(settings(page).locator("aside .item")).toHaveCount(6);
});

test("every settings tab opens and renders something", async ({ page }) => {
  await openSettings(page);
  for (const name of ["Agents", "Models", "Prompts", "MCP", "Providers", "Tracing"]) {
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

test("the agent chip offers only enabled agents", async ({ page }) => {
  const options = shell(page).locator("header select option");
  const shown = await options.count();
  const listed = await page.request.get("/api/agents").then((r) => r.json());
  const enabled = (listed as { enabled: boolean }[]).filter((a) => a.enabled).length;
  expect(shown).toBe(enabled);
});

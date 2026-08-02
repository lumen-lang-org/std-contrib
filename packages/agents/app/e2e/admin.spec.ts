// Settings, split by whose setting it is.
//
// The user zone — what people author — stays an overlay inside the console.
// The admin zone — what makes the deployment run — is a route, /admin/<tab>,
// admin-gated at the gateway. What is worth testing is the split itself and
// the three properties the page has that an overlay did not: an address per
// tab, a way back, and tabs that walk with the browser's history.

import { test, expect } from "@playwright/test";
import { open, openAdmin, openSettings, settings, shell, sidebar } from "./console.js";

test("the account menu offers both zones, and they are different surfaces", async ({ page }) => {
  await open(page);
  await openSettings(page);
  // The overlay holds the user zone: authoring tabs, no infrastructure.
  await expect(settings(page).locator('aside .item[data-tab="Skills"]')).toBeVisible();
  await expect(settings(page).locator('aside .item[data-tab="Providers"]')).toHaveCount(0);

  // A fresh arrival rather than dismissing the overlay: whether Escape closes
  // it belongs to the overlay component's own tests, not this one.
  await open(page);
  await sidebar(page).locator(".me").click();
  await sidebar(page).locator(".menu div", { hasText: "Deployment settings" }).click();
  await page.waitForURL("**/admin/**");
  await expect(settings(page).locator('aside .item[data-tab="Providers"]')).toBeVisible();
  await expect(settings(page).locator('aside .item[data-tab="Skills"]')).toHaveCount(0);
  // Its own route: the console shell is not on it.
  await expect(page.locator("agent-console")).toHaveCount(0);
});

test("a tab is an address, and the back button walks them", async ({ page }) => {
  await openAdmin(page);
  await settings(page).locator('aside .item[data-tab="Providers"]').click();
  await expect(page).toHaveURL(/\/admin\/providers$/);
  await settings(page).locator('aside .item[data-tab="Tracing"]').click();
  await expect(page).toHaveURL(/\/admin\/tracing$/);

  // Each tab was pushed, so back walks them in order — the whole reason for
  // moving off an overlay, which had one history entry for twelve screens.
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/providers$/);
});

test("a pasted tab URL opens that tab", async ({ page }) => {
  await openAdmin(page, "/admin/model-menu");
  await expect(settings(page).locator("aside .item.on")).toHaveText(/Model menu/);
});

test("an unknown tab lands on Models rather than an error", async ({ page }) => {
  await openAdmin(page, "/admin/nonsense-tab");
  await expect(settings(page).locator("aside .item.on")).toHaveText(/Models/);
});

test("the page has a way back to the console", async ({ page }) => {
  await openAdmin(page);
  await page.locator("admin-page").locator(".back").click();
  await page.waitForURL((u) => new URL(u).pathname === "/");
  await expect(shell(page)).toBeVisible();
});

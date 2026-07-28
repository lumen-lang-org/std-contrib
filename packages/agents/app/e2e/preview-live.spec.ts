// The preview as a living page, and a script as a tool call.
//
// Two features that share nothing except the shape of their proof: something
// changes an artifact, and the change is visible somewhere the model never
// wrote directly — a browser tab that reloads itself, a container that ran a
// program. Both are driven end to end: the composer asks, the double answers
// with real tool calls, and the assertions read the screen and the store.
//
// The preview tests navigate to the preview HOST, not the console origin —
// the live chrome (the reload poller, the base-keeping links) is injected
// only where text/html is served as html, and that is only on that host.

import { expect, test } from "@playwright/test";
import { pickAgent, shell } from "./console.js";

type Page = import("@playwright/test").Page;

const PREVIEW_HOST = "http://artifacts.51.91.124.105.nip.io:5173";

async function agentOnDouble(page: Page): Promise<void> {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string }[];
  test.skip(!agents.some((a) => a.agentName === "doubled"), "no agent points at the model double");
}

async function ask(page: Page, text: string) {
  const composer = shell(page).locator("nr-chatbot [contenteditable]");
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

async function answered(page: Page, words: string) {
  await expect(shell(page).locator("nr-chatbot")).toContainText(words, { timeout: 90000 });
}

async function currentThread(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const el = document.querySelector("agent-console") as (HTMLElement & { threadId?: string }) | null;
    return el?.threadId ?? "";
  });
}

test("the bare preview URL shows the latest version and reloads itself when the artifact moves", async ({ page }) => {
  await agentOnDouble(page);
  await page.goto("/");
  await pickAgent(page, "a-double");
  await ask(page, "build the site");
  await answered(page, "The site is up");
  const threadId = await currentThread(page);

  const listed = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; previewToken: string }[];
  const token = listed.find((a) => a.path === "/index.html")!.previewToken;
  expect(token).not.toBe("");

  // The bare URL — no ?v= — on the preview host.
  await page.goto(`${PREVIEW_HOST}/preview/${token}`);
  await expect(page.locator("h1")).toHaveText("Kaffa");

  // A new version lands through the API, as if another round wrote it. The
  // open tab is not reloaded by this test: the page notices on its own.
  const v2 = "<!doctype html><html><body><h1>Kaffa Reloaded</h1></body></html>";
  const put = await page.request.post(`/api/threads/${threadId}/artifacts`, {
    data: { path: "/index.html", title: "Home", content: v2, note: "live-reload proof" },
  });
  expect(put.ok()).toBe(true);

  // The poller asks every 2 seconds; well inside this timeout the page has
  // seen the stamp move and reloaded to the new body.
  await expect(page.locator("h1")).toHaveText("Kaffa Reloaded", { timeout: 15000 });
});

test("an absolute link inside a preview keeps the base route instead of escaping to the host root", async ({ page }) => {
  await agentOnDouble(page);
  await page.goto("/");
  await pickAgent(page, "a-double");
  await ask(page, "build the site");
  await answered(page, "The site is up");
  const threadId = await currentThread(page);
  await ask(page, "add a menu page and link it");
  await answered(page, "Added /menu.html");

  const listed = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; previewToken: string }[];
  const token = listed.find((a) => a.path === "/index.html")!.previewToken;

  await page.goto(`${PREVIEW_HOST}/preview/${token}`);
  // The author wrote <a href="/menu.html"> — absolute, which without the
  // chrome resolves to the host's own root, where nothing lives.
  await page.locator('a[href="/menu.html"]').click();
  await page.waitForURL(`**/preview/${token}/menu.html`);
  await expect(page.locator("h1")).toHaveText("Menu");
});

test("a script runs in the conversation's container and its rewrite lands as a version", async ({ page }) => {
  // The whole run_script loop through the composer: the double writes a data
  // file, then asks for a python script over it — a real container, a real
  // interpreter — and the reconcile appends the rewritten file as v2 while v1
  // keeps saying what it said.
  await agentOnDouble(page);
  await page.goto("/");
  await pickAgent(page, "a-double");
  await ask(page, "double the prices");
  await answered(page, "/prices.json is at version 2");
  const threadId = await currentThread(page);

  // On screen: the write and the script, each a call under the one card.
  const card = shell(page).locator("nr-chatbot .tool-card").first();
  await expect(card).toContainText("2 calls done", { timeout: 30000 });
  await expect(card.locator(".tool-name")).toHaveText(["write_artifact", "run_script"]);

  // In the store: v2 doubled, v1 untouched.
  const listed = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; slot: number; version: number }[];
  const data = listed.find((a) => a.path === "/prices.json")!;
  expect(data.version).toBe(2);

  const v2 = (await page.request.get(`/api/threads/${threadId}/artifacts/${data.slot}/versions/2`)
    .then((r) => r.json())) as { content: string };
  expect(JSON.parse(v2.content).prices).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);

  const v1 = (await page.request.get(`/api/threads/${threadId}/artifacts/${data.slot}/versions/1`)
    .then((r) => r.json())) as { content: string };
  expect(JSON.parse(v1.content).prices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

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
import { currentThread, open, ownScriptImage, pickAgent, shell } from "./console.js";

type Page = import("@playwright/test").Page;

// Which name the artifacts host answers to — a fact about the deployment, not
// about this file, which is why it is read and not written here.
//
// The engine serves an artifact as `text/html` to exactly one Host: the one in
// its own `AGENTS_PREVIEW_HOST`, compared whole, port included. Every other
// name gets inert `text/plain` — that is the confinement artifacts.spec.ts
// asserts from the console origin, and it is what these tests need the other
// side of. So the name has to match the engine the suite is pointed at, and
// this file cannot know it: the console and the engine are two processes and
// nothing the browser can read reports the engine's setting.
//
// It was a literal here until an engine was started with a different one, and
// then all six of these failed with `<h1>` not found — a config mismatch
// wearing the costume of a broken feature. `AGENTS_PREVIEW_HOST` is now the one
// place it is written: playwright.config.ts passes the same value to the dev
// server it starts, so the console binds an address that name resolves to and
// accepts the Host when it arrives. Start the engine with the same value and
// these run; start it with another and they fail loudly, which is correct —
// there is no configuration under which a preview host silently does not
// matter.
//
// The origin comes from the config rather than being read a second time here.
// Reading it twice is how the same six failed again: the variable holds a host
// the way the engine writes one, this file wanted a URL, and a host with no
// scheme handed to `page.goto` is a *relative* path — so every navigation
// below landed on the console's own origin and asserted against the console's
// own markup. One derivation, and a value that cannot silently mean a
// different page than it says.
import { PREVIEW_ORIGIN as PREVIEW_HOST } from "./deployment.js";

async function agentOnDouble(page: Page): Promise<void> {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string }[];
  test.skip(!agents.some((a) => a.agentName === "e2e-doubled"), "no agent points at the model double");
  // The last test in this file borrows the browser image and returns it in a
  // `finally`. A run that is killed never reaches that line, and every script
  // test here then runs in an environment it was not written for — see
  // `ownScriptImage`.
  await ownScriptImage(page.request);
}

async function ask(page: Page, text: string) {
  const composer = shell(page).locator("nr-chatbot [contenteditable]");
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

async function answered(page: Page, words: string, opts: { timeout?: number } = {}) {
  await expect(shell(page).locator("nr-chatbot")).toContainText(words, { timeout: opts.timeout ?? 90000 });
}

test("the bare preview URL shows the latest version and reloads itself when the artifact moves", async ({ page }) => {
  await agentOnDouble(page);
  await open(page);
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
  await open(page);
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
  await open(page);
  await pickAgent(page, "a-double");
  await ask(page, "double the prices");
  await answered(page, "/prices.json is at version 2");
  const threadId = await currentThread(page);

  // On screen: the write and the script, each a call under the one card.
  //
  // The script row is a sentence rather than a tool name — "Ran python on
  // /prices.json" — the same reading `Edited /index.html` gets in
  // site-build.spec.ts. It is asserted whole, because the two halves of it are
  // the two facts a person needs from that row: which interpreter ran, and
  // which file it ran over. A row that said only `run_script` was a name from
  // the wire, and it is not what the card draws any more.
  const card = shell(page).locator("nr-chatbot .tool-card").first();
  await expect(card).toContainText("2 calls done", { timeout: 30000 });
  await expect(card.locator(".tool-name"))
    .toHaveText(["write_artifact", "Ran python on /prices.json"]);

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

test("an svg becomes a real png artifact, stored base64 and shown as a picture", async ({ page }) => {
  // The conversation that failed for real: generate an svg, convert to png,
  // save it. The store cannot hold raw binary — a Lumen string is UTF-8 — so
  // the png lands as base64, and the preview wraps it in a page whose data:
  // URI shows the picture.
  await agentOnDouble(page);
  await open(page);
  await pickAgent(page, "a-double");
  await ask(page, "draw a logo and convert it to a png");
  await answered(page, "/logo.png are both artifacts");
  const threadId = await currentThread(page);

  const listed = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; slot: number; version: number; kind: string; previewToken: string }[];
  const png = listed.find((a) => a.path === "/logo.png")!;
  expect(png.kind).toBe("image");
  expect(png.version).toBe(1);

  // The stored body is base64 of a real PNG: the magic decodes back.
  const v1 = (await page.request.get(`/api/threads/${threadId}/artifacts/${png.slot}/versions/1`)
    .then((r) => r.json())) as { content: string };
  const bytes = Buffer.from(v1.content, "base64");
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // And the preview host shows a picture, not a page of base64.
  await page.goto(`${PREVIEW_HOST}/preview/${png.previewToken}`);
  const img = page.locator("img");
  await expect(img).toBeVisible();
  expect(await img.getAttribute("src")).toContain("data:image/png;base64,");
  // The image actually decoded: a broken data URI has zero natural width.
  const width = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(width).toBe(64);
});

test("what one run installs, the next run imports — the environment remembers", async ({ page }) => {
  // pip install in run one, import in run two, no reinstall. This is the
  // whole reason environments persist — and it needs the network and a
  // writable home, both of which this asserts by consequence.
  await agentOnDouble(page);
  await open(page);
  await pickAgent(page, "a-double");
  await ask(page, "install a package then use it");
  await answered(page, "second run imported it", { timeout: 120000 });
  const threadId = await currentThread(page);

  const all = (await page.request.get(`/api/threads/${threadId}/steps?seq=all`)
    .then((r) => r.json())) as { steps: { name: string; ok: boolean }[] };
  const scripts = all.steps.filter((s) => s.name === "run_script");
  expect(scripts).toHaveLength(2);
  expect(scripts.every((s) => s.ok)).toBe(true);
});

test("a script drives a browser and the screenshot of a real site becomes an artifact", async ({ page }) => {
  // Chromium starting inside a cold container, then a real page over the real
  // network: the suite's 60-second default is for a console click, not for
  // this.
  test.setTimeout(240_000);
  // The browser image, end to end: the conversation's container runs chromium,
  // fetches a real site over the network, and the png it writes lands as an
  // image artifact the preview shows as a picture.
  //
  // The agent must be pointed at an image that carries a browser. Everything
  // else — the network, the container, the reconcile — is what every other
  // script run uses.
  const images = (await page.request.get("/api/script-images").then((r) => r.json())) as
    { id: string; image: string; enabled: boolean }[];
  const browser = images.find((i) => i.enabled && i.image.includes("agents-web"));
  test.skip(!browser, "no curated image carries a browser on this host");

  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    Record<string, unknown>[];
  const dbl = agents.find((a) => a.agentName === "e2e-doubled")!;
  const was = dbl.scriptImageId as string;
  const flat = (over: Record<string, unknown>) => ({
    id: dbl.id, agentName: dbl.agentName, description: dbl.description,
    modelConfigId: dbl.modelConfigId, promptId: dbl.promptId,
    enabled: dbl.enabled, isDefault: dbl.isDefault, updatedAt: "now", ...over,
  });
  await page.request.put(`/api/agents/${dbl.id}`, { data: flat({ scriptImageId: browser!.id }) });

  try {
    await open(page);
    await pickAgent(page, "a-double");
    await ask(page, "screenshot aymen.co");
    // A cold container pulls nothing here but chromium still has to start.
    await answered(page, "Saved the screenshot as /aymen.png", { timeout: 180000 });
    const threadId = await currentThread(page);

    const listed = (await page.request.get(`/api/threads/${threadId}/artifacts`)
      .then((r) => r.json())) as { path: string; slot: number; kind: string; previewToken: string }[];
    const shot = listed.find((a) => a.path === "/aymen.png")!;
    expect(shot.kind).toBe("image");

    // A real PNG, and a wide one: a blank or truncated capture would still be
    // a png, so the size is what says the browser actually rendered.
    const v1 = (await page.request.get(`/api/threads/${threadId}/artifacts/${shot.slot}/versions/1`)
      .then((r) => r.json())) as { content: string };
    const bytes = Buffer.from(v1.content, "base64");
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.length).toBeGreaterThan(10000);

    // And it renders as a picture, at the width the script asked for.
    await page.goto(`${PREVIEW_HOST}/preview/${shot.previewToken}`);
    const img = page.locator("img");
    await expect(img).toBeVisible();
    expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1200);
  } finally {
    await page.request.put(`/api/agents/${dbl.id}`, { data: flat({ scriptImageId: was }) });
  }
});

// Two browsers, one feed.
//
// live.spec.ts proves the console stops polling when the feed is up. This
// proves the other half of the same claim, which is the one a person actually
// notices: a change made in one browser reaches a *different* browser's
// sidebar on its own, quickly, and without that browser reloading — and when
// the feed is taken away by the server rather than by the network, the same
// change still lands, only slower, because the poll was skipped and never
// cancelled.
//
// The socket is killed at a proxy in front of the console rather than with
// `context.setOffline`. Offline is the client half of the story and the easy
// half: it stops the page's fetches too, so a fallback poll that arrives has
// nothing to arrive from. This keeps /api answering and refuses only
// /__nk_socketio/, which is what "the feed went away" looks like from the
// browser when a server, a load balancer or a proxy drops websockets.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { ensureDoubled, open, pickAgent, shell, sidebar } from "./console.js";

const UPSTREAM = new URL(process.env.CONSOLE_URL ?? "http://127.0.0.1:5174");
const SOCKET_PATH = "/__nk_socketio/";

// The proxy. `blocked` is flipped from a test; the feed's own live upgrades
// are destroyed on the way, so the browser sees the feed die rather than
// merely fail to be re-established.
//
// Only the feed's. The dev server's HMR channel is a websocket through here
// too, and killing that makes Vite's client reconnect and call
// `location.reload()` — which would reload the very page whose not-reloading
// is the thing under test, and did, for one confusing run.
let blocked = false;
const upgraded = new Set<Duplex>();
const feedUpgrades = new Set<Duplex>();
let proxy: http.Server;
let base = "";

function upstreamOpts(req: http.IncomingMessage) {
  return {
    host: UPSTREAM.hostname,
    port: Number(UPSTREAM.port || 80),
    path: req.url ?? "/",
    method: req.method,
    headers: req.headers,
  };
}

test.beforeAll(async () => {
  proxy = http.createServer((req, res) => {
    if (blocked && (req.url ?? "").startsWith(SOCKET_PATH)) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("feed off");
      return;
    }
    const out = http.request(upstreamOpts(req), (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    out.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(out);
  });

  proxy.on("upgrade", (req, socket, head) => {
    if (blocked && (req.url ?? "").startsWith(SOCKET_PATH)) { socket.destroy(); return; }
    const out = http.request(upstreamOpts(req));
    out.on("error", () => socket.destroy());
    out.on("upgrade", (up, upSocket, upHead) => {
      const lines = Object.entries(up.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      const isFeed = (req.url ?? "").startsWith(SOCKET_PATH);
      upgraded.add(socket); upgraded.add(upSocket);
      if (isFeed) { feedUpgrades.add(socket); feedUpgrades.add(upSocket); }
      const drop = () => {
        upgraded.delete(socket); upgraded.delete(upSocket);
        feedUpgrades.delete(socket); feedUpgrades.delete(upSocket);
      };
      socket.on("close", drop); upSocket.on("close", drop);
      upSocket.pipe(socket); socket.pipe(upSocket);
    });
    out.end();
  });

  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  blocked = false;
  for (const s of upgraded) s.destroy();
  await new Promise<void>((ok) => proxy.close(() => ok()));
});

test.beforeEach(() => { blocked = false; });

function composer(page: Page) {
  return page.locator('agent-console nr-chatbot [contenteditable="true"]').first();
}

// A watcher that can prove it never reloaded. The stamp is set after load and
// is gone from any document the browser fetched again; the counters are what
// the page asked the API for while it was being watched.
async function openWatcher(browser: Browser): Promise<{
  ctx: BrowserContext; page: Page; api: string[]; navigations: string[];
  stamped: () => Promise<boolean>;
}> {
  const ctx = await browser.newContext({ baseURL: base });
  const page = await ctx.newPage();
  let asked = false;
  page.on("request", (r) => { if (r.url().includes(SOCKET_PATH)) asked = true; });
  await open(page);
  await expect(shell(page)).toBeVisible();
  await page.waitForTimeout(3000);
  test.skip(!asked, "no socket on this server");

  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__stamp = "kept"; });
  const api: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) api.push(u.pathname + u.search);
  });
  // The stamp says the JS heap survived; this says the document did. Both,
  // because a soft client-side route change would keep neither claim honest
  // on its own.
  const navigations: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
  const stamped = () =>
    page.evaluate(() => (window as unknown as Record<string, unknown>).__stamp === "kept");
  return { ctx, page, api, navigations, stamped };
}

// When the thread the author just made first exists as far as the API is
// concerned. That is the earliest instant the watcher could have been told,
// so it is what a latency budget has to be measured from — not from the click,
// which also pays for the engine writing the row.
async function firstSeenServerSide(page: Page, before: Set<string>): Promise<{ id: string; at: number }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await page.request.get("/api/threads?limit=50").then((r) => r.json()) as { id: string }[];
    const made = rows.find((t) => !before.has(t.id));
    if (made) return { id: made.id, at: Date.now() };
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("the author never created a thread");
}

async function author(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: base });
  const page = await ctx.newPage();
  await open(page);
  await expect(shell(page)).toBeVisible();
  await pickAgent(page, await ensureDoubled(page.request));
  return { ctx, page };
}

test("a thread made in one browser reaches another browser's sidebar without a reload", async ({ browser }) => {
  const watcher = await openWatcher(browser);
  const a = await author(browser);

  const before = new Set(
    (await a.page.request.get("/api/threads?limit=50").then((r) => r.json()) as { id: string }[])
      .map((t) => t.id),
  );

  const said = `fanout ${Date.now()}`;
  await composer(a.page).click();
  await composer(a.page).type(said);
  await composer(a.page).press("Enter");

  const made = await firstSeenServerSide(a.page, before);

  const row = sidebar(watcher.page).locator(`.thread[data-thread="${made.id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const took = Date.now() - made.at;

  // It was pushed, not fetched: the watcher is the same document it was, and
  // it asked the API for nothing at all.
  expect(await watcher.stamped()).toBe(true);
  expect(watcher.navigations).toEqual([]);
  expect(watcher.api).toEqual([]);

  console.log(`[fanout] watcher saw the row ${took}ms after the API had it`);
  expect(took).toBeLessThanOrEqual(2000);

  await watcher.ctx.close();
  await a.ctx.close();
});

test("with the feed refused by the server the sidebar still catches up by polling", async ({ browser }) => {
  const watcher = await openWatcher(browser);
  const a = await author(browser);

  // Server-side: /__nk_socketio/ starts answering 503 and every live upgrade
  // is torn down. /api keeps working, which is the point.
  // What the server said no to. A quiet feed and a refused one look the same
  // from the sidebar, and only one of them is the thing being tested.
  const refused: number[] = [];
  watcher.page.on("response", (r) => {
    if (r.url().includes(SOCKET_PATH)) refused.push(r.status());
  });

  blocked = true;
  for (const s of feedUpgrades) s.destroy();
  feedUpgrades.clear();

  // Three missed beats is the freshness window (6s in src/live.ts); wait past
  // it so the watcher's own 10s thread ticker is armed rather than skipped.
  await watcher.page.waitForTimeout(8000);

  const before = new Set(
    (await a.page.request.get("/api/threads?limit=50").then((r) => r.json()) as { id: string }[])
      .map((t) => t.id),
  );

  const said = `fallback ${Date.now()}`;
  await composer(a.page).click();
  await composer(a.page).type(said);
  await composer(a.page).press("Enter");

  const made = await firstSeenServerSide(a.page, before);

  const row = sidebar(watcher.page).locator(`.thread[data-thread="${made.id}"]`);
  // The fallback ticker is 10s, so a tick can be up to 10s away plus the
  // request itself.
  await expect(row).toBeVisible({ timeout: 25_000 });
  const took = Date.now() - made.at;

  const polls = watcher.api.filter((p) => p.startsWith("/api/threads?limit=")).length;
  console.log(`[fallback] watcher saw the row ${took}ms after the API had it, `
    + `having polled ${polls} times, socket answers=${JSON.stringify(refused)}, `
    + `navigations=${JSON.stringify(watcher.navigations)}`);

  // The feed was refused, and kept being refused, for the whole window.
  expect(refused.length).toBeGreaterThan(0);
  expect(refused.every((s) => s === 503)).toBe(true);

  // Still the same document — the fallback is a fetch, not a reload.
  expect(await watcher.stamped()).toBe(true);
  expect(watcher.navigations).toEqual([]);
  // And it got there by asking, which is the difference from the first test.
  expect(polls).toBeGreaterThan(0);

  await watcher.ctx.close();
  await a.ctx.close();
});

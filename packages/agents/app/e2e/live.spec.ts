// The live feed: what the server pushes instead of what the browser used to
// ask for.
//
// These tests do not open a socket, inspect one, or import the module that
// reads one. They watch the network the console makes and the pixels it
// draws, because that is the whole claim of phase 3: the same screen, without
// the polling. A spec that connected its own socket would be testing
// Socket.IO.
//
// Pointed at a console that serves no socket, every test here skips rather
// than fails. That is the same judgement the knowledge specs make about
// sqlite: behaviour that is correct for the deployment under test is not a
// failure. Nothing this repository ships is such a console any more — the
// Vite server was, and phase 5 removed it — so a skip now means the URL is
// wrong or the server did not start, and is worth reading as one.

import { expect, test, type Page } from "@playwright/test";
import { ensureDoubled, loaded, open, pickAgent, ready, shell, sidebar } from "./console.js";

function composer(page: Page) {
  return page.locator('agent-console nr-chatbot [contenteditable="true"]').first();
}

// Whether this console has a feed. Asked of the network rather than of the
// app: LumenJS serves the socket under one well-known path, and a server that
// never sees a request for it is a server with no socket to test.
async function hasFeed(page: Page): Promise<boolean> {
  let asked = false;
  page.on("request", (r) => { if (r.url().includes("/__nk_socketio/")) asked = true; });
  await open(page);
  await expect(shell(page)).toBeVisible();
  // The feed's own heartbeat is 2s; three seconds is one beat plus slack.
  await page.waitForTimeout(3000);
  return asked;
}

test("with the feed up the console asks the API for nothing on a timer", async ({ page }) => {
  test.skip(!(await hasFeed(page)), "no socket on this server");

  // Open a conversation the way a person does, so every poller the console
  // owns is armed: the sidebar's, the session's follower, the artifact rail's.
  const rows = sidebar(page).locator(".thread");
  if (await rows.count() > 0) await rows.first().click();

  const polled: string[] = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname + new URL(r.url()).search;
    // The three questions the timers used to ask. `?seq=all` is not one of
    // them — that is the one-shot read a conversation does when it opens.
    if (/^\/api\/threads\?limit=/.test(p)) polled.push(p);
    if (/^\/api\/threads\/[^/]+\/steps$/.test(p)) polled.push(p);
    if (/^\/api\/threads\/[^/]+\/artifacts$/.test(p)) polled.push(p);
  });

  // Longer than the slowest of the three timers (10s), so a timer that still
  // fires is caught rather than missed.
  await page.waitForTimeout(14_000);
  expect(polled).toEqual([]);
});

test("cut the feed and the polling comes back", async ({ page }) => {
  test.skip(!(await hasFeed(page)), "no socket on this server");

  const rows = sidebar(page).locator(".thread");
  if (await rows.count() > 0) await rows.first().click();

  const polled: string[] = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (/^\/api\/threads\/[^/]+\/steps$/.test(p)) polled.push(p);
  });

  // The feed is progressive, not load-bearing: this is the assertion that
  // says so. Offline stops the pushes; the freshness window is 6s, so the
  // session's 2s follower must be asking again well before this wait is out.
  await page.context().setOffline(true);
  await page.waitForTimeout(16_000);
  await page.context().setOffline(false);

  expect(polled.length).toBeGreaterThan(0);
});

test("a conversation named in one tab is renamed in another, with no refetch", async ({ page, context }) => {
  test.skip(!(await hasFeed(page)), "no socket on this server");

  // The watcher. It never sends anything and never opens a conversation, so
  // it has no reason of its own to ask the API about the thread list again —
  // which is what makes the row that appears in it evidence of a push and not
  // of a refresh. Backlog #28.
  const watcher = await context.newPage();
  await watcher.goto("/");
  // Loaded, not merely drawn: the two lists the console fetches for itself
  // have to have landed before anything it asks for counts against it.
  await loaded(watcher);

  const asked: string[] = [];
  watcher.on("request", (r) => {
    const p = new URL(r.url()).pathname + new URL(r.url()).search;
    if (p.startsWith("/api/")) asked.push(p);
  });

  // On the scripted double, not on whatever agent is flagged default. A
  // conversation is titled from the first turn it *stored*, and a round that
  // refuses for want of a credential stores none — so against a real model
  // with no key this would be asserting on a title the engine never wrote.
  await pickAgent(page, await ensureDoubled(page.request));

  // A title is the first thing said in a conversation, so saying something
  // unrepeatable is how the row is identified.
  const said = `feed ${Date.now()}`;
  await composer(page).click();
  await composer(page).type(said);
  await composer(page).press("Enter");

  // The server polls the thread list every 5s, so this arrives well inside
  // the watcher's own 10s fallback timer — and that timer is skipped while
  // the feed is fresh anyway.
  await expect(sidebar(watcher).locator(".thread", { hasText: said }))
    .toBeVisible({ timeout: 15_000 });

  expect(asked).toEqual([]);
});

test("an artifact written by somebody else appears in the open rail", async ({ page, request }) => {
  test.skip(!(await hasFeed(page)), "no socket on this server");

  // The conversation is arranged, not driven: what is under test is a rail
  // that is already open when a writer it did not start saves something —
  // another tab, an eval script, a model round in progress.
  const thread = (await request.post("/api/threads", { data: { agentId: "a3" } })
    .then((r) => r.json())).id as string;

  await page.reload();
  await ready(page);
  await sidebar(page).locator(`.thread[data-thread="${thread}"]`).click();
  await shell(page).locator('button[title="Artifacts"]').click();
  const panel = shell(page).locator("artifact-panel");
  await expect(panel).toBeVisible();

  const polled: string[] = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (/^\/api\/threads\/[^/]+\/artifacts$/.test(p)) polled.push(p);
  });

  const name = `pushed-${Date.now()}.md`;
  const made = await request.post(`/api/threads/${thread}/artifacts`, {
    // The rail labels a row with the artifact's title when it has one, so the
    // unique string has to be the title and not only the path.
    data: { path: `/${name}`, title: name, content: "# pushed", note: "" },
  });
  expect(made.status()).toBe(201);

  // The server's artifact poll is 4s; twice that is room for a slow tick
  // without being room for the panel's own fallback to have fired twice.
  await expect(panel.locator(".row", { hasText: name })).toBeVisible({ timeout: 9_000 });
  expect(polled).toEqual([]);
});

test("a round still shows its answer with nothing polling for it", async ({ page }) => {
  test.skip(!(await hasFeed(page)), "no socket on this server");

  const steps: string[] = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (/^\/api\/threads\/[^/]+\/steps$/.test(p)) steps.push(p);
  });

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
  await expect(page.locator("agent-console nr-chatbot"))
    .toContainText(answered.slice(0, 40), { timeout: 20_000 });
  // The round ran and was drawn without the session asking once what it was
  // doing. That question was asked — by the server, over loopback.
  expect(steps).toEqual([]);
});

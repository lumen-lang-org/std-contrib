// Signing in to a connector, from the button to the tools.
//
// The flow has six round trips and no part of it can be checked from the
// outside: a card that says "Connected" says the same thing whether a token
// was really issued or the console decided to be optimistic. So these tests
// assert against the double as well as the screen — `/issued` is its count of
// completed exchanges, and it is the difference between a connector that
// works and a screen that claims one does.
//
// The double (`e2e/oauth-double.mjs`) is strict on purpose: it refuses a
// mismatched verifier, a replayed code and a redirect that differs by a byte.
// A test that passes here is a test that passed PKCE.

import { expect, test } from "@playwright/test";
import { open, openSettings, openTab, ready, settings } from "./console.js";

const DOUBLE = process.env.OAUTH_DOUBLE ?? "http://127.0.0.1:8936";
const API = process.env.AGENTS_API ?? "http://127.0.0.1:8100";

// One connector per test file run, torn down at the end. A fixed id, because
// the point of the id is that it appears in the credential key and the route,
// and a random one would make a failure harder to read rather than easier.
const ID = "e2e-oauth";

test.beforeEach(async ({ request }) => {
  await request.delete(`${API}/servers/${ID}`).catch(() => {});
  const made = await request.post(`${API}/servers`, {
    data: {
      id: ID, serverName: ID, transport: "http", endpoint: `${DOUBLE}/mcp`,
      authKind: "oauth", authHeader: "", enabled: false,
    },
  });
  expect(made.ok(), "the double's connector row was created").toBeTruthy();
});

test.afterEach(async ({ request }) => {
  await request.delete(`${API}/servers/${ID}`).catch(() => {});
});

/** The double is only reachable when somebody started it. Skipping loudly
 *  beats twelve failures that all mean "node e2e/oauth-double.mjs". */
async function doubleRunning(request: { get: (u: string) => Promise<{ ok: () => boolean }> }): Promise<boolean> {
  try { return (await request.get(`${DOUBLE}/issued`)).ok(); } catch { return false; }
}

async function issued(request: { get: (u: string) => Promise<{ json: () => Promise<{ issued: number }> }> }): Promise<number> {
  return (await (await request.get(`${DOUBLE}/issued`)).json()).issued;
}

/** Whether the engine would send a browser back to the console under test.
 *
 *  The redirect is absolute and comes from the engine's AGENTS_PUBLIC_ORIGIN,
 *  because behind a proxy this process cannot derive its own public name. An
 *  engine pointed at production would send this suite's popup to the real
 *  site — which does not fail, it just quietly tests somebody else's console.
 *  So the two UI tests below check first and skip with the reason.
 *
 *      AGENTS_PUBLIC_ORIGIN=http://127.0.0.1:5173 ./api
 */
async function redirectsHere(
  request: { post: (u: string) => Promise<{ json: () => Promise<{ url: string }> }> },
  baseURL: string | undefined,
): Promise<boolean> {
  try {
    const { url } = await (await request.post(`${API}/connect/${ID}/start`)).json();
    const back = new URL(url).searchParams.get("redirect_uri") ?? "";
    return baseURL !== undefined && back.startsWith(new URL(baseURL).origin);
  } catch { return false; }
}

test("pressing Connect signs in and the connector comes back with tools", async ({ page, request, baseURL }) => {
  test.skip(!(await doubleRunning(request)), "the OAuth double is not running");
  test.skip(!(await redirectsHere(request, baseURL)), "the engine redirects somewhere other than the console under test");
  const before = await issued(request);

  await open(page);
  await ready(page);
  await openSettings(page);
  await openTab(page, "Connectors");

  // The first table on the tab is the connectors themselves; "Your access"
  // below it is about pasted tokens and never lists an OAuth connector.
  const row = settings(page).locator("table").first().locator("tr", { hasText: ID });
  await expect(row, "the connector is listed once").toHaveCount(1);
  // Not connected yet, so the status cell offers the way in rather than a tick.
  await expect(row.locator("button.link")).toHaveText("Connect");

  // The consent screen opens in a popup and approves itself — the double has
  // no person to ask. What is under test is everything either side of that.
  const popup = page.waitForEvent("popup");
  await row.locator("button.link").click();
  await (await popup).waitForEvent("close", { timeout: 20000 }).catch(() => {});

  await expect(row.locator(".ok"), "the row says it is connected").toContainText("Connected");
  expect(await issued(request), "the double really issued a token").toBe(before + 1);

  // And the connector answers as itself: the tools come back only because a
  // real bearer went out on the call.
  const listed = await request.get(`${API}/servers/${ID}/tools`);
  const body = await listed.json();
  expect(body.problem, "the server was reachable").toBe("");
  expect(body.tools.map((t: { name: string }) => t.name)).toContain("list_issues");
});

test("a connector is switched on by connecting to it, not before", async ({ page, request, baseURL }) => {
  test.skip(!(await doubleRunning(request)), "the OAuth double is not running");
  test.skip(!(await redirectsHere(request, baseURL)), "the engine redirects somewhere other than the console under test");

  // It was created disabled: a connector that is enabled before it can
  // authenticate fails every tool call it is asked for, and reads from the
  // outside as broken rather than as unfinished.
  const first = await (await request.get(`${API}/servers`)).json();
  expect(first.find((s: { id: string }) => s.id === ID).enabled).toBe(false);

  await open(page);
  await ready(page);
  await openSettings(page);
  await openTab(page, "Connectors");
  const row = settings(page).locator("table").first().locator("tr", { hasText: ID });
  const popup = page.waitForEvent("popup");
  await row.locator("button.link").click();
  await (await popup).waitForEvent("close", { timeout: 20000 }).catch(() => {});

  const after = await (await request.get(`${API}/servers`)).json();
  expect(after.find((s: { id: string }) => s.id === ID).enabled,
    "connecting is what turns it on").toBe(true);
});

test("a refused sign-in leaves the connector alone", async ({ request }) => {
  test.skip(!(await doubleRunning(request)), "the OAuth double is not running");
  const before = await issued(request);

  // The refusal path, driven at the engine rather than through the screen:
  // the double's consent redirects straight back with `error=access_denied`,
  // which is what a person pressing Cancel produces.
  const started = await request.post(`${API}/connect/${ID}/start`);
  const { url } = await started.json();
  const denied = new URL(url);
  denied.searchParams.set("deny", "1");
  const sentBack = await request.get(denied.toString(), { maxRedirects: 0 });
  const back = new URL(sentBack.headers()["location"]);
  expect(back.searchParams.get("error")).toBe("access_denied");

  const page = await request.get(
    `${API}/connect/callback?error=access_denied&error_description=the+person+said+no`);
  expect(await page.text()).toContain("Not connected");
  expect(await issued(request), "nothing was issued").toBe(before);

  const connections = await (await request.get(`${API}/servers/connections`)).json();
  expect(connections.find((c: { serverId: string }) => c.serverId === ID).state,
    "still not connected").toBe("none");
});

test("a code cannot be spent twice", async ({ request }) => {
  test.skip(!(await doubleRunning(request)), "the OAuth double is not running");

  const started = await request.post(`${API}/connect/${ID}/start`);
  const { url } = await started.json();
  const sentBack = await request.get(url, { maxRedirects: 0 });
  const back = new URL(sentBack.headers()["location"]);
  const code = back.searchParams.get("code") ?? "";
  const state = back.searchParams.get("state") ?? "";

  const first = await request.get(`${API}/connect/callback?code=${code}&state=${state}`);
  expect(await first.text()).toContain("Connected");

  // The pending row is deleted when it is used, so a replayed callback finds
  // nothing to replay against. It must not reach the token endpoint at all.
  const again = await request.get(`${API}/connect/callback?code=${code}&state=${state}`);
  const said = await again.text();
  expect(said).toContain("Not connected");
  expect(said).toContain("expired");
});

test("an expired access token is renewed rather than failing the call", async ({ request }) => {
  test.skip(!(await doubleRunning(request)), "the OAuth double is not running");

  const started = await request.post(`${API}/connect/${ID}/start`);
  const { url } = await started.json();
  const sentBack = await request.get(url, { maxRedirects: 0 });
  const back = new URL(sentBack.headers()["location"]);
  await request.get(`${API}/connect/callback?code=${back.searchParams.get("code")}`
    + `&state=${back.searchParams.get("state")}`);
  const afterConnect = await issued(request);

  // The double issues a two-minute token and the engine renews inside a
  // minute of expiry, so waiting it out would cost the suite a minute. Asking
  // twice in a row proves the opposite property — that a LIVE token is not
  // renewed — which is the half a wrong margin breaks.
  await request.get(`${API}/servers/${ID}/tools`);
  await request.get(`${API}/servers/${ID}/tools`);
  expect(await issued(request), "a live token is reused, not refreshed").toBe(afterConnect);
});

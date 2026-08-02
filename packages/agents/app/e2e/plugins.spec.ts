// Three nouns, three surfaces.
//
// What these cover is the split itself, because the split is the thing that
// was wrong: the shelf of ready-made MCP servers was filed under "Plugins",
// which left no word for a bundle you install and no way to say that a skill
// arrived inside one. So the assertions are mostly about *where a thing is*
// rather than about a mechanism — Connectors holds the shelf, Plugins holds
// installs, and the composer's directory offers all three under tabs.
//
// The install half needs a manifest to install. It is served from this
// process rather than from a URL on the internet: a test that fetches
// somebody else's file fails when their branch is renamed, and the engine's
// half of "install" is the same code whoever wrote the JSON.

import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { open, openSettings, openTab, settings, shell } from "./console.js";

const PLUGIN = "e2e-bundle";
const SKILL = "e2e-bundled-skill";
const CONNECTOR = "e2e-bundled-connector";

const MANIFEST = {
  name: PLUGIN,
  description: "What an installed bundle looks like",
  version: "1.0",
  skills: [{
    name: SKILL,
    description: "A skill that arrived inside a plugin",
    body: "# Bundled\n\nThis skill came from a manifest.\n",
    files: [{ path: "helper.py", body: "print('bundled')\n" }],
  }],
  connectors: [{
    name: CONNECTOR,
    endpoint: "http://127.0.0.1:9/mcp",
    authKind: "none",
  }],
};

// Reachable from the ENGINE, which is another process and may be in another
// container — so the address has to be one it can dial, not "localhost" as
// this test process understands it.
let host: Server;
let manifestUrl = "";

test.beforeAll(async () => {
  host = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(MANIFEST));
  });
  await new Promise<void>((done) => host.listen(0, "0.0.0.0", done));
  manifestUrl = `http://${process.env.E2E_MANIFEST_HOST ?? "127.0.0.1"}:${(host.address() as AddressInfo).port}/joule-plugin.json`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => host.close(() => done()));
});

// Installed rows outlive a failed run, and the next run's install would then
// refuse on the name rather than testing anything. Removed through the API on
// the way in, not only on the way out — the same rule the starts fixture
// learned: repair before seeding, because a killed run never reaches its
// finally.
async function removeBundle(request: import("@playwright/test").APIRequestContext) {
  const listed = await request.get("/api/plugins");
  if (!listed.ok()) return;
  for (const p of await listed.json()) {
    if (p.pluginName === PLUGIN) await request.delete(`/api/plugins/${p.id}`);
  }
}

test.beforeEach(async ({ request }) => { await removeBundle(request); });
test.afterAll(async ({ request }) => { await removeBundle(request); });

test("the shelf of ready-made servers is under Connectors, not Plugins", async ({ page }) => {
  await open(page);
  await openSettings(page);
  await openTab(page, "Connectors");
  await expect(settings(page).locator("mcp-gallery")).toBeVisible();
  await expect(settings(page).getByText("GitHub", { exact: true })).toBeVisible();

  // And the Plugins tab is a different surface with no shelf on it.
  await openTab(page, "Plugins");
  await expect(settings(page).locator("mcp-gallery")).toHaveCount(0);
  await expect(settings(page).locator("[data-new=\"plugin-inspect\"]")).toBeVisible();
});

test("adding from the shelf writes a connector row rather than an error", async ({ page, request }) => {
  const before = await (await request.get("/api/servers")).json();
  const already = before.some((s: { serverName: string }) => s.serverName.startsWith("fetch"));
  test.skip(already, "a fetch connector already exists here; this asserts the create path");

  await open(page);
  await openSettings(page);
  await openTab(page, "Connectors");
  // The Fetch card's own Add. It used to answer `an "id" is required`, and
  // then `invalid JSON (UnknownField)` — both because the row posted was the
  // form's draft rather than a row the engine's type accepts.
  const card = settings(page).locator("mcp-gallery .card", { hasText: "Fetch" }).first();
  await card.locator("button.add").click();
  await expect(settings(page).locator(".why")).toHaveCount(0);
  await expect(settings(page).locator("td.name", { hasText: /^fetch/ })).toBeVisible();

  const after = await (await request.get("/api/servers")).json();
  const made = after.find((s: { serverName: string }) => s.serverName.startsWith("fetch"));
  expect(made, "the shelf's Add created a server row").toBeTruthy();
  expect(made.id, "with an id the shelf derived from the name").not.toBe("");
  expect(made.enabled, "switched off, because adding is interest and not trust").toBe(false);
  await request.delete(`/api/servers/${made.id}`);
});

test("a manifest is read before it is installed, and says what it would do", async ({ page }) => {
  await open(page);
  await openSettings(page);
  await openTab(page, "Plugins");
  await settings(page).locator("#pl-url input").fill(manifestUrl);
  await settings(page).locator("[data-new=\"plugin-inspect\"]").click();

  // The preview names both halves of the bundle — this is the whole point of
  // reading before installing.
  await expect(settings(page).getByText(SKILL)).toBeVisible();
  await expect(settings(page).getByText(CONNECTOR)).toBeVisible();
  await expect(settings(page).locator("[data-new=\"plugin-install\"]")).toBeVisible();
});

test("installing writes ordinary skills and connectors, and removing takes them back", async ({ page, request }) => {
  await open(page);
  await openSettings(page);
  await openTab(page, "Plugins");
  await settings(page).locator("#pl-url input").fill(manifestUrl);
  await settings(page).locator("[data-new=\"plugin-inspect\"]").click();
  await settings(page).locator("[data-new=\"plugin-install\"]").click();
  // Anchored: hasText matches substrings, and the preview table above still
  // holds "e2e-bundled-skill", which contains the plugin's own name.
  await expect(settings(page).locator("td.name", { hasText: new RegExp(`^${PLUGIN}$`) })).toBeVisible();

  // What it installed is an ordinary row in each table — nothing downstream
  // learns that plugins exist, which is the design.
  const skills = await (await request.get("/api/skills")).json();
  const skill = skills.find((s: { skillName: string }) => s.skillName === SKILL);
  expect(skill, "the bundle's skill is in the skills table").toBeTruthy();
  expect(skill.source, "marked as one this deployment did not write").toBe("repo");
  expect(skill.visibility, "private, so a bundle does not join everyone's briefing").toBe("private");
  const files = await (await request.get(`/api/skills/${skill.id}/files`)).json();
  expect(files.map((f: { path: string }) => f.path)).toContain("helper.py");

  const servers = await (await request.get("/api/servers")).json();
  const conn = servers.find((s: { serverName: string }) => s.serverName === CONNECTOR);
  expect(conn, "the bundle's connector is in the servers table").toBeTruthy();
  expect(conn.enabled, "switched off on arrival").toBe(false);

  // And the skill it brought is refused an edit, because it is edited where
  // it is published. Asserted at the API because the console has no form for
  // it — the refusal is the engine's, not the console's politeness.
  const refused = await request.put(`/api/skills/${skill.id}`, { data: skill });
  expect(refused.status()).toBe(400);
  expect(await refused.text()).toContain("copy it to a local skill");

  // Remove, and the two rows go with it.
  const plugins = await (await request.get("/api/plugins")).json();
  const row = plugins.find((p: { pluginName: string }) => p.pluginName === PLUGIN);
  await request.delete(`/api/plugins/${row.id}`);
  const afterSkills = await (await request.get("/api/skills")).json();
  expect(afterSkills.some((s: { skillName: string }) => s.skillName === SKILL)).toBe(false);
  const afterServers = await (await request.get("/api/servers")).json();
  expect(afterServers.some((s: { serverName: string }) => s.serverName === CONNECTOR)).toBe(false);
});

test("the directory offers all four shelves under tabs", async ({ page }) => {
  await open(page);
  // The + menu's Skills row opens the directory; the tabs are how you reach
  // the other two without closing it.
  const plus = shell(page).locator("nr-chatbot");
  await expect(plus).toBeVisible();
  await page.evaluate(() => {
    const root = document.querySelector("agent-console")?.shadowRoot;
    (root?.querySelector("agent-console") as unknown as { gallery?: string });
  });
  // Driven through the element's own state rather than the component's
  // dropdown: the + menu lives in nr-chatbot's shadow root and opens on a
  // pointer sequence this test has no business reproducing. What is under
  // test is the directory, not the library's menu.
  await shell(page).first().evaluate((el: HTMLElement & { gallery?: string }) => { el.gallery = "skills"; });
  const gallery = shell(page).locator(".gallery");
  await expect(gallery).toBeVisible();
  for (const tab of ["Skills", "Agents", "Connectors", "Plugins"]) {
    await expect(gallery.locator(".gallery-tab", { hasText: tab })).toBeVisible();
  }

  await gallery.locator(".gallery-tab", { hasText: "Connectors" }).click();
  await expect(gallery.locator(".gallery-lede")).toContainText("Services this deployment can call");
});

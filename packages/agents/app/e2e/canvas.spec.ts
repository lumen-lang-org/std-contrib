// The agent graph: what it draws, and that editing on it reaches the database.
//
// The canvas is a second view of rows the Settings tables already show, so
// these tests care about two things — that the graph matches the API, and that
// a change made here goes through the same routes Settings uses. A canvas that
// only looked right would be worse than none.

import { expect, test } from "@playwright/test";
import { agentRow, canvas, errorOf, openCanvas, shell } from "./console.js";
import type { Page } from "@playwright/test";

// What a node is labelled. The entry agent says so on the node itself, so its
// label is not simply its name — matching on the bare name misses it, which is
// the sort of thing that only shows up once one agent is the default.
function nodeLabel(a: { agentName: string; isDefault?: boolean }): string {
  return a.isDefault ? `${a.agentName} · entry` : a.agentName;
}

function node(page: Page, a: { agentName: string; isDefault?: boolean }) {
  return canvas(page).getByText(nodeLabel(a), { exact: true }).first();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(shell(page)).toBeVisible();
  await openCanvas(page);
});

test("every agent is a node, and a sub-agent relation is an edge", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; isDefault: boolean; subAgents: { id: string }[] }[];

  const wc = canvas(page).locator("workflow-canvas");
  await expect(wc).toBeVisible();

  // One node per agent, named as the row names it — including a disabled one,
  // which is drawn muted rather than hidden.
  for (const a of agents) {
    await expect(node(page, a)).toBeVisible();
  }

  const relations = agents.reduce((n, a) => n + a.subAgents.length, 0);
  await expect(canvas(page).locator(".note")).toContainText(`${agents.length} agents`);
  await expect(canvas(page).locator(".note")).toContainText(`${relations} delegations`);
});

test("selecting a node opens it with its own values, not a blank form", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; isDefault: boolean; description: string }[];
  const first = agents[0];

  await node(page, first).click();

  await expect(canvas(page).locator("aside h3")).toHaveText(first.agentName);
  await expect(canvas(page).locator("aside .sub")).toHaveText(first.id);
  await expect(canvas(page).locator("#c-name")).toHaveValue(first.agentName);
  await expect(canvas(page).locator("#c-desc")).toHaveValue(first.description);
});

test("editing a field on the canvas is stored, and the graph says so", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; isDefault: boolean }[];
  const target = agents[0];
  const renamed = `${target.agentName}-canvas`;

  await node(page, target).click();
  await canvas(page).locator("#c-name").fill(renamed);
  await canvas(page).locator("aside button.primary").click();
  await expect(canvas(page).locator("aside .saved")).toHaveText("saved");

  // The database, not the drawing.
  const after = (await page.request.get(`/api/agents/${target.id}`).then((r) => r.json())) as
    { agentName: string };
  expect(after.agentName).toBe(renamed);

  // And the node is relabelled without a reload.
  await expect(node(page, { agentName: renamed, isDefault: target.isDefault })).toBeVisible();

  // Put it back, so the suite can run twice.
  await page.request.put(`/api/agents/${target.id}`, {
    data: agentRow(await page.request.get(`/api/agents/${target.id}`).then((r) => r.json()),
      { agentName: target.agentName }),
  });
});

test("the canvas refuses what the API refuses, rather than drawing it anyway", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; isDefault: boolean }[];
  const target = agents[0];

  await node(page, target).click();
  await canvas(page).locator("#c-name").fill("   ");
  await canvas(page).locator("aside button.primary").click();

  // The sentence the API answered, shown where the edit was made.
  await expect(canvas(page).locator("aside .problem")).toBeVisible();
  await expect(canvas(page).locator("aside .saved")).toHaveCount(0);

  // And nothing was stored.
  const after = (await page.request.get(`/api/agents/${target.id}`).then((r) => r.json())) as
    { agentName: string };
  expect(after.agentName).toBe(target.agentName);
});

test("a relation drawn on the canvas is stored through the sub-agent route", async ({ page }) => {
  const before = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; subAgents: { id: string }[] }[];
  test.skip(before.length < 2, "a relation needs two agents");

  // Drawn through the API the canvas itself calls, then the view is checked —
  // the drag gesture belongs to the canvas component's own tests, the wiring
  // is what belongs here.
  const parent = before.find((a) => a.subAgents.length === 0);
  const child = before.find((a) => parent && a.id !== parent.id);
  test.skip(!parent || !child, "no free pair to link");

  await page.request.post(`/api/agents/${parent!.id}/sub-agents`, {
    data: { childId: child!.id },
  });
  await page.reload();
  await openCanvas(page);

  const after = (await page.request.get("/api/agents").then((r) => r.json())) as
    { subAgents: { id: string }[] }[];
  const relations = after.reduce((n, a) => n + a.subAgents.length, 0);
  await expect(canvas(page).locator(".note")).toContainText(`${relations} delegations`);

  await page.request.delete(`/api/agents/${parent!.id}/sub-agents/${child!.id}`);
});

test("an agent may not be its own sub-agent", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string }[];
  const res = await page.request.post(`/api/agents/${agents[0].id}/sub-agents`, {
    data: { childId: agents[0].id },
  });
  expect(res.ok()).toBeFalsy();
});

test("an MCP server is a node too, and its tool links are edges", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; serverName: string }[];
  test.skip(servers.length === 0, "no servers configured");

  for (const s of servers) {
    await expect(canvas(page).getByText(s.serverName, { exact: true }).first()).toBeVisible();
  }

  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { servers: { id: string }[] }[];
  const tools = agents.reduce((n, a) => n + a.servers.length, 0);
  await expect(canvas(page).locator(".note")).toContainText(`${servers.length} servers`);
  await expect(canvas(page).locator(".note")).toContainText(`${tools} tool links`);
});

test("the entry agent is marked on the node, not left to a colour", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { agentName: string; isDefault: boolean }[];
  const entry = agents.find((a) => a.isDefault);
  test.skip(!entry, "no default agent");

  // The word is on the node, so the graph reads without a legend.
  await expect(canvas(page).getByText(`${entry!.agentName} · entry`).first()).toBeVisible();

  // And only one node carries it, because only one agent can.
  expect(agents.filter((a) => a.isDefault)).toHaveLength(1);
});

test("selecting a server opens the server form, not the agent one", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; serverName: string; endpoint: string; transport: string }[];
  test.skip(servers.length === 0, "no servers configured");
  const s = servers[0];

  await canvas(page).getByText(s.serverName, { exact: true }).first().click();

  await expect(canvas(page).locator("aside .sub")).toContainText("MCP server");
  await expect(canvas(page).locator("#s-endpoint")).toHaveValue(s.endpoint);
  await expect(canvas(page).locator("#s-transport")).toHaveValue(s.transport);
  // The agent form is not also on screen.
  await expect(canvas(page).locator("#c-name")).toHaveCount(0);
});

test("editing a server on the canvas is stored", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; serverName: string; endpoint: string }[];
  test.skip(servers.length === 0, "no servers configured");
  const s = servers[0];
  const moved = "http://127.0.0.1:9999/mcp";

  await canvas(page).getByText(s.serverName, { exact: true }).first().click();
  await canvas(page).locator("#s-endpoint").fill(moved);
  await canvas(page).locator("aside button.primary").click();
  await expect(canvas(page).locator("aside .saved")).toHaveText("saved");

  const after = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; endpoint: string }[];
  expect(after.find((x) => x.id === s.id)?.endpoint).toBe(moved);

  // Put it back.
  await canvas(page).locator("#s-endpoint").fill(s.endpoint);
  await canvas(page).locator("aside button.primary").click();
  await expect(canvas(page).locator("aside .saved")).toHaveText("saved");
});

test("a transport the client cannot speak is refused on create as well as update", async ({ page }) => {
  // These two paths disagreed: create took "stdio" and update refused it, so a
  // server could be made that could never afterwards be saved.
  const res = await page.request.post("/api/servers", {
    data: {
      id: `e2e_${Date.now()}`, serverName: "spawned", transport: "stdio",
      endpoint: "mcp-fs", authKind: "none", authHeader: "", enabled: true,
    },
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("speaks http");
});

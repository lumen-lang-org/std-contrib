// The agent graph: what it draws, and that editing on it reaches the database.
//
// The canvas is a second view of rows the Settings tables already show, so
// these tests care about two things — that the graph matches the API, and that
// a change made here goes through the same routes Settings uses. A canvas that
// only looked right would be worse than none.

import { expect, test } from "@playwright/test";
import { agentRow, canvas, errorOf, field, open, openCanvas, ready, shell } from "./console.js";
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
  await open(page);
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
  await expect(field(canvas(page), "c-name")).toHaveValue(first.agentName);
  await expect(field(canvas(page), "c-desc")).toHaveValue(first.description);
});

test("editing a field on the canvas is stored, and the graph says so", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; isDefault: boolean }[];
  const target = agents[0];
  const renamed = `${target.agentName}-canvas`;

  await node(page, target).click();
  await field(canvas(page), "c-name").fill(renamed);
  await canvas(page).locator("aside nr-button[type=primary]").click();
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
  await field(canvas(page), "c-name").fill("   ");
  await canvas(page).locator("aside nr-button[type=primary]").click();

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
  await ready(page);
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
  await expect(field(canvas(page), "s-endpoint")).toHaveValue(s.endpoint);
  await expect(canvas(page).locator("#s-transport")).toContainText(s.transport);
  // The agent form is not also on screen.
  await expect(canvas(page).locator("#c-name")).toHaveCount(0);
});

test("editing a server on the canvas is stored", async ({ page }) => {
  // On a server this test made, not on whichever row came back first.
  //
  // It used to move the endpoint of `servers[0]`, and that is a row a person
  // configured: once a bearer token has been stored for its address, the API
  // refuses to point it somewhere else — "its token was stored for that
  // address; pointing it at … would send the secret there too" — because
  // moving the endpoint under a stored secret is how a credential is leaked to
  // a host that was never meant to have it. Correct behaviour, and a test that
  // asserts a save cannot also depend on nobody having set a token on the
  // first server in the list. So the row under test is created here, with no
  // credential of its own, and deleted at the end.
  const id = `e2e_canvas_${Date.now()}`;
  const made = await page.request.post("/api/servers", {
    data: {
      id, serverName: `canvas-edit-${id}`, transport: "http",
      endpoint: "http://127.0.0.1:9998/mcp", authKind: "none", authHeader: "", enabled: true,
    },
  });
  expect(made.status()).toBe(201);

  try {
    // The graph was drawn before that row existed.
    await page.reload();
    await ready(page);
    await expect(shell(page)).toBeVisible();
    await openCanvas(page);

    const moved = "http://127.0.0.1:9999/mcp";
    await canvas(page).getByText(`canvas-edit-${id}`, { exact: true }).first().click();
    await field(canvas(page), "s-endpoint").fill(moved);
    await canvas(page).locator("aside nr-button[type=primary]").click();
    await expect(canvas(page).locator("aside .saved")).toHaveText("saved");

    const after = (await page.request.get("/api/servers").then((r) => r.json())) as
      { id: string; endpoint: string }[];
    expect(after.find((x) => x.id === id)?.endpoint).toBe(moved);
  } finally {
    await page.request.delete(`/api/servers/${id}`);
  }
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

test("a server's tools are nodes of their own, read from the server", async ({ page }) => {
  // Which server the double is behind. Asked of the API rather than assumed,
  // so the test does not care which seeded row points at it.
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; serverName: string }[];
  const listings = await Promise.all(servers.map(async (s) => ({
    server: s,
    listing: (await page.request.get(`/api/servers/${s.id}/tools`).then((r) => r.json())) as
      { problem: string; tools: { name: string }[] },
  })));
  const answering = listings.find((l) => l.listing.problem === "" && l.listing.tools.length > 0);
  test.skip(!answering, "no MCP server is answering");

  for (const t of answering!.listing.tools) {
    await expect(canvas(page).getByText(t.name, { exact: true }).first()).toBeVisible();
  }
  const total = listings.reduce((n, l) => n + l.listing.tools.length, 0);
  await expect(canvas(page).locator(".note")).toContainText(`${total} tools`);
});

test("a tool is shown, not offered as a form", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string }[];
  const listings = await Promise.all(servers.map(async (s) =>
    (await page.request.get(`/api/servers/${s.id}/tools`).then((r) => r.json())) as
      { problem: string; tools: { name: string; description: string }[] }));
  const tool = listings.flatMap((l) => l.tools)[0];
  test.skip(!tool, "no tools to select");

  await canvas(page).getByText(tool.name, { exact: true }).first().click();

  await expect(canvas(page).locator("aside h3")).toHaveText(tool.name);
  await expect(canvas(page).locator("aside .sub")).toContainText("offered by");
  // Nothing editable: a tool is the server's to declare.
  await expect(canvas(page).locator("aside nr-input")).toHaveCount(0);
  await expect(canvas(page).locator("aside nr-button")).toHaveCount(0);
});

test("a server that cannot be reached says so rather than looking empty", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; serverName: string }[];
  const listings = await Promise.all(servers.map(async (s) => ({
    server: s,
    listing: (await page.request.get(`/api/servers/${s.id}/tools`).then((r) => r.json())) as
      { problem: string },
  })));
  const broken = listings.find((l) => l.listing.problem !== "");
  test.skip(!broken, "every server is answering");

  await canvas(page).getByText(broken!.server.serverName, { exact: true }).first().click();
  // The reason, where the server is being looked at — not an empty tool list
  // that reads as "this server offers nothing".
  await expect(canvas(page).locator("aside .problem")).toContainText("no tools drawn");
});

test("every icon the graph asks for is one nr-icon has", async ({ page }) => {
  // A name the set does not carry is rendered as the name itself, which puts a
  // word like "function" across the node's title. It looks like a layout bug
  // and it is a typo, so it is worth catching by asking the component rather
  // than by reading the picture.
  const missing = await page.evaluate(() => {
    const seen: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName.toLowerCase() === "nr-icon") {
          const name = el.getAttribute("name") ?? "";
          // An icon that resolved draws an <svg>; one that did not shows text.
          if (name !== "" && !el.shadowRoot?.querySelector("svg")) seen.push(name);
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return seen;
  });
  expect(missing).toEqual([]);
});

test("double-clicking a node opens the inspector, not a second editor", async ({ page }) => {
  // The canvas brings its own configuration panel. It edits the workflow
  // object in memory and fires workflow-changed, which this console only reads
  // for edge changes — so a name typed there is dropped on the next load with
  // no error. One editor, and it is the one that can save.
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; isDefault: boolean }[];
  const target = agents[0];

  await node(page, target).dblclick();

  // The canvas's own panel is not left open.
  await expect(canvas(page).locator("workflow-canvas .config-panel")).toHaveCount(0);
  await expect(canvas(page).getByText("Connect nodes to the agent's input ports"))
    .toHaveCount(0);

  // The inspector has it instead, showing the stored name rather than the
  // node's label — which for the entry agent carries a "· entry" suffix.
  await expect(canvas(page).locator("aside h3")).toHaveText(target.agentName);
  await expect(field(canvas(page), "c-name")).toHaveValue(target.agentName);
});

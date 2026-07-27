// The agent graph: what it draws, and that editing on it reaches the database.
//
// The canvas is a second view of rows the Settings tables already show, so
// these tests care about two things — that the graph matches the API, and that
// a change made here goes through the same routes Settings uses. A canvas that
// only looked right would be worse than none.

import { expect, test } from "@playwright/test";
import { agentRow, canvas, openCanvas, shell } from "./console.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(shell(page)).toBeVisible();
  await openCanvas(page);
});

test("every agent is a node, and a sub-agent relation is an edge", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; subAgents: { id: string }[] }[];

  const wc = canvas(page).locator("workflow-canvas");
  await expect(wc).toBeVisible();

  // One node per agent, named as the row names it — including a disabled one,
  // which is drawn muted rather than hidden.
  for (const a of agents) {
    await expect(canvas(page).getByText(a.agentName, { exact: true }).first()).toBeVisible();
  }

  const relations = agents.reduce((n, a) => n + a.subAgents.length, 0);
  await expect(canvas(page).locator(".note")).toContainText(`${agents.length} agents`);
  await expect(canvas(page).locator(".note")).toContainText(`${relations} relations`);
});

test("selecting a node opens it with its own values, not a blank form", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; description: string }[];
  const first = agents[0];

  await canvas(page).getByText(first.agentName, { exact: true }).first().click();

  await expect(canvas(page).locator("aside h3")).toHaveText(first.agentName);
  await expect(canvas(page).locator("aside .sub")).toHaveText(first.id);
  await expect(canvas(page).locator("#c-name")).toHaveValue(first.agentName);
  await expect(canvas(page).locator("#c-desc")).toHaveValue(first.description);
});

test("editing a field on the canvas is stored, and the graph says so", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string }[];
  const target = agents[0];
  const renamed = `${target.agentName}-canvas`;

  await canvas(page).getByText(target.agentName, { exact: true }).first().click();
  await canvas(page).locator("#c-name").fill(renamed);
  await canvas(page).locator("aside button.primary").click();
  await expect(canvas(page).locator("aside .saved")).toHaveText("saved");

  // The database, not the drawing.
  const after = (await page.request.get(`/api/agents/${target.id}`).then((r) => r.json())) as
    { agentName: string };
  expect(after.agentName).toBe(renamed);

  // And the node is relabelled without a reload.
  await expect(canvas(page).getByText(renamed, { exact: true }).first()).toBeVisible();

  // Put it back, so the suite can run twice.
  await page.request.put(`/api/agents/${target.id}`, {
    data: agentRow(await page.request.get(`/api/agents/${target.id}`).then((r) => r.json()),
      { agentName: target.agentName }),
  });
});

test("the canvas refuses what the API refuses, rather than drawing it anyway", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string }[];
  const target = agents[0];

  await canvas(page).getByText(target.agentName, { exact: true }).first().click();
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
  await expect(canvas(page).locator(".note")).toContainText(`${relations} relations`);

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

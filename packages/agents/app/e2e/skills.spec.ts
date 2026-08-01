// Skills: the tab, the editor, the files, and the link an agent form draws.
//
// The rule of the suite holds here: the API arranges rows a scenario needs
// and asserts what was really stored; the action under test happens through
// the UI. Skills are the one Settings row that is *edited in place* — a skill
// is read fresh on every use_skill, so there is no version to point at — and
// the third case pins exactly that contrast with prompts.

import { expect, test } from "@playwright/test";
import { field, open, openSettings, openTab, ready, settings, shell, toggle, typeInEditor } from "./console.js";

type SkillRow = { id: string; skillName: string; description: string; body: string };
type AgentFull = { id: string; skills?: { id: string; skillName: string }[] };

test.beforeEach(async ({ page }) => {
  await open(page);
  await expect(shell(page)).toBeVisible();
  await openSettings(page);
});

// Settings reads its lists when it opens, so a row arranged after that is not
// on screen however stored it is. Every test that arranges rows re-opens.
async function reopened(page: Parameters<typeof openSettings>[0]) {
  await page.reload();
  await ready(page);
  await expect(shell(page)).toBeVisible();
  await openSettings(page);
}

test("the skills tab lists every skill with its description", async ({ page }) => {
  const name = `e2e-list-${Date.now()}`;
  await page.request.post("/api/skills", { data: {
    id: `k-${name}`, skillName: name, description: "how to fold the report", body: "Fold it.", updatedAt: "t",
  } });

  await reopened(page);
  await openTab(page, "Skills");
  const row = settings(page).locator("tr", { hasText: name });
  await expect(row).toContainText("how to fold the report");
  await expect(row.locator('button[title^="Edit"]')).toBeVisible();
  await expect(row.locator('button[title^="Delete"]')).toBeVisible();

  await page.request.delete(`/api/skills/k-${name}`);
});

test("the skill editor stores the markdown typed into it, and shows its structure", async ({ page }) => {
  await openTab(page, "Skills");
  const name = `e2e-md-${Date.now()}`;
  const body = "# Procedure\n\nRun it, **never** retype it.";

  await settings(page).locator('button[data-new="skill"]').click();
  await field(settings(page), "sk-name").fill(name);
  await field(settings(page), "sk-id").fill(`k-${name}`);
  await field(settings(page), "sk-desc").fill("when the validator names an enum");
  await typeInEditor(settings(page), "sk-body", body);

  // Marked up as markdown while it is written, like the prompt editor.
  await expect(settings(page).locator("#sk-body .hljs-section")).toHaveCount(1);
  await expect(settings(page).locator("#sk-body .hljs-strong")).toHaveCount(1);

  await settings(page).locator("button", { hasText: "Save" }).first().click();
  const skills = (await page.request.get("/api/skills").then((r) => r.json())) as SkillRow[];
  expect(skills.find((k) => k.skillName === name)?.body).toBe(body);

  await page.request.delete(`/api/skills/k-${name}`);
});

test("editing a skill replaces its body rather than growing a version", async ({ page }) => {
  const name = `e2e-edit-${Date.now()}`;
  await page.request.post("/api/skills", { data: {
    id: `k-${name}`, skillName: name, description: "d", body: "First body.", updatedAt: "t",
  } });

  await reopened(page);
  await openTab(page, "Skills");
  await settings(page).locator("tr", { hasText: name }).locator('button[title^="Edit"]').click();
  await typeInEditor(settings(page), "sk-body", "Second body.");
  await settings(page).locator("button", { hasText: "Save" }).first().click();

  // One row still — the deliberate contrast with prompts, whose save mints a
  // version. A skill is read fresh at call time, so the edit IS the rollout.
  await expect(settings(page).locator("tr", { hasText: name })).toHaveCount(1);
  const skills = (await page.request.get("/api/skills").then((r) => r.json())) as SkillRow[];
  const mine = skills.filter((k) => k.skillName === name);
  expect(mine.length).toBe(1);
  expect(mine[0].body).toBe("Second body.");

  await page.request.delete(`/api/skills/k-${name}`);
});

test("assigning a skill to an agent survives the round trip", async ({ page }) => {
  const name = `e2e-link-${Date.now()}`;
  await page.request.post("/api/skills", { data: {
    id: `k-${name}`, skillName: name, description: "attach me", body: "b", updatedAt: "t",
  } });
  // A throwaway agent, so the link touches nothing anyone else uses.
  const agentId = `a-${name}`;
  const configs = (await page.request.get("/api/model-configs").then((r) => r.json())) as { id: string }[];
  const prompts = (await page.request.get("/api/prompts").then((r) => r.json())) as { id: string }[];
  await page.request.post("/api/agents", { data: {
    id: agentId, agentName: name, description: "e2e", modelConfigId: configs[0].id,
    promptId: prompts[0].id, scriptImageId: "", isDefault: false, enabled: true, updatedAt: "t",
  } });

  // Fresh page state so the settings panel's agent list carries the new rows.
  await reopened(page);
  await openTab(page, "Agents");
  await settings(page).locator("tr", { hasText: name }).locator('button[title^="Edit"]').click();
  await toggle(settings(page), `a-skill-${name}`).click();
  await settings(page).locator("button", { hasText: "Save" }).first().click();

  // Stored, not just drawn: the full view carries the link.
  await expect(async () => {
    const agents = (await page.request.get("/api/agents").then((r) => r.json())) as AgentFull[];
    expect((agents.find((a) => a.id === agentId)?.skills ?? []).map((s) => s.skillName)).toContain(name);
  }).toPass();

  // And the form reopens with the box checked.
  await settings(page).locator("tr", { hasText: name }).locator('button[title^="Edit"]').click();
  await expect(toggle(settings(page), `a-skill-${name}`)).toBeChecked();

  await page.request.delete(`/api/agents/${agentId}`);
  await page.request.delete(`/api/skills/k-${name}`);
});

test("a skill's files are added and edited from its form", async ({ page }) => {
  const name = `e2e-file-${Date.now()}`;
  await page.request.post("/api/skills", { data: {
    id: `k-${name}`, skillName: name, description: "ships a file", body: "run it", updatedAt: "t",
  } });

  await reopened(page);
  await openTab(page, "Skills");
  await settings(page).locator("tr", { hasText: name }).locator('button[title^="Edit"]').click();
  await field(settings(page), "sk-newfile").fill("hello.py");
  await settings(page).locator('button[data-new="skill-file"]').click();

  // The file appears with its own editor, and the store agrees.
  await expect(settings(page).locator("#sk-file-hello\\.py")).toBeVisible();
  const files = (await page.request.get(`/api/skills/k-${name}/files`).then((r) => r.json())) as
    { path: string }[];
  expect(files.map((f) => f.path)).toContain("hello.py");

  await page.request.delete(`/api/skills/k-${name}`);
});

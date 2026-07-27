// The knowledge page: the folder tree, the file list, and what an upload does
// before it has finished indexing.
//
// Skips itself on sqlite. Documents need pgvector, the API says so plainly,
// and reporting that as a failure would be reporting correct behaviour.

import { Page, expect, test } from "@playwright/test";
import { errorOf, hasPostgres, knowledge, openKnowledge, shell } from "./console.js";

// A corpus the tree tests can actually read.
//
// Every one of these tests used to skip itself on an empty database — which
// reads as a pass and proves nothing. The suite is responsible for its own
// preconditions, so it puts two documents at two depths and works from those.
// The sources are fixed names and upload is an upsert, so running the suite
// twice leaves the same two rows rather than a growing pile.
const CORPUS = [
  { source: "e2e_intro", scope: "/guides", body: "The guide that sits at the top level." },
  { source: "e2e_deep", scope: "/guides/deep", body: "The guide one level further down." },
];

let seeded = false;

async function seedCorpus(page: Page) {
  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; kind: string; provider: string; enabled: boolean }[];
  const embedder = models.find((m) => m.kind === "embedding" && m.enabled);
  if (!embedder) return;
  // Upload refuses a provider it has no credential for, which is right: it
  // will not queue work it cannot carry out. So the fixture walks the same
  // path a person does and configures one first. The key is never used —
  // nothing here reaches the provider, because the API only enqueues and the
  // indexer is a separate process — but it has to be present.
  await page.request.put(`/api/providers/${embedder.provider}/key`, {
    data: { apiKey: "e2e-not-a-real-key" },
  });
  for (const doc of CORPUS) {
    await page.request.post(`/api/documents?model=${embedder.id}`, { data: doc });
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(shell(page)).toBeVisible();
  test.skip(!(await hasPostgres(page)), "documents need PostgreSQL (pgvector)");
  if (!seeded) {
    await seedCorpus(page);
    seeded = true;
    await page.goto("/");
  }
  await openKnowledge(page);
});

test("the rail nests folders rather than listing paths", async ({ page }) => {
  const scopes = (await page.request.get("/api/scopes").then((r) => r.json())) as
    { path: string }[];
  test.skip(scopes.length === 0, "no corpus to draw");

  // A path with two segments must appear as two rows at different indents,
  // not one row spelling the whole path.
  const nested = scopes.find((s) => s.path.split("/").length > 2);
  test.skip(!nested, "no nested folder in this corpus");

  const leaf = nested!.path.slice(nested!.path.lastIndexOf("/") + 1);
  const parent = nested!.path.split("/")[1];
  await expect(knowledge(page).locator(".scope .name", { hasText: new RegExp(`^${leaf}$`) })).toBeVisible();
  await expect(knowledge(page).locator(".scope .name", { hasText: new RegExp(`^${parent}$`) })).toBeVisible();
  await expect(knowledge(page).locator(".scope", { hasText: nested!.path })).toHaveCount(0);
});

test("a folder's count includes what is underneath it", async ({ page }) => {
  const scopes = (await page.request.get("/api/scopes").then((r) => r.json())) as
    { path: string; documents: number; total: number }[];
  const branch = scopes.find((s) => s.total > s.documents);
  test.skip(!branch, "no folder with documents below it");

  const name = branch!.path.slice(branch!.path.lastIndexOf("/") + 1);
  const row = knowledge(page).locator(".scope", { hasText: new RegExp(`^\\s*[▾▸]?\\s*${name}`) }).first();
  await expect(row.locator("small")).toHaveText(String(branch!.total));
});

test("collapsing a branch hides its children and keeps its count", async ({ page }) => {
  // Open/closed is an attribute on the row, not a glyph to read back.
  const branch = knowledge(page).locator('.scope[data-open="true"]').first();
  test.skip((await branch.count()) === 0, "no branch to collapse");

  const path = await branch.getAttribute("data-path");
  const before = await knowledge(page).locator(".scope").count();
  const count = await branch.locator("small").textContent();

  await branch.locator(".twist").click();

  const same = knowledge(page).locator(`.scope[data-path="${path}"]`);
  await expect(same).toHaveAttribute("data-open", "false");
  expect(await knowledge(page).locator(".scope").count()).toBeLessThan(before);
  // Still there, still saying how much it holds.
  await expect(same.locator("small")).toHaveText(count ?? "");
});

test("the file list shows subfolders above the documents, and navigates", async ({ page }) => {
  const scopes = (await page.request.get("/api/scopes").then((r) => r.json())) as
    { path: string }[];
  const parentPath = scopes.map((s) => s.path).find((p) =>
    scopes.some((o) => o.path.startsWith(p + "/")));
  test.skip(!parentPath, "no folder with a subfolder");

  const name = parentPath!.slice(parentPath!.lastIndexOf("/") + 1);
  await knowledge(page).locator(".scope .name", { hasText: new RegExp(`^${name}$`) }).click();

  const folders = knowledge(page).locator("tr.folder");
  await expect(folders.first()).toBeVisible();

  // Clicking one moves into it, and the parent row comes back out.
  const child = folders.filter({ hasText: "📁" }).first();
  const childName = (await child.locator("td").first().textContent())?.replace("📁", "").trim();
  await child.click();
  await expect(knowledge(page).locator(".title")).toContainText(childName ?? "");
  await knowledge(page).locator("tr.folder", { hasText: "↩" }).click();
  await expect(knowledge(page).locator(".title")).toContainText(parentPath!);
});

test("the active embedding model is named, not chosen per upload", async ({ page }) => {
  await expect(knowledge(page).locator("select[name=model]")).toHaveCount(0);
  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { kind: string; enabled: boolean; label: string }[];
  const active = models.find((m) => m.kind === "embedding" && m.enabled);
  // `.note` is also used inside the table; the embedder line is the one that
  // follows the upload row.
  const line = knowledge(page).locator("main > .note").first();
  if (active) {
    await expect(line).toContainText(active.label);
  } else {
    await expect(line).toContainText("No embedding model");
    await expect(knowledge(page).locator("button", { hasText: "Upload" })).toBeDisabled();
  }
});

test("an uploaded document appears as queued before it is indexed", async ({ page }) => {
  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; kind: string; enabled: boolean }[];
  const embedder = models.find((m) => m.kind === "embedding" && m.enabled);
  test.skip(!embedder, "no embedding model enabled");

  const source = `e2e_queued_${Date.now()}`;
  const scope = "/e2e/queue";
  const res = await page.request.post(`/api/documents?model=${embedder!.id}`, {
    data: { source, scope, body: "A document queued by the end-to-end suite." },
  });
  // Accepted, not created: the work is taken, not done.
  expect(res.status()).toBe(202);

  const listed = (await page.request
    .get(`/api/documents?scope=${encodeURIComponent(scope)}`)
    .then((r) => r.json())) as { source: string; status: string }[];
  const mine = listed.find((d) => d.source === source);
  expect(mine).toBeDefined();
  expect(["queued", "indexing", "indexed"]).toContain(mine!.status);

  await page.request.delete(`/api/documents/${source}`);
});

test("a document with a name that is not a plain identifier is refused", async ({ page }) => {
  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; kind: string; enabled: boolean }[];
  const embedder = models.find((m) => m.kind === "embedding" && m.enabled);
  test.skip(!embedder, "no embedding model enabled");

  // Chunk ids are built from the source, so a source must be a plain name.
  const res = await page.request.post(`/api/documents?model=${embedder!.id}`, {
    data: { source: "a b; DROP TABLE documents", scope: "/e2e", body: "text" },
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toMatch(/plain name|source/i);
});

test("uploading without naming the embedding model is refused", async ({ page }) => {
  const res = await page.request.post("/api/documents", {
    data: { source: "e2e_nomodel", scope: "/e2e", body: "text" },
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("model");
});

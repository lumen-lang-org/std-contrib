// Settings: every field a person can fill, and what the server does with it.
//
// These assert the *sentence* a refusal comes back with rather than a status
// code, because the sentence is what the console shows and what a user acts
// on. A refusal that arrives as an unreadable 500 passes a status assertion
// and fails a person.

import { expect, test } from "@playwright/test";
import {
  agentRow, choices, choose, field, modelRow, errorOf, openSettings, openTab, settings, shell,
  toggle, typeInEditor,
} from "./console.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(shell(page)).toBeVisible();
  await openSettings(page);
});

// --- agents ---------------------------------------------------------------------------

test("the agents tab lists every agent with its model config and prompt", async ({ page }) => {
  await openTab(page, "Agents");
  const rows = settings(page).locator("tr");
  const listed = (await page.request.get("/api/agents").then((r) => r.json())) as unknown[];
  await expect(rows).toHaveCount(listed.length);
  // Each row offers the actions that open it and remove it. They are icons, so
  // each is named by what it does rather than by the glyph it draws.
  await expect(rows.first().locator("button.act").first()).toHaveAttribute("title", /^Edit /);
  await expect(rows.first().locator("button.act").last()).toHaveAttribute("title", /^Delete /);
});

test("the edit form offers every editable field, each one labelled", async ({ page }) => {
  // Every field is a labelled box rather than a placeholder that leaves as
  // soon as it is typed into — that is the whole difference between this form
  // and the strip of anonymous inputs it replaced.
  await openTab(page, "Agents");
  await settings(page).locator("tr").first().locator("button.act").first().click();

  const form = settings(page).locator(".grid");
  await expect(form.locator(".f", { hasText: "Name" }).first()).toBeVisible();
  await expect(field(settings(page), "a-name")).toBeVisible();
  await expect(field(settings(page), "a-desc")).toBeVisible();
  await expect(settings(page).locator("#a-config")).toBeVisible();
  await expect(settings(page).locator("#a-prompt")).toBeVisible();
  await expect(toggle(settings(page), "a-enabled")).toBeVisible();
  await expect(toggle(settings(page), "a-default")).toBeVisible();

  // The id cannot be retyped: it is what every other row points at.
  await expect(settings(page).locator("#a-id input")).toBeDisabled();
});

test("cancel leaves the agent as it was", async ({ page }) => {
  await openTab(page, "Agents");
  const before = await settings(page).locator("tr").first().textContent();

  await settings(page).locator("tr").first().locator("button.act").first().click();
  await field(settings(page), "a-desc").fill("typed then abandoned");
  await settings(page).locator("button", { hasText: "Cancel" }).click();

  await expect(settings(page).locator("tr").first()).toHaveText(before ?? "");
});

test("editing an agent saves and the row shows it", async ({ page }) => {
  await openTab(page, "Agents");
  const mark = `edited at ${Date.now()}`;

  await settings(page).locator("tr").first().locator("button.act").first().click();
  await field(settings(page), "a-desc").fill(mark);
  await settings(page).locator("button", { hasText: "Save" }).click();

  await expect(settings(page).locator("tr").first()).toContainText(mark);
  // And it is in the database, not only on the screen.
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as { description: string }[];
  expect(agents.some((a) => a.description === mark)).toBe(true);
});

test("an agent cannot be pointed at a model config that does not exist", async ({ page }) => {
  // Only the row's own columns: GET answers the full view with prompt, config,
  // servers and sub-agents nested, and JSON.parse refuses fields the record
  // does not declare. This is the same trap the console fell into.
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    Record<string, unknown>[];
  const res = await page.request.put(`/api/agents/${agents[0].id}`, {
    data: agentRow(agents[0], { modelConfigId: "no-such-config" }),
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("no model config");
});

// --- models ---------------------------------------------------------------------------

test("enabling a second embedder from its form turns the first one off", async ({ page }) => {
  // The rule lives in the row's PUT, so it holds however the row is written —
  // but this is the door a person actually uses, and it was a bare radio button
  // in a table with nothing on screen saying what checking it would cost.
  //
  // The second embedder is made here rather than found: the one this database
  // ships with is an Ollama model, and the server has no embedding endpoint for
  // Ollama, so the save is refused for a reason that has nothing to do with the
  // rule under test.
  const id = `e2e_ui_emb_${Date.now()}`;
  const label = `Second Embedder ${id}`;
  const before = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; label: string; kind: string; enabled: boolean }[];
  const was = before.find((m) => m.kind === "embedding" && m.enabled);
  await page.request.post("/api/models", {
    data: modelRow({ id, label, apiName: "mistral-embed", provider: "mistral",
      kind: "embedding", dimensions: 1024, enabled: false }),
  });

  await page.reload();
  await openSettings(page);
  await openTab(page, "Models");
  await settings(page).locator("tr", { hasText: label }).locator('button[title^="Edit"]').click();
  await toggle(settings(page), "m-enabled").click();
  await settings(page).locator("button", { hasText: "Save" }).click();

  await expect(settings(page).locator("tr", { hasText: label })).toContainText("on");
  const after = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; kind: string; enabled: boolean }[];
  const on = after.filter((m) => m.kind === "embedding" && m.enabled);
  expect(on).toHaveLength(1);
  expect(on[0].id).toBe(id);

  // Put the corpus back: leaving a different embedder active would silently
  // split it for every spec that runs afterwards.
  await page.request.delete(`/api/models/${id}`);
  if (was) {
    await page.request.put(`/api/models/${was.id}`, { data: modelRow({ ...was, enabled: true }) });
  }
});

test("models are grouped by what they are for, each group counted", async ({ page }) => {
  await openTab(page, "Models");
  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { kind: string }[];
  const embedders = models.filter((m) => m.kind === "embedding").length;

  const groups = settings(page).locator(".group");
  await expect(groups.filter({ hasText: "Generation" })).toContainText(
    String(models.length - embedders));
  await expect(groups.filter({ hasText: "Embedding" })).toContainText(String(embedders));
});

test("a model id that is already taken is refused rather than overwriting", async ({ page }) => {
  const models = (await page.request.get("/api/models").then((r) => r.json())) as { id: string }[];
  const res = await page.request.post("/api/models", {
    data: {
      id: models[0].id, label: "Impostor", apiName: "x", provider: "mistral",
      kind: "chat", dimensions: 0, baseUrl: "", enabled: true,
    },
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("already exists");
});

// --- prompts --------------------------------------------------------------------------

test("the prompts tab renders its rows and its form", async ({ page }) => {
  // It rendered neither for a while: the client called the column `content`
  // and the API answers `body`, so the template threw and drew nothing.
  await openTab(page, "Prompts");
  await expect(settings(page).locator("table tr")).not.toHaveCount(0);

  await settings(page).locator('button[data-new="prompt"]').click();
  await expect(field(settings(page), "p-name")).toBeVisible();
  await expect(field(settings(page), "p-body")).toBeVisible();
});

test("a new version starts from the text of the one it follows", async ({ page }) => {
  // Writing the next version of a prompt from a blank box means retyping what
  // was already there, and what gets retyped gets changed by accident.
  await openTab(page, "Prompts");
  const first = settings(page).locator("tbody tr").first();
  await first.locator('button[title^="New version"]').click();

  // The list is ordered by name then version, so the first row is the first
  // version of the first name — and the form opens on *that* row's text.
  const prompts = (await page.request.get("/api/prompts").then((r) => r.json())) as
    { promptName: string; version: number; body: string }[];
  const from = prompts[0];
  const newest = prompts
    .filter((p) => p.promptName === from.promptName)
    .reduce((a, b) => (a.version > b.version ? a : b));

  await expect(field(settings(page), "p-name")).toHaveValue(from.promptName);
  // The editor is a contenteditable, so its text is read, not its value.
  await expect(field(settings(page), "p-body")).toHaveText(from.body);
  // And the head says which version this will become — the next one, never one
  // that already exists.
  await expect(settings(page).locator(".formhead")).toContainText(`version ${newest.version + 1}`);
});

test("the prompt editor stores the markdown typed into it, and shows its structure", async ({ page }) => {
  // A prompt is markdown, so the field is an editor rather than a box: it
  // keeps the whitespace, numbers the lines, and marks the structure up while
  // it is being written. What it must not do is show one thing and store
  // another — the editor is a contenteditable, and text that arrives without
  // a keystroke reaches the screen without ever reaching the draft.
  await openTab(page, "Prompts");
  const name = `e2e_md_${Date.now()}`;
  const body = "# Desk\n\nAnswer **briefly**.\n\n- never invent an order number";

  await settings(page).locator('button[data-new="prompt"]').click();
  await field(settings(page), "p-name").fill(name);
  await typeInEditor(settings(page), "p-body", body);

  // Marked up as markdown, not left as one flat run of text.
  await expect(settings(page).locator("#p-body .hljs-section")).toHaveCount(1);
  await expect(settings(page).locator("#p-body .hljs-strong")).toHaveCount(1);
  // And the lines are numbered, which is how a long prompt is talked about.
  await expect(settings(page).locator("#p-body .line-number")).toHaveCount(5);

  await settings(page).locator("button", { hasText: "Save version" }).click();
  const prompts = (await page.request.get("/api/prompts").then((r) => r.json())) as
    { promptName: string; body: string }[];
  expect(prompts.find((p) => p.promptName === name)?.body).toBe(body);
});

test("saving a prompt creates a new version rather than editing one", async ({ page }) => {
  await openTab(page, "Prompts");
  const name = `e2e_${Date.now()}`;

  await settings(page).locator('button[data-new="prompt"]').click();
  await field(settings(page), "p-name").fill(name);
  await typeInEditor(settings(page), "p-body", "First version.");
  await settings(page).locator("button", { hasText: "Save version" }).click();
  await expect(settings(page).locator("tr", { hasText: name })).toHaveCount(1);

  await settings(page).locator('button[data-new="prompt"]').click();
  await field(settings(page), "p-name").fill(name);
  await typeInEditor(settings(page), "p-body", "Second version.");
  await settings(page).locator("button", { hasText: "Save version" }).click();

  // Two rows, two versions — the first is still there.
  await expect(settings(page).locator("tr", { hasText: name })).toHaveCount(2);
  const prompts = (await page.request.get("/api/prompts").then((r) => r.json())) as
    { promptName: string; version: number; body: string }[];
  const mine = prompts.filter((p) => p.promptName === name).map((p) => p.version).sort();
  expect(mine).toEqual([1, 2]);
});

// --- providers ------------------------------------------------------------------------

test("a stored credential is never handed back", async ({ page }) => {
  await openTab(page, "Providers");
  const res = await page.request.get("/api/providers");
  const body = await res.text();
  // Names only. If this ever contains "sk-" the store is leaking.
  expect(body).not.toContain("sk-");
  expect(body).not.toContain("envelope");
});

test("an empty api key is refused, because an empty envelope is unreadable", async ({ page }) => {
  const res = await page.request.put("/api/providers/mistral/key", { data: { apiKey: "" } });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("empty");
});

// --- tracing --------------------------------------------------------------------------

test("an unknown tracing backend is refused when it is set, not later", async ({ page }) => {
  const res = await page.request.put("/api/tracing", {
    data: {
      id: "default", backend: "datadog", endpoint: "https://example.test/v1/traces",
      publicKey: "", serviceName: "e2e", environment: "test", enabled: true,
    },
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("unknown backend");
});

test("the tracing tab offers exactly the backends the tracer understands", async ({ page }) => {
  await openTab(page, "Tracing");
  const offered = await choices(settings(page), "t-backend").allTextContents();
  expect(offered.map((s) => s.trim()).sort()).toEqual(
    ["arize", "braintrust", "langfuse", "langsmith", "otlp", "phoenix"],
  );
});

test("a partial tracing body is answered, not fatal", async ({ page }) => {
  // The record declares fields this body omits. It must come back as a
  // readable 400 — this used to kill the server outright.
  const res = await page.request.put("/api/tracing", { data: { backend: "otlp" } });
  expect(res.status()).toBe(400);
  // And the server is still there.
  await expect(page.request.get("/api/agents").then((r) => r.status())).resolves.toBe(200);
});

// --- the findings the settings audit confirmed ----------------------------------------

test("an agent cannot be saved with a blank name", async ({ page }) => {
  // A nameless agent sorts first — the list is ordered by name — so it becomes
  // the console's default and every new conversation opens against it.
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    Record<string, unknown>[];
  const res = await page.request.put(`/api/agents/${agents[0].id}`, {
    data: agentRow(agents[0], { agentName: "   " }),
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("needs a name");
});

test("an embedding model must say how wide its vectors are", async ({ page }) => {
  const res = await page.request.post("/api/models", {
    data: modelRow({ id: `e2e_nodim_${Date.now()}`, label: "No Width", apiName: "mistral-embed", provider: "mistral", kind: "embedding", dimensions: 0, enabled: false }),
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("how wide");
});

test("a model naming a provider nothing can reach is refused", async ({ page }) => {
  const res = await page.request.post("/api/models", {
    data: modelRow({ id: `e2e_nowhere_${Date.now()}`, label: "Nowhere", apiName: "x", provider: "nowhere", kind: "chat", dimensions: 0, enabled: false }),
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("no chat endpoint");
});

test("a model that is neither chat nor embedding is refused", async ({ page }) => {
  const res = await page.request.post("/api/models", {
    data: modelRow({ id: `e2e_kind_${Date.now()}`, label: "Odd", apiName: "x", provider: "mistral", kind: "reranker", dimensions: 0, enabled: false }),
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("chat or embedding");
});

test("the models form asks for dimensions only when the kind needs them", async ({ page }) => {
  await openTab(page, "Models");
  await settings(page).locator('button[data-new="model"]').click();
  await expect(settings(page).locator("#m-dimensions")).toHaveCount(0);

  await choose(settings(page), "m-kind", "embedding");
  await expect(settings(page).locator("#m-dimensions")).toBeVisible();
  // And it says what a wrong answer costs, rather than only asking for a number.
  await expect(settings(page).locator(".grid")).toContainText("1024 for mistral-embed");
});

test("saving tracing keeps the service name and environment it was given", async ({ page }) => {
  // These were constants in the form, so opening the tab and pressing Save
  // refiled a staging deployment's traces under "production".
  await page.request.put("/api/tracing", {
    data: {
      id: "default", backend: "otlp", endpoint: "http://127.0.0.1:4318/v1/traces",
      publicKey: "", serviceName: "e2e-service", environment: "staging", enabled: false,
    },
  });
  // Settings reads the row when it mounts, and beforeEach already opened it —
  // so the change above has to be made visible by opening it again.
  await page.reload();
  await openSettings(page);
  await openTab(page, "Tracing");
  await expect(field(settings(page), "t-service")).toHaveValue("e2e-service");
  await expect(field(settings(page), "t-env")).toHaveValue("staging");

  await settings(page).locator("button", { hasText: "Save" }).click();
  const after = (await page.request.get("/api/tracing").then((r) => r.json())) as
    { serviceName: string; environment: string };
  expect(after.serviceName).toBe("e2e-service");
  expect(after.environment).toBe("staging");
});

test("every provider the console offers is one the code can reach", async ({ page }) => {
  await openTab(page, "Providers");
  await settings(page).locator('button[data-new="key"]').click();
  const offered = await choices(settings(page), "k-provider").allTextContents();
  expect(offered.map((s) => s.trim()).sort()).toEqual(["anthropic", "mistral", "openai"]);
});


// --- every field round-trips through its row PUT ---------------------------------------

test("a model's whole row round-trips, base url included", async ({ page }) => {
  // Anthropic on purpose: this row is written and read, never called, and no
  // credential is stored for it. A model whose provider has a secret cannot be
  // repointed without clearing that secret first — which is the rule, not a
  // detour around it — and this test is about the columns round-tripping, not
  // about the rule.
  const id = `e2e_row_${Date.now()}`;
  await page.request.post("/api/models", {
    data: {
      id, label: "Row Probe", apiName: "claude-haiku-4-5-20251001", provider: "anthropic",
      kind: "chat", dimensions: 0, baseUrl: "", enabled: false,
    },
  });
  const res = await page.request.put(`/api/models/${id}`, {
    data: {
      id, label: "Row Probe Edited", apiName: "claude-opus-5", provider: "anthropic",
      kind: "chat", dimensions: 0, baseUrl: "http://127.0.0.1:11434/v1", enabled: false,
    },
  });
  expect(res.status()).toBe(200);

  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; label: string; apiName: string; baseUrl: string }[];
  const mine = models.find((m) => m.id === id);
  expect(mine?.label).toBe("Row Probe Edited");
  expect(mine?.apiName).toBe("claude-opus-5");
  expect(mine?.baseUrl).toBe("http://127.0.0.1:11434/v1");
  await page.request.delete(`/api/models/${id}`);
});

test("enabling an embedder through the row PUT still disables the others", async ({ page }) => {
  // The rule has to hold through this door too — that was the whole point of
  // folding it into the row write.
  const id = `e2e_emb_${Date.now()}`;
  const before = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; label: string; apiName: string; provider: string; kind: string;
      dimensions: number; baseUrl: string; enabled: boolean }[];
  const was = before.find((m) => m.kind === "embedding" && m.enabled);

  await page.request.post("/api/models", {
    data: {
      id, label: "Second Embedder", apiName: "mistral-embed", provider: "mistral",
      kind: "embedding", dimensions: 1024, baseUrl: "", enabled: false,
    },
  });
  await page.request.put(`/api/models/${id}`, {
    data: {
      id, label: "Second Embedder", apiName: "mistral-embed", provider: "mistral",
      kind: "embedding", dimensions: 1024, baseUrl: "", enabled: true,
    },
  });
  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; kind: string; enabled: boolean }[];
  expect(models.filter((m) => m.kind === "embedding" && m.enabled)).toHaveLength(1);

  // Put the corpus back the way it was found. Deleting the winner without
  // re-enabling the previous embedder leaves none active, and later specs
  // that need one skip themselves — a test quietly shrinking the suite's own
  // coverage is worse than a test that fails.
  await page.request.delete(`/api/models/${id}`);
  if (was) {
    await page.request.put(`/api/models/${was.id}`, { data: modelRow({ ...was, enabled: true }) });
  }
});

test("exactly one agent is the default, whichever door sets it", async ({ page }) => {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; description: string; modelConfigId: string;
      promptId: string; enabled: boolean }[];
  test.skip(agents.length < 2, "needs two agents");

  for (const a of agents.slice(0, 2)) {
    await page.request.put(`/api/agents/${a.id}`, {
      data: agentRow(a as unknown as Record<string, unknown>, { isDefault: true }),
    });
  }
  const after = (await page.request.get("/api/agents").then((r) => r.json())) as
    { isDefault: boolean }[];
  expect(after.filter((a) => a.isDefault)).toHaveLength(1);
});

test("a server's auth is set without the token ever coming back", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string }[];
  test.skip(servers.length === 0, "no MCP server to configure");

  const res = await page.request.put(`/api/servers/${servers[0].id}/auth`, {
    data: { authKind: "bearer", authHeader: "", token: "secret-e2e-token" },
  });
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).not.toContain("secret-e2e-token");
  expect(body).toContain("bearer");

  const listed = await page.request.get("/api/servers").then((r) => r.text());
  expect(listed).not.toContain("secret-e2e-token");
});

test("a custom header with no name is refused", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string }[];
  test.skip(servers.length === 0, "no MCP server to configure");
  const res = await page.request.put(`/api/servers/${servers[0].id}/auth`, {
    data: { authKind: "header", authHeader: "  ", token: "t" },
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("needs a name");
});

test("a transport the client cannot speak is refused", async ({ page }) => {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; serverName: string; endpoint: string; authKind: string;
      authHeader: string; enabled: boolean }[];
  test.skip(servers.length === 0, "no MCP server to edit");
  const s = servers[0];
  const res = await page.request.put(`/api/servers/${s.id}`, {
    data: { ...s, transport: "stdio" },
  });
  expect(res.status()).toBe(400);
  expect(await errorOf(res)).toContain("subprocess");
});

test("testing a model says what the provider actually answered", async ({ page }) => {
  const models = (await page.request.get("/api/models").then((r) => r.json())) as
    { id: string; provider: string; enabled: boolean; kind: string }[];
  const mistral = models.find((m) => m.provider === "mistral" && m.kind === "chat");
  test.skip(!mistral, "no mistral chat model configured");

  const res = await page.request.post(`/api/models/${mistral!.id}/test`);
  expect(res.status()).toBe(200);
  const out = (await res.json()) as { ok: boolean; reply?: string; error?: string };
  // Either it answered or it said why — never a bare failure with no reason.
  if (out.ok) { expect(out.reply).toBeTruthy(); } else { expect(out.error).toBeTruthy(); }
});

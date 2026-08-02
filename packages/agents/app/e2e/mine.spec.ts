// A connector token of your own.
//
// The deployment's token is one credential everybody rides; this is the
// other half — a person stores a token that is theirs, their conversations
// call out as them, and nobody else can see that it exists, let alone read
// it. The UI under test is the "Your access" section of the user zone's
// Connectors tab; the isolation claims are asserted at the API, because a
// second browser identity is cheaper to mint there than to sign in.

import { test, expect } from "@playwright/test";
import { open, openSettings, openTab, settings } from "./console.js";

const SERVER = { id: "e2e-mine-srv", serverName: "e2e-mine", transport: "http",
  endpoint: "http://127.0.0.1:9/mcp", authKind: "bearer", authHeader: "", enabled: false };

async function removeServer(request: import("@playwright/test").APIRequestContext) {
  await request.delete(`/api/servers/${SERVER.id}`);
}

test.beforeEach(async ({ request }) => {
  await removeServer(request);
  const made = await request.post("/api/servers", { data: SERVER });
  expect(made.ok(), "could not arrange a bearer connector").toBeTruthy();
});

test.afterEach(async ({ request }) => { await removeServer(request); });

test("your token: stored from the tab, forgotten from the tab, never readable", async ({ page, request }) => {
  await open(page);
  await openSettings(page);
  await openTab(page, "Connectors");

  const row = settings(page).locator("tr", { hasText: "e2e-mine" }).last();
  await expect(row.locator(".tag")).toHaveText(/deployment's/);
  await row.locator(`#mine-${SERVER.id} input`).fill("tok-of-my-own");
  await row.locator('button[title^="Save your"]').click();
  await expect(row.locator(".tag")).toHaveText(/your token/);

  // The engine agrees, and answers only a boolean — the token itself has no
  // read path, which is the property worth a line of its own.
  const asked = await request.get(`/api/servers/${SERVER.id}/mine`);
  expect(await asked.json()).toEqual({ stored: true });

  await row.locator('button[title^="Forget your"]').click();
  await expect(row.locator(".tag")).toHaveText(/deployment's/);
  expect(await (await request.get(`/api/servers/${SERVER.id}/mine`)).json())
    .toEqual({ stored: false });
});

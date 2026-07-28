// What the run is doing, while it is doing it.
//
// The feature exists because `POST /threads/:id/messages` answers once, at the
// end, and a round can take a minute. So the thing worth testing is not that
// the steps are right afterwards — it is that they are readable *during*, and
// that the card on screen changes when they close.
//
// Which is why the doubles gained a slow path. Every other canned reply here
// answers in a millisecond, and a step that opens and closes inside one tick of
// a 400ms poll can never be caught in flight: the test would assert the
// finished state twice and prove nothing about liveness. `slow_read` on the MCP
// double sits for 1500ms on purpose.

import { expect, test } from "@playwright/test";
import { shell } from "./console.js";

// The agent the model double answers for, wired to the MCP double so a tool
// call has somewhere to go. Arranged through the API — the rule is that a test
// drives the UI for the thing under test and uses the API to set the scene.
async function agentWithSlowTool(page: import("@playwright/test").Page): Promise<string> {
  const servers = (await page.request.get("/api/servers").then((r) => r.json())) as
    { id: string; endpoint: string }[];
  const mcp = servers.find((s) => s.endpoint.includes("8931"));
  test.skip(!mcp, "the MCP double is not registered in this database");

  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string; servers: { id: string }[] }[];
  const onDouble = agents.find((a) => a.agentName === "doubled");
  test.skip(!onDouble, "no agent points at the model double");

  if (!onDouble!.servers.some((s) => s.id === mcp!.id)) {
    await page.request.post(`/api/agents/${onDouble!.id}/servers`, {
      data: { serverId: mcp!.id },
    });
  }
  return onDouble!.id;
}

async function sendSlowly(page: import("@playwright/test").Page, agentId: string): Promise<string> {
  const thread = (await page.request.post("/api/threads", { data: { agentId } })
    .then((r) => r.json())) as { id: string };
  // Not awaited: the whole point is to look at the run while it is running.
  void page.request.post(`/api/threads/${thread.id}/messages`, {
    data: { text: "read the ledger slowly" },
    timeout: 60000,
  });
  return thread.id;
}

test("a dispatched call is readable while the round is still running", async ({ page }) => {
  await page.goto("/");
  const agentId = await agentWithSlowTool(page);
  const threadId = await sendSlowly(page, agentId);

  // Poll the way the console polls, and catch the row open. The tool sits for
  // 1500ms, so this has plenty of room without being timing-sensitive: a build
  // that writes nothing until the end fails here, which is the regression this
  // test exists for.
  let sawRunning = false;
  for (let i = 0; i < 40 && !sawRunning; i++) {
    const round = (await page.request.get(`/api/threads/${threadId}/steps`)
      .then((r) => r.json())) as { running: boolean; steps: { name: string; running: boolean }[] };
    if (round.running && round.steps.some((s) => s.name === "slow_read" && s.running)) {
      sawRunning = true;
    }
    if (!sawRunning) await page.waitForTimeout(200);
  }
  expect(sawRunning).toBe(true);

  // And it closes, with a duration that reflects a tool that actually waited.
  await expect.poll(async () => {
    const round = (await page.request.get(`/api/threads/${threadId}/steps`)
      .then((r) => r.json())) as { running: boolean; steps: { millis: number }[] };
    return round.running;
  }, { timeout: 60000 }).toBe(false);

  const done = (await page.request.get(`/api/threads/${threadId}/steps`)
    .then((r) => r.json())) as { steps: { name: string; ok: boolean; millis: number }[] };
  expect(done.steps).toHaveLength(1);
  expect(done.steps[0].name).toBe("slow_read");
  expect(done.steps[0].ok).toBe(true);
  expect(done.steps[0].millis).toBeGreaterThan(1000);
});

test("the console draws the card while the call runs and settles it when it stops", async ({ page }) => {
  // The UI half, driven through the composer rather than the API, because the
  // card is what a person actually sees.
  await page.goto("/");
  await agentWithSlowTool(page);

  const composer = shell(page).locator("nr-chatbot [contenteditable]");
  await composer.click();
  await composer.pressSequentially("read the ledger slowly");
  await composer.press("Enter");

  // Inside the message, not in a strip at the edge: the card is part of the
  // turn it describes, so a conversation with four answers has four of them.
  const card = shell(page).locator("nr-chatbot .tool-card");
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText("running");
  await expect(card.locator(".tool-name")).toHaveText("slow_read");

  // Then the same card, settled: no longer counting anything as running, and
  // carrying the duration.
  await expect(card).toContainText("done", { timeout: 60000 });
  await expect(card.locator(".tool-ms")).toContainText("ms");
});

test("a round's calls stay attached to that round", async ({ page }) => {
  // Steps are keyed by the round's seq, the same number an artifact of that
  // round carries. A second message must not inherit the first one's calls —
  // and a round that failed and left its steps behind is exactly how that
  // happens, which is why runInThread clears the round before it starts.
  await page.goto("/");
  const agentId = await agentWithSlowTool(page);
  // Awaited, unlike the liveness test: this one is about where the steps land,
  // not about catching them open, and a request still in flight when the test
  // ends is reported as a failure of the test rather than of the feature.
  const thread = (await page.request.post("/api/threads", { data: { agentId } })
    .then((r) => r.json())) as { id: string };
  const threadId = thread.id;
  await page.request.post(`/api/threads/${threadId}/messages`, {
    data: { text: "read the ledger slowly" }, timeout: 60000,
  });

  const first = (await page.request.get(`/api/threads/${threadId}/steps`)
    .then((r) => r.json())) as { seq: number };

  // A second message that calls nothing at all.
  await page.request.post(`/api/threads/${threadId}/messages`, {
    data: { text: "say something plain" }, timeout: 60000,
  });

  const all = (await page.request.get(`/api/threads/${threadId}/steps?seq=all`)
    .then((r) => r.json())) as { steps: { seq: number; name: string }[] };
  // Every step still belongs to the round that dispatched it, and the quiet
  // round contributed none.
  expect(all.steps.every((s) => s.seq === first.seq)).toBe(true);
  expect(all.steps.map((s) => s.name)).toEqual(["slow_read"]);
});

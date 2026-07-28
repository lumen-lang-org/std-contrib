// Build a site, then edit it — two turns, through the composer.
//
// This is the shape the whole feature was built for and the one the earlier
// specs do not reach. A single message that calls one tool proves the plumbing;
// this proves the parts that only appear once a conversation has a history:
//
//   - one message dispatching three calls, all under one card
//   - a second message whose calls include a *second version* of a file the
//     first message wrote, without losing the first
//   - two cards, each attached to its own message, neither showing the other's
//     calls
//   - the model's reasoning for each exchange, beside the calls it explains
//
// Everything is asserted through the UI or through the API's own answers; the
// double is arranged beforehand and never during.

import { expect, test } from "@playwright/test";
import { shell } from "./console.js";

type Page = import("@playwright/test").Page;

// The agent the model double answers for. Same arrangement the other specs use,
// so a database that can run those can run this.
async function agentOnDouble(page: Page): Promise<string> {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string }[];
  const onDouble = agents.find((a) => a.agentName === "doubled");
  test.skip(!onDouble, "no agent points at the model double");
  return onDouble!.id;
}

async function ask(page: Page, text: string) {
  const composer = shell(page).locator("nr-chatbot [contenteditable]");
  await composer.click();
  await composer.pressSequentially(text);
  await composer.press("Enter");
}

// Wait for the turn to be over, not merely for the card to stop spinning.
//
// `sendMessage` refuses while the session is still typing, silently — so a
// second question asked on the strength of the card saying "done" is dropped
// on the floor, and the test then fails looking for a card that was never
// requested. The answer's own words are the honest signal that the turn ended.
async function answered(page: Page, words: string) {
  await expect(shell(page).locator("nr-chatbot")).toContainText(words, { timeout: 60000 });
}

// The thread the console is on, read from the sidebar's selection rather than
// guessed: a test that asks the API "the newest thread" races every other spec.
async function currentThread(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const el = document.querySelector("agent-console") as (HTMLElement & { threadId?: string }) | null;
    return el?.threadId ?? "";
  });
}

test("a site is built in one turn and edited in the next", async ({ page }) => {
  await agentOnDouble(page);
  await page.goto("/");

  // --- turn one: three files ---------------------------------------------
  await ask(page, "build the site");

  const card = shell(page).locator("nr-chatbot .tool-card").first();
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText("3 calls", { timeout: 60000 });
  await expect(card).toContainText("done", { timeout: 60000 });
  await expect(card.locator(".tool-name")).toHaveText([
    "write_artifact", "write_artifact", "write_artifact",
  ]);
  // The reasoning that produced them, beside them.
  await expect(card).toContainText("thinking");
  await answered(page, "The site is up");

  const threadId = await currentThread(page);
  expect(threadId).not.toBe("");

  const built = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; version: number }[];
  expect(built.map((a) => a.path).sort()).toEqual(["/css/main.css", "/index.html", "/js/app.js"]);
  expect(built.every((a) => a.version === 1)).toBe(true);

  // --- turn two: a new file, and a second version of an old one ----------
  await ask(page, "add a menu page and link it");
  await answered(page, "Added /menu.html");

  const cards = shell(page).locator("nr-chatbot .tool-card");
  await expect(cards).toHaveCount(2, { timeout: 30000 });
  const second = cards.nth(1);
  await expect(second).toContainText("2 calls", { timeout: 60000 });
  await expect(second).toContainText("done", { timeout: 60000 });

  // The first card is untouched by the second turn. This is the invariant that
  // a shared card at the edge of the pane cannot express, and the one that a
  // round reusing another round's seq would break.
  await expect(cards.nth(0)).toContainText("3 calls");
  await expect(cards.nth(0)).not.toContainText("2 calls");

  const after = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; version: number }[];
  const byPath = new Map(after.map((a) => [a.path, a.version]));
  expect([...byPath.keys()].sort())
    .toEqual(["/css/main.css", "/index.html", "/js/app.js", "/menu.html"]);
  // The edited page has a second version; the untouched files still have one.
  expect(byPath.get("/index.html")).toBe(2);
  expect(byPath.get("/menu.html")).toBe(1);
  expect(byPath.get("/css/main.css")).toBe(1);

  // And version 1 of the page survives the edit — an artifact is appended to,
  // never replaced.
  const slot = (after.find((a) => a.path === "/index.html") as { slot: number }).slot;
  const first = await page.request.get(`/api/threads/${threadId}/artifacts/${slot}/versions/1`);
  expect(first.ok()).toBe(true);
  const v1 = (await first.json()) as { content: string };
  expect(v1.content).not.toContain("/menu.html");
});

test("each turn's calls belong to that turn, in the order they were dispatched", async ({ page }) => {
  // The same conversation, read from the API rather than the screen: every step
  // carries the round it belongs to, and the two rounds are different numbers.
  await agentOnDouble(page);
  await page.goto("/");

  await ask(page, "build the site");
  await answered(page, "The site is up");
  const threadId = await currentThread(page);

  await ask(page, "add a menu page and link it");
  await answered(page, "Added /menu.html");
  await expect(shell(page).locator("nr-chatbot .tool-card")).toHaveCount(2, { timeout: 60000 });

  const all = (await page.request.get(`/api/threads/${threadId}/steps?seq=all`)
    .then((r) => r.json())) as { steps: { seq: number; idx: number; name: string; ok: boolean }[] };

  const rounds = new Set(all.steps.map((s) => s.seq));
  expect(rounds.size).toBe(2);
  expect(all.steps).toHaveLength(5);
  expect(all.steps.every((s) => s.ok)).toBe(true);

  // Three under the first round, two under the second, each numbered from zero
  // in dispatch order.
  const [firstRound, secondRound] = [...rounds].sort((a, b) => a - b);
  expect(all.steps.filter((s) => s.seq === firstRound).map((s) => s.idx)).toEqual([0, 1, 2]);
  expect(all.steps.filter((s) => s.seq === secondRound).map((s) => s.idx)).toEqual([0, 1]);
});

test("thinking arrives while it is being written, not when the reply lands", async ({ page }) => {
  // The assertion that separates streaming from buffering: the same text has to
  // be observed at two different lengths. A build that writes the thought once,
  // when the rotation ends, passes every other test in this file and fails this
  // one — which is exactly why it is here.
  //
  // It also covers a subtler regression: the round number the poll reads used to
  // come from the steps table alone, so during the thinking phase — before any
  // tool has been dispatched — there was no round to look up and the console
  // showed nothing at all until the first call landed.
  await agentOnDouble(page);
  await page.goto("/");
  await ask(page, "build the site");

  const seen: number[] = [];
  for (let i = 0; i < 30 && seen.length < 2; i++) {
    const threadId = await currentThread(page);
    if (threadId !== "") {
      const round = (await page.request.get(`/api/threads/${threadId}/steps`)
        .then((r) => r.json())) as { thoughts: { text: string }[] };
      const len = round.thoughts[0]?.text.length ?? 0;
      if (len > 0 && !seen.includes(len)) seen.push(len);
    }
    await page.waitForTimeout(150);
  }

  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen[1]).toBeGreaterThan(seen[0]);

  // And it still ends whole, with the calls it explained.
  const card = shell(page).locator("nr-chatbot .tool-card").first();
  await expect(card).toContainText("3 calls", { timeout: 60000 });
  await expect(card).toContainText("relative path", { timeout: 60000 });
});

test("a question asked while the agent is working waits its turn instead of vanishing", async ({ page }) => {
  // It used to be dropped: `sendMessage` returned early while the session was
  // typing, with no message and no warning, so an impatient second thought
  // disappeared between the composer and the transcript. This is the test that
  // would have caught that — and it is the one that caught it, from a spec
  // failing for a reason that had nothing to do with what it was testing.
  await agentOnDouble(page);
  await page.goto("/");

  await ask(page, "build the site");
  // Immediately, without waiting: the first turn is still running.
  await ask(page, "add a menu page and link it");

  // Both are on screen at once, in the order they were typed, and the second
  // says it is waiting.
  const chat = shell(page).locator("nr-chatbot");
  await expect(chat).toContainText("build the site");
  await expect(chat).toContainText("add a menu page and link it");
  await expect(chat.locator(".queued")).toHaveText("waiting");

  // Then it is sent, and the mark goes away with it.
  await answered(page, "The site is up");
  await answered(page, "Added /menu.html");
  await expect(chat.locator(".queued")).toHaveCount(0);

  // Two turns, answered in the order they were asked, each with its own card.
  await expect(shell(page).locator("nr-chatbot .tool-card")).toHaveCount(2);
  const threadId = await currentThread(page);
  const all = (await page.request.get(`/api/threads/${threadId}/steps?seq=all`)
    .then((r) => r.json())) as { steps: { seq: number }[] };
  expect(new Set(all.steps.map((s) => s.seq)).size).toBe(2);
});

test("a sub-agent's work shows under the delegation that asked for it", async ({ page }) => {
  // A child runs inside the parent's thread and under the parent's round — that
  // is what puts its writes on the same message — and its own step and rotation
  // counters start at zero. So without a depth in the row's identity, the
  // child's first call took the id of the parent's delegation and replaced it,
  // and the child's reasoning replaced the parent's. The card showed a tool call
  // where a delegation had been, and one voice where there were two.
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { agentName: string; subAgents: { agentName: string }[] }[];
  const parent = agents.find((a) => a.agentName === "doubled");
  test.skip(!parent?.subAgents.some((c) => c.agentName === "helper"),
    "the double has no sub-agent wired in this database");

  await page.goto("/");
  await ask(page, "ask the helper for a summary");
  await answered(page, "The helper wrote /ledger.md");

  const threadId = await currentThread(page);
  const round = (await page.request.get(`/api/threads/${threadId}/steps`)
    .then((r) => r.json())) as {
      steps: { depth: number; kind: string; name: string }[];
      thoughts: { depth: number; text: string }[];
    };

  // The delegation, and beneath it the call the child made.
  expect(round.steps.map((s) => [s.depth, s.kind, s.name])).toEqual([
    [0, "agent", "ask_helper"],
    [1, "tool", "write_artifact"],
  ]);

  // Two voices, not one: the parent's reasoning for delegating and the child's
  // for what it did.
  const depths = round.thoughts.map((t) => t.depth);
  expect(depths).toContain(0);
  expect(depths).toContain(1);
  expect(round.thoughts.find((t) => t.depth === 0)!.text).toContain("helper knows");
  expect(round.thoughts.find((t) => t.depth === 1)!.text).toContain("asked for a summary");

  // And the child's file belongs to the conversation, not to a thread of its own.
  const made = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string }[];
  expect(made.map((a) => a.path)).toContain("/ledger.md");

  // On screen: the child's row is indented under the delegation, and the card
  // names the sub-agent as a separate voice.
  const card = shell(page).locator("nr-chatbot .tool-card").first();
  await expect(card.locator(".tool-name")).toHaveText(["ask_helper", "write_artifact"]);
  await expect(card).toContainText("the sub-agent is thinking");
});

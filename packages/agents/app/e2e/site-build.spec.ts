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
import { pickAgent, shell } from "./console.js";

type Page = import("@playwright/test").Page;

// The agent the model double answers for. Same arrangement the other specs use,
// so a database that can run those can run this.
async function agentOnDouble(page: Page): Promise<string> {
  const agents = (await page.request.get("/api/agents").then((r) => r.json())) as
    { id: string; agentName: string }[];
  const onDouble = agents.find((a) => a.agentName === "e2e-doubled");
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
  await pickAgent(page, "a-double");

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
  await pickAgent(page, "a-double");

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
  await pickAgent(page, "a-double");
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
  await pickAgent(page, "a-double");

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

test("a line is found and changed without the file being resent", async ({ page }) => {
  // The whole point of the search and edit tools, driven the way a person
  // drives it: the model is asked to rename the shop, does not know where the
  // heading lives, does not read the page back, and changes one line.
  //
  // Three rotations under one message, which is why this belongs on screen as
  // well as in the artifact list: a card that showed them flat would say the
  // model asked for both tools at once, when in fact it could not name the
  // second call until the first had answered.
  await agentOnDouble(page);
  await page.goto("/");
  await pickAgent(page, "a-double");

  await ask(page, "build the site");
  await answered(page, "The site is up");
  const threadId = await currentThread(page);

  const before = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; slot: number; version: number }[];
  const page1 = before.find((a) => a.path === "/index.html")!;
  expect(page1.version).toBe(1);

  await ask(page, "rename the shop");
  await answered(page, "Kaffa Roasters");

  // On screen: the search and the edit, in the order they were dispatched, in
  // separate exchanges because neither could be asked for before the other
  // answered.
  const card = shell(page).locator("nr-chatbot .tool-card").nth(1);
  await expect(card).toContainText("2 calls", { timeout: 60000 });
  // The edit is worn as a sentence, not as its raw arguments: the search row
  // keeps the tool's name, the edit row says what it did to which file.
  await expect(card.locator(".tool-name")).toHaveText(["search_artifacts", "Edited /index.html"]);
  await expect(card).toContainText("exchange 1");
  await expect(card).toContainText("exchange 2");

  // The chip counts lines, and opening it shows both sides of the change.
  await expect(card).toContainText("+1");
  await expect(card).toContainText("-1");
  const chip = card.locator("details.edit");
  await chip.locator("summary").click();
  await expect(chip).toContainText("<h1>Kaffa</h1>");
  await expect(chip).toContainText("<h1>Kaffa Roasters</h1>");

  // In the store: one new version of the page, and only the heading moved.
  const after = (await page.request.get(`/api/threads/${threadId}/artifacts`)
    .then((r) => r.json())) as { path: string; version: number }[];
  expect(new Map(after.map((a) => [a.path, a.version])).get("/index.html")).toBe(2);
  // Nothing else in the conversation gained a version from an edit aimed at one
  // path — an edit is not a rewrite of everything the model can see.
  expect(after.filter((a) => a.path !== "/index.html").every((a) => a.version === 1)).toBe(true);

  const v2 = (await page.request.get(`/api/threads/${threadId}/artifacts/${page1.slot}/versions/2`)
    .then((r) => r.json())) as { content: string };
  expect(v2.content).toContain("<h1>Kaffa Roasters</h1>");
  // The rest of the page survived: the edit spliced a line, it did not resend
  // the file, so everything the model never mentioned is still there byte for
  // byte.
  expect(v2.content).toContain("<link rel=stylesheet href=css/main.css>");
  expect(v2.content).toContain("<script src=js/app.js></script>");

  // And version 1 still says what it said.
  const v1 = (await page.request.get(`/api/threads/${threadId}/artifacts/${page1.slot}/versions/1`)
    .then((r) => r.json())) as { content: string };
  expect(v1.content).toContain("<h1>Kaffa</h1>");
  expect(v1.content).not.toContain("Roasters");
});

test("the cards are still there after a reload", async ({ page }) => {
  // A card is not decoration on a live round: it is what the answer above it
  // was made of. It used to live only in the browser's memory, so a reload —
  // or opening the conversation tomorrow — left every answer standing alone,
  // claiming work the console no longer showed.
  //
  // Both halves are asserted, because they are stored in two tables and the
  // reload originally lost them for two different reasons: the calls were never
  // asked for, and the thinking was asked for a round the query had already
  // been told not to name.
  await agentOnDouble(page);
  await page.goto("/");
  await pickAgent(page, "a-double");

  await ask(page, "build the site");
  await answered(page, "The site is up");
  await ask(page, "add a menu page and link it");
  await answered(page, "Added /menu.html");
  await expect(shell(page).locator("nr-chatbot .tool-card")).toHaveCount(2, { timeout: 60000 });

  // The reload, and the conversation opened again the way a person opens it.
  await page.reload();
  const row = shell(page).locator("console-sidebar .thread").first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.click();
  await expect(shell(page).locator("nr-chatbot")).toContainText("Added /menu.html", { timeout: 30000 });

  // Both rounds, each with the calls it made, each attached to its own answer.
  const cards = shell(page).locator("nr-chatbot .tool-card");
  await expect(cards).toHaveCount(2, { timeout: 30000 });
  await expect(cards.nth(0)).toContainText("3 calls");
  await expect(cards.nth(1)).toContainText("2 calls");
  await expect(cards.nth(0).locator(".tool-name")).toHaveText([
    "write_artifact", "write_artifact", "write_artifact",
  ]);
  // Nothing is left claiming to be in flight: every step was closed long ago.
  await expect(cards.nth(0)).toContainText("done");
  await expect(cards.nth(1)).toContainText("done");
  // And the reasoning came back with them.
  await expect(cards.nth(0)).toContainText("thinking");
  await expect(cards.nth(0)).toContainText("relative path");

  // Each card sits inside the answer it explains, not inside the question: the
  // rounds are joined to the turns that follow them, and a card one message out
  // of place would still count two cards and pass everything above.
  const holds = async (n: number) =>
    await cards.nth(n).evaluate((el) => el.parentElement?.textContent ?? "");
  expect(await holds(0)).toContain("The site is up");
  expect(await holds(1)).toContain("Added /menu.html");
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
  const parent = agents.find((a) => a.agentName === "e2e-doubled");
  test.skip(!parent?.subAgents.some((c) => c.agentName === "e2e-helper"),
    "the double has no sub-agent wired in this database");

  await page.goto("/");
  await pickAgent(page, "a-double");
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

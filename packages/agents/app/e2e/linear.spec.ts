// A connector, driven through a conversation — Linear, because the test
// account is connected to it.
//
// The failure this exists to catch is quiet: everything renders, the model
// answers politely, and no Linear tool was ever called — the exact screenshot
// that started this spec, where "what are the current cycle of the linear"
// came back as a request for clarification from an agent that had list_cycles
// one call away. Nothing errors in that world. The only test that means
// anything is the one that asks the question a person asked and then looks at
// the steps card for the calls.
//
// It runs against a deployment where the signed-in test account holds a
// Linear OAuth grant (joule.sh does — the grant lives in the engine, keyed by
// the console's user id) and skips itself anywhere else:
//
//   CONSOLE_URL=https://joule.sh npx playwright test e2e/linear.spec.ts
//
// Credentials come from packages/agents/app/.env, gitignored, same as every
// signed-in spec — this repository is public.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { open, ready } from "./console.js";
import { Finding, Report, record, save } from "./record.js";
import { PASS, USER, beSomebody, converse, pickModel } from "./session.js";

/** Which menu entry the conversation runs on. The deployment's default chat
 *  model is a vLLM on somebody's desktop over the tailnet, and a spec that
 *  fails whenever that machine sleeps is a spec nobody trusts — so this pins
 *  a hosted model when the menu offers one, and falls back to the default
 *  when it does not. Overridable for a run that wants to prove the local
 *  model's own tool-calling: JOULE_TEST_MODEL="" or a different label. */
const MODEL = process.env.JOULE_TEST_MODEL ?? "Claude Code Haiku";

const OUT = "test-results/linear-report.json";

/** The tool names the steps card shows for the turn on screen — the card
 *  renders each call as a `.tool-name` span (stepsCard in chat-session.ts). */
async function calledTools(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const all = (sel: string, root: ParentNode = document, depth = 0): Element[] => {
      if (depth > 16) { return []; }
      let out: Element[] = [];
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(sel)) { out.push(el); }
        if (el.shadowRoot !== null) { out = out.concat(all(sel, el.shadowRoot, depth + 1)); }
      }
      return out;
    };
    return all(".tool-name").map((el) => (el.textContent ?? "").trim());
  });
}

test("asking about Linear calls Linear, not the model's imagination", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  test.setTimeout(6 * 60_000);

  const report: Report = await record(page);
  await open(page);
  await ready(page);
  report.url = page.url();
  test.skip(!(await beSomebody(page)), "no way to sign in on this deployment");

  if (MODEL !== "") {
    await pickModel(page, MODEL).catch(() => { /* not on this menu — default */ });
  }

  // The person's own phrasing, near enough — the point is that naming the
  // connector is all it should take. No "use your tools" nudge: the nudged
  // version passing while this fails is precisely the bug.
  await converse(page, report, "What are the current cycles in Linear?");

  const called = await calledTools(page);
  const answer = report.turns[0]?.answer ?? "";
  const findings: Finding[] = [];

  // A Linear tool ran. find_tools alone is not enough — discovering a tool
  // and then not calling it is the polite version of the same failure.
  const linearCall = called.some((t) =>
    /cycle|issue|team|project/i.test(t) && !/find_tools/i.test(t));
  findings.push({
    check: "a Linear tool was called",
    ok: linearCall,
    detail: called.length === 0 ? "no tool calls at all" : `called: ${called.join(", ")}`,
  });

  // And the answer is an answer, not a deflection. The words a deflection
  // uses are stable across models: clarify, which team, cannot see.
  findings.push({
    check: "the answer engages with cycles",
    ok: answer.length > 0 && !/clarify|not clearly defined|cannot see my own engine/i.test(answer),
    detail: answer.slice(0, 160) || "(empty)",
  });

  // The cycle should have arrived as a card, not as bullet soup — the whole
  // point of the [LINEAR_CYCLE] marker (cards.ts). Judged on the rendered
  // DOM: the renderer stamps data-linear-card on what it draws.
  const cycleCard = await page.locator('agent-console [data-linear-card="cycle"]')
    .first().isVisible().catch(() => false);
  findings.push({
    check: "the cycle renders as a card",
    ok: cycleCard,
    detail: cycleCard ? "data-linear-card=cycle on screen" : "no card in the transcript",
  });

  // Multi-turn: the connector stays reachable on the SECOND turn of the same
  // conversation — a regression class of its own, since round two carries the
  // first answer in context and is where a window that barely fit stops
  // fitting. A ticket-list question, so the issues card gets driven too.
  await converse(page, report, "List the issues in that cycle.");
  const secondAnswer = report.turns[1]?.answer ?? "";
  findings.push({
    check: "the second turn still answers",
    ok: secondAnswer.length > 0 && !/would not take this request/i.test(secondAnswer),
    detail: secondAnswer.slice(0, 160) || "(empty)",
  });
  const issuesCard = await page.locator('agent-console [data-linear-card="issues"]')
    .first().isVisible().catch(() => false);
  findings.push({
    check: "the issues render as a card of links",
    ok: issuesCard,
    detail: issuesCard ? "data-linear-card=issues on screen" : "no issues card",
  });

  save(OUT, report);
  for (const f of findings) {
    console.log(`${f.ok ? "ok " : "FAIL"} ${f.check} — ${f.detail}`);
  }
  const failed = findings.filter((f) => !f.ok);
  expect(failed.map((f) => `${f.check}: ${f.detail}`).join("\n")).toBe("");
});

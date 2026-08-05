// A whole conversation, recorded and then judged.
//
// The other specs each pin one behaviour. This one signs in as a real user,
// holds a conversation of several turns against whatever model the deployment
// actually runs, and records everything the browser saw — console lines,
// crashes, failed requests, the transcript's growth curve at 25ms, the status
// line, the code blocks, the icons. `score()` in record.ts turns the recording
// into findings, and the test fails on the findings, not on the way to them.
//
// The recording is saved whether or not the test passes:
//
//   test-results/conversation-report.json
//
// so a run that passes every threshold still leaves behind the evidence to
// notice what the thresholds do not cover yet. Read the samples before adding
// an assertion here; the number you want is probably already in the file.
//
// It needs a deployment with the builtin login and a live model:
//
//   CONSOLE_URL=https://joule.sh npx playwright test e2e/conversation.spec.ts
//
// The credentials come from packages/agents/app/.env (JOULE_TEST_USER /
// JOULE_TEST_PASS), which is gitignored — this repository is public. Without
// them, or against a console with no way to sign in, it skips rather than
// fails, the same shape as signin.spec.ts.

import { expect, test } from "@playwright/test";
import { open, ready } from "./console.js";
import { Finding, chrome, deepText, record, save, score } from "./record.js";
import { PASS, USER, beSomebody, converse } from "./session.js";

const OUT = "test-results/conversation-report.json";

// The conversation. Each turn exists to exercise a different surface: plain
// prose for the stream, fenced code for the highlighter and the copy control,
// a longer answer to give the reveal loop something worth measuring, and a
// file save so the artifact cards and the panel get driven by a real turn
// rather than by a fixture.
const TURNS = [
  "In one short paragraph: what is a mutex, and when would I want one?",
  "Write a Python function that reverses the words in a sentence, in a code block, with a one-line docstring.",
  "Now explain, step by step in about 150 words, what happens when I type a URL into a browser and press Enter.",
  "Save a file named mutex-notes.md summarising this conversation in a few bullet points.",
];

test("a recorded conversation holds up under scoring", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  test.setTimeout(8 * 60_000);

  const report = await record(page);
  await open(page);
  await ready(page);
  report.url = page.url();

  // Signed in when the deployment offers it; already-signed-in (a storage
  // state) and no-auth consoles both land here with a composer that works.
  test.skip(!(await beSomebody(page)), "no way to sign in on this deployment");
  report.who = await deepText(page, ".who");

  for (const said of TURNS) {
    await converse(page, report, said);
  }

  // The file turn's whole point: the save shows up as a card on the message
  // (span[data-open-path], refCards in chat-session.ts), and pressing it opens
  // the artifact panel with the file's own name on it. Checked here rather
  // than in score() because only this spec knows a file was asked for.
  const extra: Finding[] = [];
  const card = page.locator('agent-console [data-open-path*="mutex-notes"]').first();
  const made = await card.isVisible().catch(() => false);
  extra.push({
    check: "saving a file leaves a card on the message",
    ok: made,
    detail: made ? await card.getAttribute("data-open-path") ?? "" : "no [data-open-path] card appeared",
  });
  if (made) {
    await card.click();
    const panel = page.locator("agent-console artifact-panel");
    // getByText pierces the panel's shadow root; textContent() reads light-DOM
    // children only, which for a shadow component is always "" — the first
    // draft of this check failed a panel that was open with the file on it.
    // Polled, not sampled: the panel opens its rail and then FETCHES the
    // artifact, and an isVisible() read the instant after the click answers
    // for the moment before the name has arrived.
    const named = await expect(panel.getByText("mutex-notes").first())
      .toBeVisible({ timeout: 10_000 }).then(() => true, () => false);
    extra.push({
      check: "the card opens the artifact panel",
      ok: named,
      detail: named ? "panel opened on the file" : "panel missing or unnamed",
    });
    await page.keyboard.press("Escape");
  }

  // The page after the conversation, not before it: icons and layout have had
  // every chance to go wrong by now.
  const state = await chrome(page);
  report.blankIcons = state.blankIcons;
  report.sideways = state.sideways;
  report.railTitle = await deepText(page, "nav .thread.active");

  save(OUT, report);

  const findings = [...score(report), ...extra];
  for (const f of findings) {
    console.log(`${f.ok ? "ok " : "FAIL"} ${f.check} — ${f.detail}`);
  }
  const failed = findings.filter((f) => !f.ok);
  expect(failed.map((f) => `${f.check}: ${f.detail}`).join("\n")).toBe("");
});

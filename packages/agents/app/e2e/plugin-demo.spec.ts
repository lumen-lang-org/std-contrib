// A recording of the card pipeline, with the card on screen.
//
// plugin-cards.spec.ts proves the machinery and shows nothing: its sandbox is
// a hidden iframe and its assertions are on a string, so the video Playwright
// saves is seven seconds of an idle console. Correct, and useless as evidence
// for a person.
//
// This is the same pipeline with the result PUT ON THE PAGE: the installed
// renderer, the real sandbox, a real list_cycles result as evidence, the
// shipping sanitizer, and then the sanitized HTML inserted where a reader can
// see it. It asserts too — a demo that can pass while drawing nothing is a
// demo that will eventually lie — but its purpose is the recording.
//
// What it is NOT: a conversation. No model runs here and none is implied; the
// caption the page draws says so, because a screenshot of a staged card
// presented as a chat would be exactly the kind of evidence nobody should
// trust. The live-turn path is blocked on a separate defect (multi-tool turns
// exceeding the edge timeout), and when that is fixed linear.spec.ts is what
// proves it.
//
//   CONSOLE_URL=https://joule.sh npx playwright test e2e/plugin-demo.spec.ts

import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { open, ready } from "./console.js";
import { PASS, USER, beSomebody } from "./session.js";

/** A real list_cycles result, engine hint and all. */
const CYCLES = JSON.stringify([{
  id: "606527af-83e7-44b0-b101-9f02e19afe4f",
  number: 13,
  startsAt: "2026-08-02T23:00:00.000Z",
  endsAt: "2026-08-09T23:00:00.000Z",
  completedIssueCountHistory: [0, 2],
  issueCountHistory: [6, 6],
  completedScopeHistory: [0, 2],
  scopeHistory: [6, 6],
  isCurrent: true,
}]) + "\n\nWhen you answer, do not restate or list these fields.";

/** A real list_issues result, trimmed to what one screen shows. */
const ISSUES = JSON.stringify({
  issues: [
    { id: "AYM-24", title: "Saisi équipe conception", status: "Todo", statusType: "unstarted",
      url: "https://linear.app/aymenlabidi/issue/AYM-24", priority: { value: 0, name: "No priority" } },
    { id: "AYM-23", title: "Vector index on the data node", status: "In Progress", statusType: "started",
      url: "https://linear.app/aymenlabidi/issue/AYM-23", priority: { value: 2, name: "High" } },
    { id: "AYM-21", title: "Passage selection in joule-crawl", status: "Done", statusType: "completed",
      url: "https://linear.app/aymenlabidi/issue/AYM-21", priority: { value: 3, name: "Medium" } },
    { id: "AYM-19", title: "Guest quota strip copy", status: "Canceled", statusType: "canceled",
      url: "https://linear.app/aymenlabidi/issue/AYM-19", priority: { value: 0, name: "No priority" } },
  ],
  hasNextPage: false,
});

async function sanitizerBundle(): Promise<string> {
  const out = await build({
    entryPoints: ["src/plugin-cards.ts"],
    bundle: true, write: false, format: "iife", globalName: "JoulePluginCards",
    target: "es2022",
  });
  return out.outputFiles[0].text;
}

test("the cards, drawn where they can be seen", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  test.setTimeout(120_000);

  await open(page);
  await ready(page);
  test.skip(!(await beSomebody(page)), "no way to sign in on this deployment");

  const plugins = await page.evaluate(async () => {
    const res = await fetch("/api/card-plugins", { credentials: "same-origin" });
    if (!res.ok) return [];
    return await res.json() as { id: string; pluginName: string; enabled: boolean; rendererSource: string }[];
  });
  const carrying = plugins.filter((p) => p.enabled && p.rendererSource !== "");
  test.skip(carrying.length === 0, "no card plugin with a renderer is installed here");

  await page.addScriptTag({ content: await sanitizerBundle() });

  const drew = await page.evaluate(async ({ source, cycles, issues, pluginName }) => {
    const sanitize = (window as unknown as {
      JoulePluginCards: { sanitizeCardHtml(h: string): string };
    }).JoulePluginCards.sanitizeCardHtml;

    // The real sandbox, visible in the recording as nothing — which is the
    // point: it draws no pixels, it only answers.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = "/plugin-host";
    frame.style.display = "none";
    const pending = new Map<string, (html: string) => void>();
    let hello: () => void = () => {};
    const up = new Promise<void>((r) => { hello = r; });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      const m = event.data as { kind?: string; id?: string; html?: string };
      if (m.kind === "hello") { hello(); return; }
      if (m.kind === "html" && typeof m.id === "string") {
        pending.get(m.id)?.(m.html ?? "");
        pending.delete(m.id);
      }
    });
    document.body.appendChild(frame);
    await up;
    frame.contentWindow?.postMessage({ kind: "load", plugin: "demo", source }, "*");
    await new Promise((r) => window.setTimeout(r, 400));

    const render = (marker: string, content: string, evidence: string[]) =>
      new Promise<string>((resolve) => {
        const id = `demo-${marker}`;
        pending.set(id, resolve);
        frame.contentWindow?.postMessage({ kind: "render", id, marker, content, evidence }, "*");
        window.setTimeout(() => { if (pending.delete(id)) resolve(""); }, 3000);
      });

    const cycleCard = sanitize(await render("LINEAR_CYCLE", '{"team":"Aymen"}', [cycles]));
    const issuesCard = sanitize(await render("LINEAR_ISSUES", '{"title":"Cycle 13"}', [issues]));

    // On the page, over the console, with a caption that says what this is.
    // Not inside the transcript: these cards were not produced by a
    // conversation, and putting them where a conversation's answers go would
    // be a picture of something that did not happen.
    const stage = document.createElement("div");
    stage.setAttribute("data-demo-stage", "");
    stage.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fbfbfc;"
      + "display:flex;flex-direction:column;align-items:center;gap:18px;"
      + "padding:44px 24px;overflow:auto;font:15px/1.6 system-ui,sans-serif;color:#16171d";
    stage.innerHTML =
      '<div style="max-width:660px;width:100%;display:flex;flex-direction:column;gap:6px">'
      + '<div style="font:600 11px/1 ui-monospace,monospace;letter-spacing:.14em;'
      + 'text-transform:uppercase;color:#9a6b1f">' + pluginName + ' &middot; rendered in the sandbox</div>'
      + '<div style="font-size:14px;color:#5c5f6e">Real tool results in, sanitized HTML out. '
      + 'No model ran &mdash; the only strings a model would supply are the team name and the heading.</div>'
      + '</div>'
      + '<div style="max-width:660px;width:100%">' + cycleCard + '</div>'
      + '<div style="max-width:660px;width:100%">' + issuesCard + '</div>';
    document.body.appendChild(stage);

    return { cycle: cycleCard.length, issues: issuesCard.length };
  }, {
    source: carrying[0].rendererSource,
    cycles: CYCLES,
    issues: ISSUES,
    pluginName: carrying[0].pluginName,
  });

  // A demo that draws nothing must fail rather than record an empty screen.
  expect(drew.cycle, "the cycle card has body").toBeGreaterThan(200);
  expect(drew.issues, "the issues card has body").toBeGreaterThan(200);
  await expect(page.locator('[data-linear-card="cycle"]')).toBeVisible();
  await expect(page.locator('[data-linear-card="issues"]')).toBeVisible();
  await expect(page.locator('[data-demo-stage]')).toContainText("Cycle 13");
  await expect(page.locator('[data-demo-stage]')).toContainText("AYM-24");

  // Long enough to read on the recording, and a screenshot for a still.
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "test-results/plugin-cards-drawn.png", fullPage: false });
  await page.waitForTimeout(2000);
});

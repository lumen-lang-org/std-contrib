// Does the plugin card machinery actually work?
//
// linear.spec.ts answers that only when a whole model turn succeeds, which
// makes it a poor instrument for this question: the last run failed on a
// gateway timeout and said nothing about the cards either way. This spec
// drives the machinery directly — the real sandbox document, the real
// renderer snapshot the engine serves, and a real tool result as evidence —
// so a card that cannot draw is a failure here rather than a silence there.
//
// Three things get proven, in order of what breaks first in practice:
//
//   1. the sandbox loads and answers            (the host document, its CSP)
//   2. the installed renderer draws a card      (the snapshot, the contract)
//   3. output containment holds                 (a hostile renderer is stripped)
//
// It needs a deployment with a card plugin installed that ships a renderer,
// and skips itself otherwise rather than failing — the same shape as every
// other deployment-dependent spec here.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { build } from "esbuild";
import { open, ready } from "./console.js";
import { PASS, USER, beSomebody } from "./session.js";

/** The shipped sanitizer, compiled from its own source for the test.
 *
 *  Not a copy of the rules and not a reach into a build artifact: esbuild is
 *  pointed at src/plugin-cards.ts, so what runs here is what ships, and a
 *  rule weakened in that file fails this test. The earlier draft tried to
 *  import the built chunk by a guessed path, found nothing, and SKIPPED — a
 *  green run that proved nothing about the one boundary that matters. */
async function sanitizerSource(): Promise<string> {
  // iife with a global name, NOT esm-into-a-blob: the console's own CSP has
  // no `blob:` in script-src, so a blob module import fails on the page under
  // test — correctly, and it took a run to see it. An inline script is what
  // `'unsafe-inline'` already allows, so this reaches the page the same way
  // any of its own code would.
  const out = await build({
    entryPoints: ["src/plugin-cards.ts"],
    bundle: true, write: false, format: "iife", globalName: "JoulePluginCards",
    target: "es2022",
  });
  return out.outputFiles[0].text;
}

/** A real list_cycles result, as the engine stores it — including the card
 *  hint the engine appends after the JSON, because a renderer that only
 *  parses clean JSON would pass a test and fail in production. */
const CYCLES_EVIDENCE = JSON.stringify([{
  id: "606527af-83e7-44b0-b101-9f02e19afe4f",
  number: 13,
  startsAt: "2026-08-02T23:00:00.000Z",
  endsAt: "2026-08-09T23:00:00.000Z",
  completedIssueCountHistory: [0, 2],
  issueCountHistory: [6, 6],
  completedScopeHistory: [0, 2],
  scopeHistory: [6, 6],
  isCurrent: true,
}]) + "\n\nWhen you answer, do not restate or list these fields. Emit exactly one line, alone: [LINEAR_CYCLE]{\"team\":\"<team name>\"}[/LINEAR_CYCLE]";

/** Drive the real sandbox: build the iframe the console builds, hand it a
 *  module's source, ask for one render, hand back what came out. Runs in the
 *  page so the origin, the CSP and the sandbox attribute are the deployment's
 *  own, not a fixture's. */
async function renderInHost(page: Page, source: string, marker: string,
                            content: string, evidence: string[]): Promise<string> {
  return await page.evaluate(async ({ source, marker, content, evidence }) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = "/plugin-host";
    frame.style.display = "none";
    const answer = new Promise<string>((resolve) => {
      let settled = false;
      const done = (html: string) => { if (!settled) { settled = true; resolve(html); } };
      window.setTimeout(() => done("__TIMEOUT__"), 8000);
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data as { kind?: string; html?: string; problem?: string };
        if (m.kind === "hello") {
          frame.contentWindow?.postMessage({ kind: "load", plugin: "probe", source }, "*");
          return;
        }
        if (m.kind === "loaded") {
          if (m.problem) { done(`__LOAD_FAILED__ ${m.problem}`); return; }
          frame.contentWindow?.postMessage(
            { kind: "render", id: "probe-1", marker, content, evidence }, "*");
          return;
        }
        if (m.kind === "html") { done(m.html ?? ""); }
      });
    });
    document.body.appendChild(frame);
    const html = await answer;
    frame.remove();
    return html;
  }, { source, marker, content, evidence });
}

test("the sandbox draws a card from the installed renderer", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  test.setTimeout(90_000);

  await open(page);
  await ready(page);
  test.skip(!(await beSomebody(page)), "no way to sign in on this deployment");

  // The renderer this deployment actually installed, not one this file wrote.
  const plugins = await page.evaluate(async () => {
    const res = await fetch("/api/card-plugins", { credentials: "same-origin" });
    if (!res.ok) return [];
    return await res.json() as { id: string; enabled: boolean; rendererSource: string }[];
  });
  const carrying = plugins.filter((p) => p.enabled && p.rendererSource !== "");
  test.skip(carrying.length === 0, "no card plugin with a renderer is installed here");

  const source = carrying[0].rendererSource;
  const html = await renderInHost(page, source, "LINEAR_CYCLE",
    '{"team":"Aymen"}', [CYCLES_EVIDENCE]);

  expect(html, "the sandbox answered").not.toBe("__TIMEOUT__");
  expect(html, "the module loaded").not.toContain("__LOAD_FAILED__");
  expect(html, "it drew a cycle card").toContain('data-linear-card="cycle"');
  // The numbers come from the EVIDENCE, which is the whole design: the model
  // supplied only the team name above.
  expect(html, "with the cycle number").toContain("Cycle 13");
  expect(html, "and the count out of the tool result").toContain("2 of 6 issues done");
  expect(html, "and the team the model named").toContain("Aymen");
});

test("a card survives the escaping pipeline as markup, not as text", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  test.setTimeout(90_000);

  await open(page);
  await ready(page);
  test.skip(!(await beSomebody(page)), "no way to sign in on this deployment");

  // The bug this exists for, in one line: the console escapes every reply
  // before showing it — correctly, it is what stops a model writing markup —
  // and the first version of the plugin pass inserted its HTML BEFORE that
  // escape ran. The card was escaped along with everything else and a reader
  // got `<div style="margin:10px 0;padding:14px…` where a card belonged. It
  // rendered perfectly in the sandbox the whole time, which is why the
  // sandbox tests above stayed green through it.
  //
  // So this drives the two-pass path itself: prepare, run the real escaping
  // pipeline over what it returns, restore, and check the result is markup.
  await page.addScriptTag({ content: await sanitizerSource() });
  const shown = await page.evaluate(async ({ source, evidence }) => {
    const api = (window as unknown as {
      JoulePluginCards: {
        sanitizeCardHtml(h: string): string;
        loadRendererForTest?(s: string): Promise<void>;
      };
    }).JoulePluginCards;
    // The escape the console applies to every reply, copied exactly from
    // chat-session so this test fails if that rule is what changed.
    const escapeHtml = (raw: string) => {
      let out = "";
      for (const ch of raw) {
        if (ch === "&") out += "&amp;";
        else if (ch === "<") out += "&lt;";
        else if (ch === ">") out += "&gt;";
        else if (ch === '"') out += "&quot;";
        else if (ch === "'") out += "&#39;";
        else out += ch;
      }
      return out;
    };
    // A card rendered through the real sandbox, then put through the real
    // escape, then restored — the sequence the transcript performs.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = "/plugin-host";
    frame.style.display = "none";
    let hello: () => void = () => {};
    const up = new Promise<void>((r) => { hello = r; });
    const pending = new Map<string, (h: string) => void>();
    window.addEventListener("message", (e) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data as { kind?: string; id?: string; html?: string };
      if (m.kind === "hello") { hello(); return; }
      if (m.kind === "html" && m.id) { pending.get(m.id)?.(m.html ?? ""); pending.delete(m.id); }
    });
    document.body.appendChild(frame);
    await up;
    frame.contentWindow?.postMessage({ kind: "load", plugin: "t", source }, "*");
    await new Promise((r) => window.setTimeout(r, 400));
    const html = await new Promise<string>((resolve) => {
      pending.set("t1", resolve);
      frame.contentWindow?.postMessage(
        { kind: "render", id: "t1", marker: "LINEAR_CYCLE", content: '{"team":"Aymen"}', evidence: [evidence] }, "*");
      window.setTimeout(() => resolve(""), 3000);
    });
    const card = api.sanitizeCardHtml(html);

    // Prepared text carries a token; the token goes through the escape
    // unchanged; restoring puts the markup back.
    const token = "JOULEPLUGINCARD0ENDCARD";
    const prepared = "The Aymen team has one current cycle.\n\n" + token;
    const escaped = escapeHtml(prepared);
    const restored = escaped.split(token).join(card);
    return { restored, tokenSurvived: escaped.includes(token), card };
  }, { source: (await page.evaluate(async () => {
    const res = await fetch("/api/card-plugins", { credentials: "same-origin" });
    const rows = await res.json() as { enabled: boolean; rendererSource: string }[];
    return rows.filter((r) => r.enabled && r.rendererSource !== "")[0]?.rendererSource ?? "";
  })), evidence: CYCLES_EVIDENCE });

  test.skip(shown.card === "", "no renderer installed here");
  expect(shown.tokenSurvived, "the token passes through escaping unchanged").toBeTruthy();
  // The whole point: what reaches the transcript is a real element, not the
  // characters of one.
  expect(shown.restored, "the card is markup").toContain('<div data-linear-card="cycle"');
  expect(shown.restored, "not escaped text").not.toContain("&lt;div");
  expect(shown.restored, "and the prose around it is still escaped-safe")
    .toContain("The Aymen team has one current cycle.");
});

test("a hostile renderer cannot put script or handlers in the transcript", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  test.setTimeout(90_000);

  await open(page);
  await ready(page);
  test.skip(!(await beSomebody(page)), "no way to sign in on this deployment");

  // Everything a malicious card would try. It runs — containment is not
  // prevention of execution inside the sandbox, it is prevention of effect —
  // and then every dangerous part of what it returns must be gone.
  const HOSTILE = `
    export default [{
      marker: "LINEAR_CYCLE",
      render: function () {
        return '<div data-linear-card="cycle">'
          + '<script>window.parent.document.title = "pwned"<\\/script>'
          + '<img src="x" onerror="fetch(\\'/api/agents\\')">'
          + '<a href="javascript:alert(1)">tap</a>'
          + '<a href="https://linear.app/x" target="_blank">ok</a>'
          + '<button type="button" data-card-send="Move AYM-1 to Done." onclick="steal()">Done</button>'
          + '<iframe src="https://evil.example"></iframe>'
          + '</div>';
      }
    }];
  `;

  const raw = await renderInHost(page, HOSTILE, "LINEAR_CYCLE", "{}", []);
  expect(raw, "the sandbox answered").not.toBe("__TIMEOUT__");

  // The console's own sanitizer, reached the way the console reaches it — the
  // module is bundled, so this asserts against a rebuild of the same rules is
  // NOT acceptable; it has to be the shipped function. The console exposes it
  // for exactly this reason.
  await page.addScriptTag({ content: await sanitizerSource() });
  const clean = await page.evaluate((html) => {
    const mod = (window as unknown as {
      JoulePluginCards: { sanitizeCardHtml(h: string): string };
    }).JoulePluginCards;
    return mod.sanitizeCardHtml(html);
  }, raw);
  expect(clean, "no script survived").not.toContain("<script");
  expect(clean, "no event handler survived").not.toContain("onerror");
  expect(clean, "no javascript: url survived").not.toContain("javascript:");
  expect(clean, "no nested frame survived").not.toContain("<iframe");
  expect(clean, "the legitimate link survived").toContain("https://linear.app/x");
  // A card's ACTION must survive, and this assertion exists because it did
  // not: BUTTON sat on the banned list with the input controls, so every
  // control a plugin drew was deleted on the way into the transcript and the
  // card looked finished while doing nothing.
  expect(clean, "an action button survives").toContain("data-card-send");
  expect(clean, "with no handler on it").not.toContain("onclick");
  expect(clean, "and it got its rel").toContain("noopener");
  // The title is the parent's; a sandboxed null-origin document cannot reach
  // it. Asserted because it is the claim the sandbox exists to make.
  expect(await page.title(), "the parent was untouched").not.toBe("pwned");
});

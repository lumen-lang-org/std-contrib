// Completions in the composer, driven and recorded.
//
// The suggestions come from the deployment's own index — document titles, and
// only those: the endpoint's answer also carries entries drawn from what other
// people have searched, and server/search-proxy.ts drops those for anybody who
// is not an operator. This spec asserts that boundary as well as the feature,
// because the two are the same request and only one of them is visible on
// screen.
//
// It records: typing, the list appearing, arrowing down it, and Enter taking
// the highlighted row into the composer.
//
//   CONSOLE_URL=https://joule.sh npx playwright test e2e/autocomplete.spec.ts

import { expect, test } from "@playwright/test";
import { open, ready } from "./console.js";
import { PASS, USER, beSomebody, composer } from "./session.js";

/** The suggestion rows on screen, in order. */
async function rows(page: import("@playwright/test").Page): Promise<string[]> {
  return (await page.locator("agent-console .hints .hint-text").allTextContents())
    .map((t) => t.trim());
}

test("the composer completes from the index", async ({ page }) => {
  test.skip(USER === "" || PASS === "",
    "put JOULE_TEST_USER and JOULE_TEST_PASS in packages/agents/app/.env");
  test.setTimeout(120_000);

  await open(page);
  await ready(page);
  test.skip(!(await beSomebody(page)), "no way to sign in on this deployment");

  // Slowly, because the recording is half the point and because the list is
  // debounced at 140ms — typing faster than a person would is the one way to
  // see nothing and conclude the feature is broken.
  await composer(page).click();
  await composer(page).pressSequentially("linux kernel", { delay: 90 });

  const list = page.locator("agent-console .hints");
  await expect(list, "the list appears").toBeVisible({ timeout: 10_000 });
  const shown = await rows(page);
  expect(shown.length, "with something in it").toBeGreaterThan(0);

  /* The list is JOINED to the composer, not floating over it.
   *
   * The design this follows is one surface: the field and its completions in
   * a single card, divided by a rule rather than separated by a gap. A
   * floating panel is what the slash menu is, and the two are different
   * things — so this asserts the geometry rather than trusting it, because a
   * gap of a few pixels is exactly the kind of regression nobody sees in a
   * diff. */
  const seam = await page.evaluate(() => {
    /* A deep walk, not `document.querySelector("agent-console")`.
     *
     * Under LumenJS the console is not a document-level node — it sits inside
     * the page element's shadow root — so the obvious query answers null and
     * this probe reported "both boxes are on screen: null" for a layout that
     * was plainly on screen. e2e/console.ts writes this trap down; I walked
     * into it anyway. */
    const find = (sel: string, root: ParentNode = document, depth = 0): Element | null => {
      if (depth > 16) { return null; }
      for (const el of root.querySelectorAll("*")) {
        if (el.matches(sel)) { return el; }
        if (el.shadowRoot !== null) {
          const hit = find(sel, el.shadowRoot, depth + 1);
          if (hit !== null) { return hit; }
        }
      }
      return null;
    };
    const chat = find("nr-chatbot") as (Element & { shadowRoot: ShadowRoot | null }) | null;
    const card = chat?.shadowRoot?.querySelector(".input-box")?.getBoundingClientRect();
    const list = find(".hints")?.getBoundingClientRect();
    if (!card || !list) return null;
    return {
      gap: Math.round(list.top - card.bottom),
      dx: Math.round(list.left - card.left),
      dw: Math.round(list.width - card.width),
    };
  });
  expect(seam, "both boxes are on screen").not.toBeNull();
  expect(Math.abs(seam!.gap), `gap ${seam!.gap}px`).toBeLessThanOrEqual(1);
  expect(Math.abs(seam!.dx), `left off by ${seam!.dx}px`).toBeLessThanOrEqual(1);
  expect(Math.abs(seam!.dw), `width off by ${seam!.dw}px`).toBeLessThanOrEqual(2);

  // Every row is a title from the corpus. Asserted as "nothing that looks
  // like somebody's query got through" is not assertable from the client —
  // what IS assertable is the endpoint's own answer, checked next.
  await page.waitForTimeout(900);

  // Arrow to the first row, then Enter takes it.
  await composer(page).press("ArrowDown");
  await expect(page.locator("agent-console .hints .hint.on"),
    "the first row highlights").toHaveCount(1);
  await page.waitForTimeout(700);
  await composer(page).press("ArrowDown");
  await page.waitForTimeout(700);
  // The still is taken WHILE the list is open — after Enter it is closed, and
  // a screenshot of the thing having gone says nothing about how it looked.
  await page.screenshot({ path: "test-results/autocomplete-joined.png" });
  await composer(page).press("Enter");

  // Enter on a highlighted row SENDS it: choosing a row with the keyboard is
  // a whole decision, and asking for a second press to confirm what was just
  // chosen is asking twice. The composer empties and the message goes.
  await expect(composer(page), "the composer emptied into a message")
    .toHaveText("", { timeout: 10_000 });
  // The list closes once a choice is made; a dropdown that stays over the
  // composer after you have chosen is a dropdown in the way.
  await expect(list).toBeHidden();

  // And what was sent is one of the rows that were offered.
  const sent = page.locator("agent-console nr-chatbot .message.user").last();
  await expect(sent).toBeVisible({ timeout: 20_000 });
  const said = ((await sent.textContent()) ?? "").trim();
  expect(shown.some((row) => said.includes(row)),
    `sent "${said}" — offered: ${shown.join(" | ")}`).toBeTruthy();
  await page.waitForTimeout(1500);
});

test("the public answer carries no query history", async ({ page }) => {
  await open(page);

  // Straight at the endpoint the composer calls. `source` is the index's own
  // label for where a suggestion came from: "titles" is the corpus, which is
  // a fact about documents anybody may read; "querylog" is what other people
  // typed, which is not. A single one of the latter here would mean the
  // console is showing one visitor's searches to the next.
  const body = await page.evaluate(async () => {
    const res = await fetch("/search-api/suggest?q=lin&k=10", { credentials: "same-origin" });
    return await res.json() as { suggestions?: { text?: string; source?: string }[] };
  });

  const rows = body.suggestions ?? [];
  expect(rows.length, "the index answered").toBeGreaterThan(0);
  const sources = [...new Set(rows.map((r) => r.source))];
  expect(sources, "every suggestion is corpus-derived").not.toContain("querylog");
  expect(sources.every((s) => s === "titles"), `sources: ${sources.join(", ")}`).toBeTruthy();
});

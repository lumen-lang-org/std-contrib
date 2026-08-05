// Tasks: the page of work that runs without anybody asking.
//
// Everything asserted here broke at least once while the feature was being
// built, and each failure looked like nothing rather than like a bug:
//
//   the page element existed and drew a box zero pixels tall, because
//   head.html's height chain named page-index and no other page tag;
//
//   the route answered 200 with real markup and hydrated to nothing, because
//   its class was a default export rather than a named one;
//
//   the rail's mark drew the word "clock" instead of a glyph, which is what
//   nr-icon does with a name the set does not carry.
//
// None of the three raises an error, so a spec that only checked for a 200
// would have passed through all of them. What is checked instead is what a
// person would see: a row that navigates, an address that follows, a page with
// a box, words in it, and marks that resolved to real glyphs.
//
// Read-only, deliberately. Creating a task through this page is a write
// against whichever deployment the suite is pointed at — on a live one that is
// a row that fires a model call on a schedule — so what is exercised here is
// the half that costs nothing: the doors in, the layout, and the refusals a
// person meets before anything is stored.

import { expect, test } from "@playwright/test";
import { loaded, open, shell } from "./console.js";
import { enterConsole } from "./session.js";

const PHONE = { width: 390, height: 844 };

function tasksPage(page: import("@playwright/test").Page) {
  return shell(page).locator("console-tasks");
}

// The rail row, and the address it leads to.
//
// Arriving by clicking is how people reach this — and it is also the only
// route that works today: on a cold load of /tasks the server-rendered console
// keeps its `defer-hydration` attribute and a second, invisible console is
// built beside it, so nothing on screen ever updates. That is not this
// feature's bug — /discover does exactly the same thing — but it is why this
// spec navigates rather than calling open(page, "/tasks").
test("the rail opens the task page, and the address follows", async ({ page }) => {
  await open(page);
  await loaded(page);

  const row = shell(page).locator("console-sidebar [data-nav=\"tasks\"]");
  await expect(row).toBeVisible();

  // The mark, not the word. nr-icon draws the NAME when the set has no glyph
  // for it, so a wrong name is a lowercase word sitting in the rail where a
  // picture belongs — visible in a screenshot, invisible to every assertion
  // that only reads text.
  const drew = await row.locator("nr-icon").evaluate((el) =>
    !!(el.shadowRoot?.querySelector("svg") ?? el.querySelector("svg")));
  expect(drew).toBe(true);

  await row.click();
  await expect(tasksPage(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/tasks");

  // Back leaves it. A place with an address whose Back button does nothing is
  // worse than a place with no address at all.
  await page.goBack();
  await expect(tasksPage(page)).toBeHidden();
});

test("the page has a box, and words in it", async ({ page }) => {
  await open(page);
  await loaded(page);
  await shell(page).locator("console-sidebar [data-nav=\"tasks\"]").click();
  const tasks = tasksPage(page);
  await expect(tasks).toBeVisible();

  // The zero-height failure, asserted directly: the element was present, its
  // shadow root had rendered, and `toBeVisible` was the only thing that
  // noticed. A height under 200px on a 900px viewport is that bug returning.
  const box = await tasks.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(200);

  await expect(tasks.locator("h1")).toHaveText("Tasks");
  await expect(tasks.locator("main h2").first()).toHaveText("New task");
  // The list says what it has, including when it has nothing. An empty region
  // with no sentence in it reads as a page that failed to load.
  const rows = tasks.locator(".task");
  const empty = tasks.locator(".empty");
  expect(await rows.count() + await empty.count()).toBeGreaterThan(0);

  // Every mark on the page resolved to a real glyph.
  const wordy = await page.locator("nr-icon:visible").evaluateAll((els) =>
    els.filter((el) => !(el.shadowRoot?.querySelector("svg") ?? el.querySelector("svg"))).length);
  expect(wordy).toBe(0);
});

test("the schedule examples fill the box they are next to", async ({ page }) => {
  await open(page);
  await loaded(page);
  await shell(page).locator("console-sidebar [data-nav=\"tasks\"]").click();
  const tasks = tasksPage(page);
  await expect(tasks).toBeVisible();

  const chips = tasks.locator(".hints button");
  await expect(chips.first()).toHaveText("every weekday at 08:00");
  await chips.first().click();

  // Read off the element rather than out of the event: nr-input, nr-select and
  // nr-textarea describe their payloads differently and only agree on `.value`
  // (app/CLAUDE.md).
  const when = tasks.locator("nr-input").first();
  await expect.poll(async () => when.evaluate((el) => (el as HTMLInputElement).value))
    .toBe("every weekday at 08:00");
});

test("a task nobody could run is refused before anything is stored", async ({ page }) => {
  await open(page);
  await loaded(page);
  await shell(page).locator("console-sidebar [data-nav=\"tasks\"]").click();
  const tasks = tasksPage(page);
  await expect(tasks).toBeVisible();

  // Nothing typed at all. The refusal is the console's own — no request is
  // made — so it is the one assertion here that holds whoever is signed in.
  await tasks.locator("nr-button[type=\"submit\"]").click();
  await expect(tasks.locator(".err")).toBeVisible();
  await expect(tasks.locator(".err")).toContainText("something to do");

  // An instruction with no schedule. Also refused here rather than at the
  // engine, because "when" is the one field a person cannot be assumed to
  // have meant to leave blank.
  await tasks.locator("nr-textarea").first().evaluate((el) => {
    (el as HTMLInputElement).value = "say hello";
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  });
  await tasks.locator("nr-button[type=\"submit\"]").click();
  await expect(tasks.locator(".err")).toContainText("schedule");
});

test("the page stacks rather than shrinks on a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  await loaded(page);
  // The rail is a drawer at this width, so the row is reached through it.
  await shell(page).locator("header .icon.nav, header button[title=\"Conversations\"]").first().click();
  await shell(page).locator("console-sidebar [data-nav=\"tasks\"]").click();

  const tasks = tasksPage(page);
  await expect(tasks).toBeVisible();
  // One column: the list sits above the editor rather than beside it in a
  // 150px sliver. Proven by geometry — the editor starts below the list's top
  // and the page does not scroll sideways.
  const list = await tasks.locator("aside").boundingBox();
  const editor = await tasks.locator("main").boundingBox();
  expect(editor?.y ?? 0).toBeGreaterThan(list?.y ?? 0);
  const spills = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(spills).toBe(false);
});

// The other way in: the panel that floats over this page.
//
// Signed in, because it is hidden for anybody who cannot schedule at all — a
// box that answers every message with "sign in first" teaches that worse than
// the sentence above the form does. Skips rather than fails where the
// deployment has no credentials to sign in with, which is the same rule
// e2e/session.ts states for every spec that needs to be somebody.
//
// What is checked is what the shape has to be, and every part of it broke at
// least once while the article page was being built: the panel FLOATS (the
// page runs underneath it rather than stopping above it), it reserves the room
// it takes (or the last row of the editor sits behind it forever), and it is
// one panel rather than a scatter of loose bubbles with the page showing
// between them.
//
// Read-only, like the rest of this file: typing into it costs a model call and
// leaves a row that fires on a schedule. That path is exercised in the
// engine's own suite (packages/agents/task-tools.test.ts) and by hand against
// a deployment.
test("the ask panel floats over the page, and the page leaves room for it", async ({ page }) => {
  // Signed in, through whichever door this deployment leaves open — and the
  // arrival is the helper's, not open()'s, because a visitor whose guest
  // allowance is spent lands on /auth/login where there is no console at all.
  if (!(await enterConsole(page))) { test.skip(true, "no credentials for this deployment"); }
  await loaded(page);
  await shell(page).locator("console-sidebar [data-nav=\"tasks\"]").click();
  const tasks = tasksPage(page);
  await expect(tasks).toBeVisible();

  const dock = tasks.locator("ask-dock");
  await expect(dock).toBeVisible();
  // The surface itself, not the layer around it: the host carries the page's
  // side and bottom padding, so its box is a little taller than the panel and
  // the two are not interchangeable in a measurement.
  const panel = await dock.evaluate((el) => {
    const box = (el as Element & { shadowRoot: ShadowRoot | null })
      .shadowRoot?.querySelector(".askcol")?.getBoundingClientRect();
    return box === undefined ? null : { y: box.y, height: box.height };
  });
  const page_ = await tasks.boundingBox();
  expect(panel?.height ?? 0).toBeGreaterThan(40);

  // Floating means over something: the panel's top edge is inside the page's
  // box, not below it. A panel that took a row of its own would sit flush at
  // the bottom with the editor stopping above it — which is what this page had
  // before, and what reads as a widget bolted under the content.
  expect((panel?.y ?? 0)).toBeGreaterThan(page_?.y ?? 0);
  expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual(
    (page_?.y ?? 0) + (page_?.height ?? 0) + 2);

  // And the editor underneath reserves it. The measurement is published by
  // ask-dock as --ask-space and spent as bottom padding; without it the Delete
  // button is permanently behind the panel.
  const reserved = await tasks.evaluate((el) =>
    parseFloat(getComputedStyle(el).getPropertyValue("--ask-space") || "0"));
  expect(reserved).toBeGreaterThan(panel!.height);

  // One panel, not loose parts: the input box, the openers and everything else
  // inside share a single bordered surface.
  const surfaces = await dock.evaluate((el) =>
    (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot?.querySelectorAll(".askcol").length ?? 0);
  expect(surfaces).toBe(1);
});

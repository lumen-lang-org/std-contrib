// The + menu in the composer: connectors, their switches, and the submenu.
//
// This surface is drawn by the console into a slot nr-chatbot forwards to
// nr-dropdown, which is three shadow roots deep and impossible to reason about
// from the source. Every bug it had was found by measuring the deployed page —
// a switch clipped 6px past the panel edge, a flyout that reported itself on
// screen and rendered nothing, a submenu that opened over the rows beneath it.
// None of them were visible in a diff, and none would fail any other spec.
//
//   CONSOLE_URL=https://joule.sh npx playwright test e2e/composer-menu.spec.ts
//
// Credentials come from packages/agents/app/.env — a guest sees the menu but
// has no connector of their own to switch, so the toggling tests skip.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { open, ready } from "./console.js";

const USER = process.env.JOULE_TEST_USER ?? "";
const PASS = process.env.JOULE_TEST_PASS ?? "";
const API = process.env.AGENTS_API ?? "http://127.0.0.1:8100";

/** One element, through however many shadow roots. Returned as a handle so a
 *  caller can click it or read it. */
const FIND = `(sel) => {
  const find = (root, depth = 0) => {
    if (depth > 16) return null;
    for (const el of root.querySelectorAll("*")) {
      if (el.matches && el.matches(sel)) return el;
      if (el.shadowRoot) { const hit = find(el.shadowRoot, depth + 1); if (hit) return hit; }
    }
    return null;
  };
  return find(document);
}`;

async function click(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(([sel, src]) => {
    const el = (new Function("return " + src)())(sel) as HTMLElement | null;
    if (el === null) { return false; }
    el.click();
    return true;
  }, [selector, FIND]);
}

async function seen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(([sel, src]) =>
    (new Function("return " + src)())(sel) !== null, [selector, FIND]);
}

async function openMenu(page: Page): Promise<void> {
  // The trigger is nr-dropdown's own button, inside the chatbot.
  await page.evaluate(([src]) => {
    const dd = (new Function("return " + src)())("nr-dropdown") as HTMLElement | null;
    const btn = dd?.querySelector("nr-button") as HTMLElement | null;
    (btn ?? dd)?.click();
  }, [FIND]);
  await page.waitForTimeout(1200);
}

async function signIn(page: Page): Promise<void> {
  await page.evaluate(([user, pass, src]) => {
    const find = new Function("return " + src)() as (s: string) => Element | null;
    (find(".guest-signin") as HTMLElement | null)?.click();
    window.setTimeout(() => {
      const set = (el: Element | null, v: string) => {
        if (el === null) { return; }
        (el as HTMLInputElement).value = v;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      };
      set(find("input[type=email]"), user);
      set(find("input[type=password]"), pass);
      const overlay = find("login-overlay") as (Element & { shadowRoot: ShadowRoot | null }) | null;
      const root = overlay?.shadowRoot ?? document;
      const go = [...root.querySelectorAll("button, nr-button")]
        .find((b) => /sign in|continue|log in/i.test(b.textContent ?? ""));
      (go as HTMLElement | undefined)?.click();
    }, 1000);
  }, [USER, PASS, FIND]);
  await page.waitForTimeout(6000);
}

test("the menu is the console's own, not the component's item list", async ({ page }) => {
  await open(page);
  await ready(page);
  await openMenu(page);

  // `.attach` only exists if the slot forwarding worked: nr-chatbot has to
  // honour custom-attach-menu and nr-dropdown has to render the forwarded slot
  // as its content. If either half regresses the component falls back to its
  // own {id,label,icon} list, which looks almost identical and can do none of
  // what the rest of this file checks.
  expect(await seen(page, ".attach"), "the slotted panel rendered").toBeTruthy();
  const rows = await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    return [...(panel?.querySelectorAll(".attach-row") ?? [])]
      .map((r) => (r.textContent ?? "").trim());
  }, [FIND]);
  expect(rows.some((r) => r.startsWith("Add files")), "it offers files").toBeTruthy();
  expect(rows.some((r) => r.startsWith("Skills")), "and skills").toBeTruthy();
});

test("every row is the same width, including the one with a submenu", async ({ page }) => {
  await open(page);
  await ready(page);
  await openMenu(page);

  // The Skills row sits in a wrapper the others do not have, so it was the one
  // row at its own intrinsic width while every other stretched. A menu whose
  // rows disagree by 40px reads as broken before anybody presses anything.
  const widths = await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    return [...(panel?.querySelectorAll(".attach-row") ?? [])]
      .map((r) => Math.round(r.getBoundingClientRect().width));
  }, [FIND]);
  expect(widths.length, "there are rows to measure").toBeGreaterThan(2);
  expect(new Set(widths).size, `all rows one width, got ${widths.join(",")}`).toBe(1);
});

test("nothing overflows the panel", async ({ page }) => {
  await open(page);
  await ready(page);
  await openMenu(page);

  // The switch at the end of a connector row sat 6px past the panel's right
  // edge, half of it clipped, because the rows resolved width:100% against the
  // padding box. Measured rather than eyeballed — it is six pixels.
  const spill = await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    if (panel === null) { return null; }
    const edge = panel.getBoundingClientRect().right;
    return [...panel.querySelectorAll(".attach-row, .sw, .attach-warn")]
      .map((el) => Math.round(el.getBoundingClientRect().right - edge))
      .filter((over) => over > 0);
  }, [FIND]);
  expect(spill, "nothing sticks out of the panel").toEqual([]);
});

test("the skills submenu opens, filters, and stays on screen", async ({ page }) => {
  await open(page);
  await ready(page);
  await openMenu(page);

  await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    const row = [...(panel?.querySelectorAll(".attach-row") ?? [])]
      .find((r) => (r.textContent ?? "").trim().startsWith("Skills"));
    (row as HTMLElement | undefined)?.click();
  }, [FIND]);
  await page.waitForTimeout(900);

  expect(await seen(page, ".fly"), "the flyout opened").toBeTruthy();

  const before = await page.evaluate(([src]) => {
    const fly = (new Function("return " + src)())(".fly") as HTMLElement | null;
    const box = fly?.getBoundingClientRect();
    return {
      rows: fly?.querySelectorAll(".attach-row").length ?? 0,
      onScreen: box !== undefined && box.left >= -1 && box.right <= window.innerWidth + 1,
      hasFind: fly?.querySelector(".fly-find") !== null,
    };
  }, [FIND]);
  // It reported itself on screen once while rendering nothing at all — an
  // absolutely positioned flyout inside a container that clips its overflow.
  // So this asserts a visible box AND that it is where it says it is.
  expect(before.onScreen, "the flyout is inside the viewport").toBeTruthy();
  expect(before.rows, "it lists skills").toBeGreaterThan(0);

  if (before.hasFind) {
    await page.evaluate(([src]) => {
      const input = (new Function("return " + src)())(".fly-find input") as HTMLInputElement | null;
      if (input === null) { return; }
      input.value = "zzzz-nothing-matches";
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }, [FIND]);
    await page.waitForTimeout(600);
    const after = await page.evaluate(([src]) => {
      const fly = (new Function("return " + src)())(".fly") as HTMLElement | null;
      return {
        rows: fly?.querySelectorAll(".attach-row").length ?? 0,
        says: (fly?.querySelector(".fly-none")?.textContent ?? "").trim(),
      };
    }, [FIND]);
    expect(after.rows, "the filter filtered").toBe(0);
    expect(after.says, "and said so rather than going blank").not.toBe("");
  }
});

test("Manage connectors closes the menu behind it", async ({ page }) => {
  await open(page);
  await ready(page);
  await openMenu(page);

  await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    const row = [...(panel?.querySelectorAll(".attach-row") ?? [])]
      .find((r) => (r.textContent ?? "").trim().startsWith("Manage connectors"));
    (row as HTMLElement | undefined)?.click();
  }, [FIND]);
  await page.waitForTimeout(2500);

  // It used to open the directory and leave the dropdown sitting on top of the
  // thing it had just opened.
  expect(await seen(page, ".gallery"), "the directory opened").toBeTruthy();
  const stillOpen = await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    if (panel === null) { return false; }
    const box = panel.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }, [FIND]);
  expect(stillOpen, "and the dropdown closed").toBeFalsy();
});

test("a connector's switch writes through to the server", async ({ page, request }) => {
  test.skip(USER === "" || PASS === "", "put credentials in packages/agents/app/.env");
  await open(page);
  await ready(page);
  await signIn(page);
  await openMenu(page);

  const first = await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    const row = panel?.querySelector(".conn-row");
    if (row === null || row === undefined) { return null; }
    const sw = row.querySelector(".sw");
    return {
      name: (row.querySelector(".attach-label")?.textContent ?? "").trim(),
      on: sw?.classList.contains("on") ?? null,
    };
  }, [FIND]);
  test.skip(first === null || first.on === null, "no switchable connector on this deployment");
  const name = first!.name;
  const was = first!.on!;

  await page.evaluate(([src]) => {
    const panel = (new Function("return " + src)())(".attach") as HTMLElement | null;
    (panel?.querySelector(".conn-row .sw") as HTMLElement | null)?.click();
  }, [FIND]);
  await page.waitForTimeout(2500);

  // The switch is not a local flag: it has to have reached the engine, or the
  // next conversation mounts a connector the person thought they had turned
  // off. Read back from the API, not from the DOM that was just clicked.
  const rows = await (await request.get(`${API}/servers`)).json();
  const row = rows.find((s: { serverName: string }) => s.serverName === name);
  expect(row, `${name} is still a server`).toBeTruthy();
  expect(row.enabled, `${name} flipped from ${was} to ${!was} on the server`).toBe(!was);

  // Put it back: this runs against a real deployment, and a test that leaves a
  // connector switched off is a test that breaks somebody's afternoon.
  await request.put(`${API}/servers/${encodeURIComponent(row.id)}`, {
    data: { ...row, enabled: was },
  });
  const after = await (await request.get(`${API}/servers`)).json();
  expect(after.find((s: { id: string }) => s.id === row.id).enabled,
    "restored").toBe(was);
});

// Reaching into the console from a test.
//
// Every region is a custom element with its own shadow root, so a plain
// `page.locator("button")` finds nothing. Playwright pierces open shadow
// roots automatically for CSS, but not across the nested boundaries here, so
// these helpers name the path explicitly — one place to fix when the shell
// moves, instead of every spec.

import { Locator, Page, expect } from "@playwright/test";

export const CONSOLE = "agent-console";

export function shell(page: Page): Locator {
  return page.locator(CONSOLE);
}

export function sidebar(page: Page): Locator {
  return shell(page).locator("console-sidebar");
}

export function knowledge(page: Page): Locator {
  return shell(page).locator("knowledge-page");
}

export function canvas(page: Page): Locator {
  return shell(page).locator("agent-canvas");
}

export function settings(page: Page): Locator {
  return shell(page).locator("console-settings");
}

// Open Settings the way a person does: the account block, then the item.
export async function openSettings(page: Page) {
  await sidebar(page).locator(".me").click();
  await sidebar(page).locator(".menu div", { hasText: "Settings" }).click();
  await expect(settings(page)).toBeVisible();
}

export async function openTab(page: Page, name: string) {
  // By name, not by text. An item is an icon beside a word, and the template
  // puts newlines around both — so a `^Agents$` match against its text content
  // never fires, however right it looks.
  await settings(page).locator(`aside .item[data-tab="${name}"]`).click();
}

export async function openKnowledge(page: Page) {
  await sidebar(page).locator('.item[data-nav="knowledge"]').click();
  await expect(knowledge(page)).toBeVisible();
}

// Whether the API is backed by PostgreSQL. The document routes answer a plain
// sentence when it is not, and the knowledge specs skip on that rather than
// reporting a failure for behaviour that is correct.
export async function openCanvas(page: Page) {
  await sidebar(page).locator('.item[data-nav="canvas"]').click();
  await expect(canvas(page)).toBeVisible();
}

export async function hasPostgres(page: Page): Promise<boolean> {
  const res = await page.request.get("/api/documents?scope=/");
  if (res.ok()) return true;
  const body = await res.text();
  return !body.includes("PostgreSQL");
}

// The API answers errors as {"error": "..."}. A spec asserting a refusal
// should assert the sentence, not the status code — the sentence is what a
// user reads.
export async function errorOf(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (JSON.parse(await res.text()) as { error?: string }).error ?? "";
  } catch {
    return "";
  }
}


// The control inside a LumenUI field.
//
// `<nr-input id="c-name">` is a wrapper; the thing that holds a value and
// answers fill() is the <input> in its shadow root. Playwright pierces open
// shadow roots for CSS, so this reaches it — and naming it once means the
// specs do not each have to know that a field is a component rather than an
// element.
export function field(root: Locator, id: string): Locator {
  return root.locator(`#${id} input, #${id} textarea, #${id} code.editor`).first();
}

// Typing into the prompt editor.
//
// It is a contenteditable with CodeJar behind it, and CodeJar only learns of
// text that arrives as keystrokes. `fill()` sets the node's text without one,
// so the highlighter never runs, the gutter stays at one line, and — the part
// that matters — the form's draft never hears about the change, so Save stores
// an empty prompt while the screen shows a full one.
export async function typeInEditor(root: Locator, id: string, text: string) {
  const el = root.locator(`#${id} code.editor`);
  await el.click();
  await el.press("ControlOrMeta+a");
  await el.pressSequentially(text);
}

// A LumenUI select shows its value as text rather than as an <option>, so it
// is read, not asked for `inputValue`.
export function selectValue(root: Locator, id: string): Locator {
  return root.locator(`#${id}`);
}

// Choosing in a LumenUI select. There is no <select> to `selectOption`: the
// trigger opens a listbox of divs, each carrying its value as `data-value`.
export async function choose(root: Locator, id: string, value: string) {
  await root.locator(`#${id} .wrapper`).click();
  await root.locator(`#${id} .option[data-value="${value}"]`).click();
}

// A LumenUI checkbox copies its id onto the <input> it renders, so an id on
// its own matches two elements. This is the control — the thing that clicks.
export function toggle(root: Locator, id: string): Locator {
  return root.locator(`input#${id}`);
}

// What a select offers, whether or not it is open — the listbox is in the DOM
// either way, which is what makes this readable without a click.
export function choices(root: Locator, id: string): Locator {
  return root.locator(`#${id} .option`);
}

// The flat columns of an agent row, and nothing else.
//
// GET /agents answers the *full* view — prompt, config, servers and sub-agents
// nested — and `JSON.parse<AgentRow>` refuses both unknown and missing fields.
// Hand-listing the columns in each spec meant every new column broke several
// tests at once; this is the one place that knows the shape.
export type AgentFlat = {
  id: string; agentName: string; description: string;
  modelConfigId: string; promptId: string; enabled: boolean;
  isDefault: boolean; updatedAt: string;
};

export function agentRow(a: Record<string, unknown>, over: Partial<AgentFlat> = {}): AgentFlat {
  return {
    id: a.id as string,
    agentName: a.agentName as string,
    description: a.description as string,
    modelConfigId: a.modelConfigId as string,
    promptId: a.promptId as string,
    enabled: a.enabled as boolean,
    isDefault: (a.isDefault as boolean) ?? false,
    updatedAt: "now",
    ...over,
  };
}

// The same, for a model row.
export type ModelFlat = {
  id: string; label: string; apiName: string; provider: string;
  kind: string; dimensions: number; baseUrl: string; enabled: boolean;
};

export function modelRow(over: Partial<ModelFlat> & { id: string }): ModelFlat {
  return {
    label: "Probe", apiName: "mistral-small-latest", provider: "mistral",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: false,
    ...over,
  };
}

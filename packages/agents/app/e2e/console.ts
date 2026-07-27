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
  await settings(page).locator("aside div", { hasText: new RegExp(`^${name}$`) }).click();
}

export async function openKnowledge(page: Page) {
  await sidebar(page).locator(".thread", { hasText: "Knowledge" }).click();
  await expect(knowledge(page)).toBeVisible();
}

// Whether the API is backed by PostgreSQL. The document routes answer a plain
// sentence when it is not, and the knowledge specs skip on that rather than
// reporting a failure for behaviour that is correct.
export async function openCanvas(page: Page) {
  await sidebar(page).locator(".thread", { hasText: "Agent graph" }).click();
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

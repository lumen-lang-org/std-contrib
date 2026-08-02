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

// The console, once it can answer — and the only way a spec should arrive at
// one.
//
// The page is server-rendered, so its markup is on screen well before the
// module that gives it behaviour: `<agent-console>` and every region inside it
// arrive in the first response and paint, and until the custom element is
// registered the browser treats all of it as unknown markup. A click in that
// window is not queued and not replayed — it is dropped — so the account
// block opens no menu, the rail navigates nowhere and the header's agent
// picker holds no options, and the test then waits out its whole timeout for
// a result nothing was ever asked to produce.
//
// `await expect(shell(page)).toBeVisible()` was the correct wait while the
// console was client-rendered: the element did not exist until its module ran,
// so seeing it meant it worked. Server-rendering severed those two facts and
// left the assertion looking untouched, which is why the failures it caused
// read as five broken features rather than as one changed precondition.
//
// So the wait is on the element being defined and past its first render, which
// is the thing a person is actually waiting for. Nothing is skipped or
// softened here: every assertion a spec made it still makes, one navigation
// later.
// `waitForFunction` rather than awaiting `customElements.whenDefined` inside
// one `evaluate`: the wait is long enough to straddle a navigation — a dev
// server's full reload, a redirect — and an evaluate whose page goes away dies
// with "Resulting promise was garbage collected", which describes Playwright's
// internals and not anything a reader of this suite did wrong. waitForFunction
// re-runs itself on the new document instead. The registry is global, so it is
// asked about rather than the element, and the element is only awaited once
// there is a class to have upgraded it.
export async function ready(page: Page): Promise<void> {
  const el = shell(page).first();
  await expect(el).toBeVisible();
  await page.waitForFunction((tag) => !!customElements.get(tag), CONSOLE);
  await el.evaluate((node) =>
    (node as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete);
}

// Go to the console and wait for it to be the console.
export async function open(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await ready(page);
}

// The console after its own first fetches, not merely after its first render.
//
// For a test that counts the requests a tab makes. The console asks the API
// two questions for itself when it loads — the conversation list and the agent
// list — and a listener attached before those land counts them as if the tab
// had gone looking. That is how the "no refetch" proof of the live feed failed
// while the feed was working perfectly: two entries in an array that was
// supposed to be empty, both of them the page opening.
//
// Waiting for what those answers *draw* is what makes this deterministic: the
// rail has rows or says it has none, and the picker has options.
export async function loaded(page: Page): Promise<void> {
  await ready(page);
  await expect(sidebar(page).locator(".thread, .none").first()).toBeVisible();
  // The agents fetch, proven through the composer's placeholder — "Ask
  // <agent>…" replaces the fallback the moment the list lands. The header
  // select this used to wait on left with the agent chip; the placeholder is
  // the surface that still says the same fact.
  await expect(shell(page).locator("nr-chatbot"))
    .not.toHaveAttribute("placeholder", "Ask agent…");
}

// The conversation the console is on, read off the element rather than guessed
// from the API: asking for "the newest thread" races every other spec.
//
// Read through the locator, never through `document.querySelector` in a
// `page.evaluate`. The console is not a document-level node under LumenJS — it
// sits inside the page element's shadow root — so a raw querySelector returns
// null and the caller gets "" for a conversation that is plainly on screen.
// Two spec files did exactly that and failed wholesale on `/api/threads//…`.
// A locator crosses open shadow roots; `evaluate` on it runs against the
// element it found, so this keeps working wherever the shell puts the console.
export async function currentThread(page: Page): Promise<string> {
  return await shell(page).first()
    .evaluate((el) => (el as HTMLElement & { threadId?: string }).threadId ?? "");
}

export function knowledge(page: Page): Locator {
  return shell(page).locator("knowledge-page");
}

export function canvas(page: Page): Locator {
  return shell(page).locator("agent-canvas");
}

// Not scoped to the console shell any more: settings is its own route, and on
// /admin there is no <agent-console> to be inside of.
export function settings(page: Page): Locator {
  return page.locator("console-settings");
}

// The Starting points page. It is a region of the console's own root rather
// than an element of its own, so it is named by class — and by the class the
// page's container carries, not the `.starts` row under the composer, which is
// a different feature with a confusingly similar name (templates for a pinned
// capability).
export function startsPage(page: Page): Locator {
  return shell(page).locator(".starts-page");
}

// The bar across the bottom of an empty home. Phone-only by design: the rail
// carries the same destination as a row, so the bar is display:none at widths
// where the rail is a column. A spec that wants it has to be at a phone size.
export function exploreBar(page: Page): Locator {
  return shell(page).locator(".explore");
}

// Open Starting points the way a person on a desktop does: the rail's row.
export async function openStarts(page: Page) {
  await openRail(page);
  await sidebar(page).locator('.item[data-nav="starts"]').click();
  await expect(startsPage(page)).toBeVisible();
}

// The rail, on screen.
//
// It is a column at 1025px and wider and an off-canvas drawer below that —
// one media query in src/console.ts, and the width at which a chat pane
// squeezed between two fixed columns stops being usable. A person at a narrow
// width presses the header's Conversations button before touching the rail,
// and so must a test: without it every rail locator resolves to an element
// that is parked one rail-width to the left of the viewport, which Playwright
// reports as "element is outside of the viewport" and retries until the test
// times out. It reads as a rail that stopped working rather than as one that
// is closed.
//
// A no-op at desktop widths, where the button does not exist.
export async function openRail(page: Page) {
  const toggle = shell(page).locator("header .icon.nav");
  if (!(await toggle.isVisible())) return;
  const already = await shell(page).first().evaluate((el) => el.hasAttribute("nav"));
  if (!already) await toggle.click();
}

// Open user Settings the way a person does: the account block, then the row.
// This is the USER zone — agents, prompts, skills, templates, connectors,
// plugins. The admin zone is a route, /admin/<tab>, and has its own helper.
export async function openSettings(page: Page) {
  await openRail(page);
  await sidebar(page).locator(".me").click();
  await sidebar(page).locator(".menu div", { hasText: /^Settings$/ }).click();
  await expect(settings(page)).toBeVisible();
}

// The operator's page. Arrive hydrated, for the reason `open` exists: the
// route is server-rendered and a click before the module runs is dropped.
export async function openAdmin(page: Page, path = "/admin/models") {
  await page.goto(path);
  await page.waitForFunction(() => customElements.get("admin-page") !== undefined);
  await expect(settings(page)).toBeVisible();
}

// Preferences is the Settings overlay's first tab now, not a panel — open
// Settings and you are on it.

export async function openTab(page: Page, name: string) {
  // By name, not by text. An item is an icon beside a word, and the template
  // puts newlines around both — so a `^Agents$` match against its text content
  // never fires, however right it looks.
  await settings(page).locator(`aside .item[data-tab="${name}"]`).click();
}

export async function openKnowledge(page: Page) {
  await openRail(page);
  await sidebar(page).locator('.item[data-nav="knowledge"]').click();
  await expect(knowledge(page)).toBeVisible();
}

// Whether the API is backed by PostgreSQL. The document routes answer a plain
// sentence when it is not, and the knowledge specs skip on that rather than
// reporting a failure for behaviour that is correct.
// Through an agent's card, because that is the only door now: the rail row
// is gone — the graph is a view OF an agent, not a place beside Knowledge.
// Any enabled agent's card will do for specs that only need the canvas open.
export async function openCanvas(page: Page) {
  await openRail(page);
  await sidebar(page).locator('.item[data-nav="agents"]').click();
  const gallery = shell(page).locator(".gallery");
  await expect(gallery).toBeVisible();
  await gallery.locator(".pick-act", { hasText: "View graph" }).first().click();
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

// Choosing in a settings field. There is no <select> to `selectOption`: the
// field is an nr-dropdown whose trigger is a button and whose menu is a list of
// `.dropdown__item`, keyed by the id put in each item.
//
// Matched on the item's exact text rather than on a value attribute, because
// that is what the dropdown renders — it keeps the id in its own item objects
// and puts only the label in the DOM. So callers pass the LABEL, which is what
// the person clicking sees anyway; the one caller that passed a value ("m-kind"
// → "embedding") passes a label that happens to read the same.
export async function choose(root: Locator, id: string, label: string) {
  await root.locator(`#${id} [slot="trigger"]`).click();
  await root.locator(`#${id} .dropdown__item`)
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first().click();
}

// A LumenUI checkbox copies its id onto the <input> it renders, so an id on
// its own matches two elements. This is the control — the thing that clicks.
export function toggle(root: Locator, id: string): Locator {
  return root.locator(`input#${id}`);
}

// What a field offers, whether or not it is open — nr-dropdown renders its
// panel either way and hides it with `display: none`, so the items are in the
// DOM to be read without a click. `allTextContents` does not require
// visibility, which is what keeps this a read rather than an interaction.
export function choices(root: Locator, id: string): Locator {
  return root.locator(`#${id} .dropdown__item`);
}

// The flat columns of an agent row, and nothing else.
//
// GET /agents answers the *full* view — prompt, config, servers and sub-agents
// nested — and `JSON.parse<AgentRow>` refuses both unknown and missing fields.
// Hand-listing the columns in each spec meant every new column broke several
// tests at once; this is the one place that knows the shape.
export type AgentFlat = {
  id: string; agentName: string; description: string;
  modelConfigId: string; promptId: string; scriptImageId: string; enabled: boolean;
  isDefault: boolean; updatedAt: string;
};

export function agentRow(a: Record<string, unknown>, over: Partial<AgentFlat> = {}): AgentFlat {
  return {
    id: a.id as string,
    agentName: a.agentName as string,
    description: a.description as string,
    modelConfigId: a.modelConfigId as string,
    promptId: a.promptId as string,
    scriptImageId: (a.scriptImageId as string) ?? "",
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

// Put a fresh conversation on the named agent. New conversations open against
// the flagged default — the real model — so a spec that drives the double has
// to say so, the same way a person picks an agent from the header.
export async function pickAgent(page: Page, agentId: string) {
  await shell(page).locator("header select").selectOption(agentId);
}

// --- the e2e fixtures --------------------------------------------------------
//
// The suites run against agents of their own — e2e-doubled and its child
// e2e-helper, wired to the scripted model double — and never against anything
// a person made. This grows them on a database that lacks them, idempotently:
// every row is looked for before it is created, nothing that exists is
// edited, and no default flag is ever touched. A provider key is written only
// where none exists, because a key can never be read back and a fixture that
// overwrites one cannot restore it.
export const E2E_AGENT = "e2e-doubled";
export const E2E_HELPER = "e2e-helper";

type Req = Page["request"];

async function rows(request: Req, path: string): Promise<Record<string, unknown>[]> {
  return await request.get(path).then((r) => r.json()) as Record<string, unknown>[];
}

// Put the doubled agent's script environment back to the default, if a run
// left it somewhere else.
//
// Empty means the default image — python and node, `agents-runtime:1` in
// run-script.ts. One spec borrows the browser image for the length of one test
// and hands it back in a `finally`, which holds right up until the run it is
// in is killed: a Ctrl-C, a CI step that times out, a `timeout` wrapped around
// the suite. After that every *other* script test runs in the browser image,
// where a plain `pip install` answers "externally-managed-environment" — so
// the spec that exists to prove an environment remembers a package proves
// nothing, and says so as a chat message that never arrives. It stays that way
// for every run afterwards, because a fixture that only creates never repairs.
//
// One request, and the borrow can no longer outlive the run that made it.
export async function ownScriptImage(request: Req): Promise<void> {
  const held = (await rows(request, "/api/agents")).find((a) => a.agentName === E2E_AGENT);
  if (!held || (held.scriptImageId ?? "") === "") return;
  await request.put(`/api/agents/${held.id as string}`, {
    data: agentRow(held, { scriptImageId: "" }),
  });
}

/** Where the model double listens. The one address the fixture will accept on
 *  `m-double`; `playwright.config.ts` starts the process on the same port. */
export const DOUBLE_ADDRESS = "http://127.0.0.1:8932";

/** The double's key. Named so it is obvious in a diff that no real credential
 *  is being written — see the fixtures rule in CLAUDE.md. */
export const DOUBLE_KEY = "e2e-double-not-a-real-key";

// Put the double's address back, if a run left it pointed somewhere dead.
//
// The same shape as ownScriptImage above, and for the same reason. One spec
// moves m-double to 127.0.0.1:8999 to prove that a round which never reaches a
// provider stores nothing, then moves it back — which holds right up until the
// run is killed between the two. After that every spec that drives the double
// gets "the provider refused the stream: -1" from a console that is working
// perfectly, and it stays that way for every run afterwards, because
// ensureDoubled short-circuits on the existing agent and never re-posts the
// model row. That is exactly what had happened here: the row sat on 8999 with
// nothing listening on it.
//
// Moving costs the key: the API refuses to re-address a model while a secret
// is stored for the host it currently sends to, which is the rule that stops a
// stored key being mailed to whatever address someone names. So this clears,
// moves, and sets again — the double's key, never a real provider's.
export async function ownDoubleAddress(request: Req): Promise<void> {
  const model = (await rows(request, "/api/models")).find((m) => m.id === "m-double");
  if (!model || model.baseUrl === DOUBLE_ADDRESS) return;
  await request.delete("/api/providers/double/key");
  await request.put("/api/models/m-double", {
    data: { ...model, baseUrl: DOUBLE_ADDRESS },
  });
  await request.put("/api/providers/double/key", { data: { apiKey: DOUBLE_KEY } });
}

export async function ensureDoubled(request: Req): Promise<string> {
  const agents = await rows(request, "/api/agents");
  const held = agents.find((a) => a.agentName === E2E_AGENT);
  if (held) {
    await ownScriptImage(request);
    await ownDoubleAddress(request);
    return held.id as string;
  }

  // `provider: "double"`, and the word is load-bearing rather than cosmetic.
  //
  // It used to say `openai`, because the double speaks the OpenAI wire format
  // and naming the format in the provider column was the shortest way to get
  // there. The engine agrees either way — provider.ts is Anthropic-shaped
  // versus OpenAI-shaped and an unknown name falls to the OpenAI branch, while
  // `endpointFor` prefers this row's own baseUrl over any provider address —
  // but one thing does read the name: the derived model menu excludes
  // `models.provider = 'double'` and nothing else can tell a fake model from a
  // real one. Under the old spelling that exclusion matched no row, and a
  // deployment carrying this fixture published "Double" on the menu real users
  // pick from, pointed at a loopback port.
  //
  // Two consequences, both deliberate. The key is stored under `double`,
  // because run.ts resolves `credentialFor(db, model.provider, master)` and a
  // key filed under `openai` would not be found. And this whole function
  // short-circuits on an existing agent, so a box that already has the old row
  // needs `UPDATE models SET provider = 'double' WHERE id = 'm-double'` by
  // hand — the provider name is the one field the fixture cannot repair,
  // because a row it never re-posts is a row it never reads a mistake out of.
  // The *address* is repaired, above: it is the field a spec deliberately
  // moves, so it is the field a killed run leaves wrong.
  if (!(await rows(request, "/api/models")).some((m) => m.id === "m-double")) {
    await request.post("/api/models", { data: {
      id: "m-double", label: "Double", apiName: "double-1", provider: "double",
      kind: "chat", dimensions: 0, baseUrl: DOUBLE_ADDRESS, enabled: true,
    } });
  }
  const providers = await request.get("/api/providers").then((r) => r.json()) as string[];
  if (!providers.includes("double")) {
    await request.put("/api/providers/double/key", { data: { apiKey: DOUBLE_KEY } });
  }
  if (!(await rows(request, "/api/model-configs")).some((c) => c.id === "c-double")) {
    await request.post("/api/model-configs", { data: {
      id: "c-double", modelId: "m-double", temperature: 0, maxTokens: 1024, topP: 1,
      extra: "{}", thinking: "",
    } });
  }
  let prompt = (await rows(request, "/api/prompts")).find((p) => p.promptName === "e2e-double");
  if (!prompt) {
    prompt = await request.post("/api/prompts", { data: {
      id: "", promptName: "e2e-double", version: 0,
      body: "You are a test double. Answer as arranged.", createdAt: "",
    } }).then((r) => r.json()) as Record<string, unknown>;
  }

  const mk = async (id: string, name: string, why: string) =>
    await request.post("/api/agents", { data: {
      id, agentName: name, description: why, modelConfigId: "c-double",
      promptId: prompt!.id as string, isDefault: false, enabled: true, updatedAt: "now",
    } });
  await mk("a-double", E2E_AGENT, "e2e fixture: answers from the scripted model double; not for people");
  await mk("a-helper", E2E_HELPER, "e2e fixture: sub-agent on the model double; not for people");
  await request.post("/api/agents/a-double/sub-agents", { data: { childId: "a-helper" } });
  return "a-double";
}

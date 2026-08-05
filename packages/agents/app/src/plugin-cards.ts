// Plugin renderers, loaded from the engine's snapshot and run in the sandbox.
//
// The console's half of the card-plugin design (the engine's half is
// toolcards.ts/plugincards.ts in the agents package; the sandbox document is
// server/plugin-host.ts). What this module owes the rest of the console:
//
//   loadPluginRenderers()          once at boot; quiet about every failure
//   hasPluginMarker(name)          is this marker a loaded plugin's?
//   renderPluginCards(raw, ev)     async: plugin blocks -> sanitized HTML
//
// It is a SEPARATE pass from renderWithCards, run before it, because that
// pipeline is synchronous strings and the sandbox answers over postMessage.
// Built-in cards (currency, text) never come near this file.
//
// Two containments, each doing only its own job. The iframe contains
// EXECUTION: null origin, no cookies, no storage, no network (see
// plugin-host.ts for the exact CSP). The sanitizer below contains OUTPUT: a
// renderer answers a string, and only nodes and attributes that survive the
// walk reach the transcript — no scripts, no handlers, no non-https urls.
// A renderer that fails, stalls or answers garbage costs its card and
// nothing else: the model's own line stays visible, which is the same
// degradation an unknown marker has always had.

type Pending = { resolve: (html: string) => void };

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
const markers = new Set<string>();
const waiting = new Map<string, Pending>();
let asked = 0;

/** The sandbox, created once and kept. Hidden not because it draws — it never
 *  draws — but because an iframe is a box the layout would otherwise leave a
 *  hole for. */
function host(): Promise<void> {
  if (ready !== null) return ready;
  ready = new Promise<void>((resolve) => {
    const el = document.createElement("iframe");
    el.setAttribute("sandbox", "allow-scripts");
    el.src = "/plugin-host";
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
    const onMessage = (event: MessageEvent) => {
      // Only the frame we made. A null-origin child cannot be told apart by
      // origin, so it is told apart by source — which no other window shares.
      if (frame === null || event.source !== frame.contentWindow) return;
      const m = event.data as { kind?: string; id?: string; html?: string; markers?: string[] };
      if (m.kind === "hello") { resolve(); return; }
      if (m.kind === "loaded") {
        for (const name of m.markers ?? []) markers.add(name);
        return;
      }
      if (m.kind === "html" && typeof m.id === "string") {
        const p = waiting.get(m.id);
        if (p) { waiting.delete(m.id); p.resolve(m.html ?? ""); }
      }
    };
    window.addEventListener("message", onMessage);
    frame = el;
    document.body.appendChild(el);
  });
  return ready;
}

/** Load every enabled plugin's renderer. Called once at boot; failures are
 *  silent by design — a console whose plugins cannot load is a console whose
 *  cards degrade to text, not a console with an error bar. */
export async function loadPluginRenderers(): Promise<void> {
  let rows: { id: string; enabled: boolean; rendererSource: string }[] = [];
  try {
    const res = await fetch("/api/card-plugins", { credentials: "same-origin" });
    if (!res.ok) return;
    rows = await res.json() as typeof rows;
  } catch { return; }
  const carrying = rows.filter((r) => r.enabled && r.rendererSource !== "");
  if (carrying.length === 0) return;

  await host();
  for (const row of carrying) {
    frame?.contentWindow?.postMessage(
      { kind: "load", plugin: row.id, source: row.rendererSource }, "*");
  }
  // The loads answer asynchronously and nothing needs to block on them: a
  // render asked before its module landed answers "", and the block stays
  // text — the ordinary degradation, for the length of one page load's race.
}

export function hasPluginMarker(name: string): boolean {
  return markers.has(name);
}

/** One render, through the sandbox, with a deadline. The deadline is what
 *  makes a hostile-or-broken renderer cost one card rather than hang a
 *  transcript: the promise resolves "" and the block stays text. */
function renderInSandbox(marker: string, content: string, evidence: readonly string[]): Promise<string> {
  const id = `r${asked += 1}`;
  return new Promise<string>((resolve) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      resolve("");
    }, 1500);
    waiting.set(id, { resolve: (html) => { window.clearTimeout(timer); resolve(html); } });
    frame?.contentWindow?.postMessage({ kind: "render", id, marker, content, evidence }, "*");
  });
}

// --- output containment ------------------------------------------------------

/** Elements that never survive, whatever a renderer meant by them.
 *
 *  BUTTON was on this list and should not have been. It was added with the
 *  other form controls, on the reasoning that a card has no business
 *  collecting input — which is true of INPUT, TEXTAREA and SELECT, the three
 *  that can be dressed to look like a credential prompt. A button collects
 *  nothing. And a card's only way to OFFER an action is a button, so banning
 *  it silently deleted every control a plugin drew: the Linear card rendered
 *  its "Move to In Progress" buttons correctly, the sandbox returned them
 *  intact, and the sanitizer removed them on the way in. The card looked
 *  finished and did nothing, which is the worst shape a bug can take.
 *
 *  A button is safe here because of what is still banned around it: FORM is
 *  gone, so there is nothing to submit; `on*` and `formaction` are stripped
 *  below, so there is nothing to run. What remains is an element the console
 *  itself reads — `data-card-send`, delegated in console.ts — which is the
 *  whole interaction model: the card composes a turn, it does not act. */
const BANNED = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "STYLE", "BASE", "FORM", "INPUT", "TEXTAREA", "SELECT"]);

/** A renderer's string, reduced to what a card is allowed to be. Parsed with
 *  DOMParser — inert, nothing executes during parsing — then walked. The walk
 *  DROPS rather than escapes: a script tag inside a card is not content that
 *  needs showing, it is output the renderer was never entitled to. */
export function sanitizeCardHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (el: Element): void => {
    for (const child of [...el.children]) {
      if (BANNED.has(child.tagName)) { child.remove(); continue; }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc" || name === "formaction") {
          child.removeAttribute(attr.name);
          continue;
        }
        if ((name === "href" || name === "src" || name === "xlink:href")
            && !/^https:\/\//i.test(attr.value.trim())) {
          child.removeAttribute(attr.name);
        }
      }
      // A link that opens a tab does not get the opener with it.
      if (child.tagName === "A") {
        if (child.getAttribute("target") === "_blank") {
          child.setAttribute("rel", "noopener noreferrer");
        }
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// --- the pass ----------------------------------------------------------------

/** A token that survives the escaping pass.
 *
 *  Letters and digits only, and deliberately not markdown-active: no
 *  underscores (italics), no backticks, no brackets. What goes through the
 *  synchronous pipeline has to come out the other side character-identical,
 *  because that is the only thing this whole two-pass arrangement rests on. */
const TOKEN = (n: number) => `JOULEPLUGINCARD${n}ENDCARD`;

export type PreparedCards = {
  /** The reply with each plugin block swapped for a token. */
  text: string;
  /** Put the cards back, after the escaping pipeline has run. */
  restore(rendered: string): string;
};

/** Take the plugin blocks out, render them, and hand back a way to put them
 *  in again once the rest has been escaped.
 *
 *  Two passes and a token, rather than one pass that returns HTML — which is
 *  what this did, and it was wrong in the most visible way possible: the
 *  sanitized card was inserted into the text, then `renderWithCards` ran
 *  `escapeHtml` over the whole string, and a person reading their transcript
 *  got a wall of `<div style="margin:10px 0;padding:14px…` where a card
 *  should have been. The escaping is not the bug — it is the rule that keeps
 *  a model's words from becoming markup — so the card has to be absent while
 *  it runs and present afterwards. */
export async function preparePluginCards(raw: string, evidence: readonly string[]): Promise<PreparedCards> {
  const inert: PreparedCards = { text: raw, restore: (r) => r };
  if (markers.size === 0) return inert;

  const cards = new Map<string, string>();
  let out = "";
  let pos = 0;
  let n = 0;
  while (pos < raw.length) {
    const open = raw.indexOf("[", pos);
    if (open === -1) break;
    const shut = raw.indexOf("]", open + 1);
    if (shut === -1) break;
    const name = raw.slice(open + 1, shut);
    if (!markers.has(name)) { out += raw.slice(pos, open + 1); pos = open + 1; continue; }
    const closer = `[/${name}]`;
    const close = raw.indexOf(closer, shut + 1);
    if (close === -1) { out += raw.slice(pos, open + 1); pos = open + 1; continue; }

    const content = raw.slice(shut + 1, close).trim();
    const html = sanitizeCardHtml(await renderInSandbox(name, content, evidence));
    if (html === "") {
      // Nothing drawn: leave the block exactly as it was, and let it be shown
      // as the text it is. The same degradation an unknown marker has.
      out += raw.slice(pos, close + closer.length);
    } else {
      const token = TOKEN(n);
      n += 1;
      cards.set(token, html);
      out += raw.slice(pos, open) + token;
    }
    pos = close + closer.length;
  }
  out += raw.slice(pos);
  if (cards.size === 0) return inert;

  return {
    text: out,
    restore(rendered: string): string {
      let done = rendered;
      for (const [token, html] of cards) { done = done.split(token).join(html); }
      return done;
    },
  };
}

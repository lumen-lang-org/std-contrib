// Chat cards: tagged blocks in a reply become purpose-built HTML.
//
// LumenUI's chatbot ships a plugin contract — a plugin names its block markers
// (htmlTags) and renders what sits between them (renderHtmlBlock). The console
// cannot use the component's own pipeline for it: the transcript is driven
// through properties with pre-rendered HTML, and the raw string is escaped
// here, in chat-session, before the component ever sees it. So the same
// contract runs here instead — over the RAW reply text, before escaping — and
// every registered plugin's blocks become cards while everything between them
// takes the normal escape+markdown path. A block that fails to parse falls
// back to that path too, so a malformed payload renders as visible text, never
// as trusted markup.
//
// The registry is the extension point: registerCard() accepts anything shaped
// like the LumenUI plugin (htmlTags + renderHtmlBlock), so a future plugin
// bundle can add card types without touching this file.

export type CardPlugin = {
  id: string;
  htmlTags?: { name: string; open: string; close: string }[];
  renderHtmlBlock?(name: string, content: string): string;
};

const REGISTRY: CardPlugin[] = [];

export function registerCard(plugin: CardPlugin): void {
  if (REGISTRY.some((p) => p.id === plugin.id)) return;
  REGISTRY.push(plugin);
}

export function registeredCards(): readonly CardPlugin[] {
  return REGISTRY;
}

/** The briefing line for each registered tag — what a prompt or skill tells
 *  the model to emit. Kept beside the registry so the two cannot drift. */
export function cardTagsBriefing(): string {
  const tags: string[] = [];
  for (const p of REGISTRY) {
    for (const t of p.htmlTags ?? []) tags.push(`${t.open}{…json…}${t.close}`);
  }
  return tags.join(", ");
}

/**
 * Render a raw reply: registered card blocks become the plugin's HTML, and
 * every segment between them goes through `renderText` (the caller's
 * escape+markdown). indexOf walk, no RegExp — house style, and an unclosed
 * tag simply stays visible text.
 */
export function renderWithCards(raw: string, renderText: (segment: string) => string): string {
  type Hit = { open: number; contentStart: number; contentEnd: number; end: number; plugin: CardPlugin; name: string };

  let out = "";
  let pos = 0;
  while (pos < raw.length) {
    // The earliest block any plugin claims, scanning from pos.
    let best: Hit | null = null;
    for (const plugin of REGISTRY) {
      if (typeof plugin.renderHtmlBlock !== "function") continue;
      for (const tag of plugin.htmlTags ?? []) {
        const open = raw.indexOf(tag.open, pos);
        if (open === -1) continue;
        const contentStart = open + tag.open.length;
        const close = raw.indexOf(tag.close, contentStart);
        if (close === -1) continue;
        if (best === null || open < best.open) {
          best = { open, contentStart, contentEnd: close, end: close + tag.close.length, plugin, name: tag.name };
        }
      }
    }
    if (best === null) {
      out += renderText(raw.slice(pos));
      break;
    }
    if (best.open > pos) out += renderText(raw.slice(pos, best.open));
    const content = raw.slice(best.contentStart, best.contentEnd);
    let html = "";
    try {
      html = best.plugin.renderHtmlBlock!(best.name, content) ?? "";
    } catch {
      html = "";
    }
    // An empty render means the plugin refused the payload: show the whole
    // block as ordinary text rather than silently dropping what the model said.
    out += html !== "" ? html : renderText(raw.slice(best.open, best.end));
    pos = best.end;
  }
  return out;
}

// --- the currency card -------------------------------------------------------

type CurrencyData = {
  from: string; to: string; rate: number;
  amount?: number; converted?: number; asOf?: string; source?: string;
  // Optional rate history — one number per day, oldest first, with a label
  // each. Present, the card draws an interactive <nr-sparkline> under the
  // numbers; absent, the card is the numbers alone.
  history?: number[]; historyLabels?: string[];
};

function esc(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else out += ch;
  }
  return out;
}

const money = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** [CURRENCY]{"from":"USD","to":"EUR","rate":0.9174,"amount":250,"converted":229.35,"asOf":"2026-08-02","source":"ECB"}[/CURRENCY] */
export const currencyCard: CardPlugin = {
  id: "currency-card",
  htmlTags: [{ name: "currency", open: "[CURRENCY]", close: "[/CURRENCY]" }],
  renderHtmlBlock(name: string, content: string): string {
    if (name !== "currency") return "";
    let d: CurrencyData;
    try { d = JSON.parse(content) as CurrencyData; } catch { return ""; }
    if (typeof d.rate !== "number" || !isFinite(d.rate) || !d.from || !d.to) return "";
    const from = esc(String(d.from).toUpperCase().slice(0, 8));
    const to = esc(String(d.to).toUpperCase().slice(0, 8));
    const hasAmount = typeof d.amount === "number" && isFinite(d.amount!)
      && typeof d.converted === "number" && isFinite(d.converted!);
    const hero = hasAmount
      ? `${money(d.amount!)} ${from} = <b>${money(d.converted!)} ${to}</b>`
      : `1 ${from} = <b>${money(d.rate)} ${to}</b>`;
    const meta: string[] = [`1 ${from} = ${money(d.rate)} ${to}`];
    if (d.asOf) meta.push(esc(String(d.asOf).slice(0, 32)));
    if (d.source) meta.push(esc(String(d.source).slice(0, 48)));
    // Inline styles: the string lands inside the chatbot's shadow root, where
    // the console stylesheet does not reach. Custom properties do cross the
    // boundary, so colors lean on the theme's vars with plain fallbacks.
    // The chart, when the payload carries a history. The element parses its
    // own attributes (Lit's JSON converter), so the numbers are re-serialized
    // from the parsed floats — nothing model-written lands in the attribute —
    // and the labels are escaped like every other string here.
    let spark = "";
    const hist = (d.history ?? []).filter((n) => typeof n === "number" && isFinite(n)).slice(0, 120);
    if (hist.length >= 2) {
      // Sliced only: the attribute as a whole is escaped below, and the element
      // renders labels as Lit text, which cannot become markup.
      const labels = (d.historyLabels ?? []).slice(0, hist.length).map((l) => String(l).slice(0, 24));
      spark = `<nr-sparkline style="margin-top:10px" points="${JSON.stringify(hist)}"`
        + ` labels="${esc(JSON.stringify(labels))}" unit="${to}"></nr-sparkline>`;
    }
    return `<div style="margin:10px 0;padding:14px 16px;border:1px solid var(--nuraly-border-color,rgba(128,128,128,.25));border-radius:12px;max-width:420px;font-family:inherit">`
      + `<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6;margin-bottom:6px">Currency conversion</div>`
      + `<div style="font-size:19px;line-height:1.3">${hero}</div>`
      + `<div style="font-size:12px;opacity:.65;margin-top:6px">${meta.join(" · ")}</div>`
      + spark
      + `</div>`;
  },
};

registerCard(currencyCard);

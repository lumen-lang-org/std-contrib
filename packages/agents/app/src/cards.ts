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

/** What the tools in this turn printed — the card's second source.
 *
 *  A block is what the MODEL said; evidence is what a TOOL returned. The
 *  difference decides which one a number should come from: the currency
 *  script fetched a 10-point history on every run measured, and the model
 *  copied it into its block on none of them — six pairs, six empty charts.
 *  A model is being asked to transcribe fourteen numbers through prose, and
 *  it will not do it reliably at any size worth running locally.
 *
 *  So the model's job shrinks to naming the card and its few short strings,
 *  and anything long or numeric is read back out of the tool result it came
 *  from. Nothing here is trusted as markup: it is parsed as JSON, and only
 *  numbers and short strings are taken. */
export type CardEvidence = readonly string[];

export type CardPlugin = {
  id: string;
  htmlTags?: { name: string; open: string; close: string }[];
  renderHtmlBlock?(name: string, content: string, evidence?: CardEvidence): string;
  /** Whether this plugin claims a block whose marker is NOT one of its own —
   *  judged from the parsed payload alone. See `renderWithCards`. */
  claimsShape?(data: Record<string, unknown>): boolean;
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
export function renderWithCards(raw: string, renderText: (segment: string) => string,
                                evidence: CardEvidence = []): string {
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
      // Nothing registered matched. A weak model reliably writes the marker it
      // is thinking about rather than the one it was given — [TND]…[/TND] for
      // a Tunisian dinar, [EUR] for a euro — and the payload inside is exactly
      // right. The engine already takes this view of a skill called by its own
      // name (tools.ts): the intent is not ambiguous, so refusing it is
      // pedantry that costs the whole card. So one more pass, claiming a
      // bracketed block by the SHAPE of its JSON rather than by its name.
      const strayed = strayBlock(raw, pos, evidence)
        // Third pass, anchored on the CLOSING marker. Observed: the model
        // wrote the closer correctly and replaced the opener with a bare
        // currency code — `USD{…}[/CURRENCY]` — so neither the exact match
        // nor the paired stray block claims it, and a card that was one
        // character from correct rendered as JSON in the reader's face.
        ?? closedBlock(raw, pos, evidence);
      if (strayed !== null) {
        if (strayed.open > pos) out += renderText(raw.slice(pos, strayed.open));
        out += strayed.html;
        pos = strayed.end;
        continue;
      }
      out += renderText(raw.slice(pos));
      break;
    }
    if (best.open > pos) out += renderText(raw.slice(pos, best.open));
    const content = raw.slice(best.contentStart, best.contentEnd);
    let html = "";
    try {
      html = best.plugin.renderHtmlBlock!(best.name, content, evidence) ?? "";
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


/** A `[WORD]{…json…}[/WORD]` block whose payload a plugin claims by shape, or
 *  null. The marker is only accepted as a pair — an opening [X] with the
 *  matching [/X] — so ordinary bracketed prose is never mistaken for one. */
function strayBlock(raw: string, from: number, evidence: CardEvidence):
  { open: number; end: number; html: string } | null {
  let at = from;
  while (at < raw.length) {
    const open = raw.indexOf("[", at);
    if (open === -1) return null;
    const shut = raw.indexOf("]", open + 1);
    if (shut === -1) return null;
    const name = raw.slice(open + 1, shut);
    // A marker is a short word: letters, digits, dash or underscore. Anything
    // else is a sentence that happens to contain a bracket.
    const plain = name !== "" && name.length <= 16
      && [...name].every((c) => /[A-Za-z0-9_-]/.test(c));
    if (!plain) { at = open + 1; continue; }
    const closer = `[/${name}]`;
    const close = raw.indexOf(closer, shut + 1);
    if (close === -1) { at = open + 1; continue; }
    const body = raw.slice(shut + 1, close).trim();
    let data: Record<string, unknown> | null = null;
    try { data = JSON.parse(body) as Record<string, unknown>; } catch { data = null; }
    if (data !== null) {
      for (const plugin of REGISTRY) {
        if (typeof plugin.claimsShape !== "function") continue;
        if (typeof plugin.renderHtmlBlock !== "function") continue;
        if (!plugin.claimsShape(data)) continue;
        const tag = (plugin.htmlTags ?? [])[0];
        let html = "";
        try { html = plugin.renderHtmlBlock(tag ? tag.name : name, body, evidence) ?? ""; } catch { html = ""; }
        if (html !== "") return { open, end: close + closer.length, html };
      }
    }
    at = open + 1;
  }
  return null;
}

/** A block whose CLOSING marker is a registered one, whatever its opener.
 *
 *  The payload is what decides it, exactly as in `strayBlock`: the JSON
 *  immediately before a known closer, claimed only if a plugin recognises
 *  its shape. Whatever the model put where the opening marker belonged —
 *  `USD`, `[USD]`, nothing at all — is swallowed with the block rather than
 *  left as a word stranded above the card. */
function closedBlock(raw: string, from: number, evidence: CardEvidence):
  { open: number; end: number; html: string } | null {
  for (const plugin of REGISTRY) {
    if (typeof plugin.claimsShape !== "function") continue;
    if (typeof plugin.renderHtmlBlock !== "function") continue;
    for (const tag of plugin.htmlTags ?? []) {
      const close = raw.indexOf(tag.close, from);
      if (close === -1) continue;
      // The JSON ends at the closer; it starts at the last brace before it
      // that parses. Scanning back from the first brace after `from` keeps
      // this linear in the reply rather than quadratic.
      const first = raw.indexOf("{", from);
      if (first === -1 || first > close) continue;
      let at = first;
      while (at !== -1 && at < close) {
        const body = raw.slice(at, close).trim();
        let data: Record<string, unknown> | null = null;
        try { data = JSON.parse(body) as Record<string, unknown>; } catch { data = null; }
        if (data !== null && plugin.claimsShape(data)) {
          let html = "";
          try { html = plugin.renderHtmlBlock(tag.name, body, evidence) ?? ""; } catch { html = ""; }
          if (html !== "") {
            // Back over a mangled opener: an optional "]", a short word, an
            // optional "[". Bounded, so ordinary prose before the card is
            // never eaten.
            let open = at;
            if (open > from && raw[open - 1] === "]") open -= 1;
            let word = 0;
            while (open > from && word < 16 && /[A-Za-z0-9_-]/.test(raw[open - 1])) { open -= 1; word += 1; }
            if (open > from && raw[open - 1] === "[") open -= 1;
            return { open, end: close + tag.close.length, html };
          }
        }
        at = raw.indexOf("{", at + 1);
      }
    }
  }
  return null;
}

/** A rate history out of what a tool printed this turn, or null.
 *
 *  The scripts print one JSON object on a line of their own, so this looks
 *  for exactly that and never tries to parse prose. Only two members are
 *  read, and only numbers and short strings survive — a tool result is not
 *  markup and is never treated as any. */
function historyFromEvidence(evidence: CardEvidence):
  { history: number[]; labels: string[] } | null {
  for (const text of evidence) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("{") || !line.endsWith("}")) continue;
      let data: Record<string, unknown>;
      try { data = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const points = data.history;
      if (!Array.isArray(points)) continue;
      const history = points.filter((n): n is number => typeof n === "number" && isFinite(n));
      if (history.length < 2) continue;
      const named = Array.isArray(data.historyLabels) ? data.historyLabels : [];
      const labels = named.map((l) => String(l).slice(0, 24));
      return { history, labels };
    }
  }
  return null;
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
  claimsShape(d: Record<string, unknown>): boolean {
    return typeof d.rate === "number" && typeof d.from === "string" && typeof d.to === "string";
  },
  renderHtmlBlock(name: string, content: string, evidence: CardEvidence = []): string {
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
    // The model's copy first, the script's output when it has none — which
    // is every measured run. See CardEvidence.
    let series = d.history ?? [];
    let seriesLabels = d.historyLabels ?? [];
    if (series.length < 2) {
      const found = historyFromEvidence(evidence);
      if (found !== null) { series = found.history; seriesLabels = found.labels; }
    }
    const hist = series.filter((n) => typeof n === "number" && isFinite(n)).slice(0, 120);
    if (hist.length >= 2) {
      // Sliced only: the attribute as a whole is escaped below, and the element
      // renders labels as Lit text, which cannot become markup.
      const labels = seriesLabels.slice(0, hist.length).map((l) => String(l).slice(0, 24));
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

// --- a passage worth keeping ---------------------------------------------------
//
// The answer to "correct this", "translate this", "write the email" is not
// prose about a result — it IS the result, and the next thing anybody does
// with it is select it and copy it. Rendering it as another paragraph makes
// them drag across exactly the right characters, which is the one interaction
// a chat surface can most easily get wrong: too little and the quote marks
// come along, too much and the model's preamble does.
//
// So it gets a card. Bordered, in the reading face, with the text and nothing
// else inside it — and a Copy button that takes precisely the text.

type TextData = {
  // The passage itself. The only required field.
  body?: string;
  // What it is: "Corrected", "Translation", "Draft email". Short, and shown
  // as the card's eyebrow. Optional — an untitled card is still useful.
  title?: string;
  // A language tag, drawn beside the title when the model says. Useful on a
  // translation and meaningless everywhere else, hence optional.
  lang?: string;
};

/** [TEXT]{"title":"Corrected","body":"Bonjour, comment ça va ?"}[/TEXT] */
export const textCard: CardPlugin = {
  id: "text-card",
  htmlTags: [{ name: "text", open: "[TEXT]", close: "[/TEXT]" }],
  claimsShape(d: Record<string, unknown>): boolean {
    // A body and nothing numeric: this is the shape a currency card is not.
    return typeof d.body === "string" && d.body.trim() !== ""
      && typeof (d as { rate?: unknown }).rate !== "number";
  },
  renderHtmlBlock(name: string, content: string, _evidence: CardEvidence = []): string {
    if (name !== "text") return "";
    let d: TextData;
    try { d = JSON.parse(content) as TextData; } catch { return ""; }
    const body = typeof d.body === "string" ? d.body : "";
    if (body.trim() === "") return "";

    const title = typeof d.title === "string" && d.title.trim() !== ""
      ? esc(d.title.slice(0, 48)) : "";
    const lang = typeof d.lang === "string" && d.lang.trim() !== ""
      ? esc(d.lang.slice(0, 16)) : "";
    const eyebrow = [title, lang].filter((x) => x !== "").join(" · ");

    // The text twice, deliberately: once escaped for display, once escaped
    // into an attribute for the button to hand the clipboard. Reading it back
    // off the DOM instead would give whatever the browser's text extraction
    // produced — line breaks collapsed, entities resolved differently — and
    // the point of the button is that it copies exactly the passage.
    const shown = esc(body).replace(/\n/g, "<br>");
    const held = esc(body);

    // Inline styles: this string lands inside the chatbot's shadow root, where
    // the console's stylesheet does not reach. Custom properties do cross, so
    // the colours lean on the theme with plain fallbacks.
    const border = "var(--nuraly-border-color,rgba(128,128,128,.25))";
    return `<div style="margin:10px 0;border:1px solid ${border};border-radius:12px;`
      + `max-width:640px;font-family:inherit;overflow:hidden">`
      + `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;`
      + `border-bottom:1px solid ${border}">`
      + `<span style="flex:1;min-width:0;font-size:11px;letter-spacing:.06em;`
      + `text-transform:uppercase;opacity:.6">${eyebrow === "" ? "Text" : eyebrow}</span>`
      // data-copy-card is what the console's delegated listener looks for. A
      // click inside a shadow root still reaches it: the event is composed, so
      // composedPath() carries this button out to the listener.
      + `<button type="button" data-copy-card="${held}" `
      + `style="display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;`
      + `padding:4px 10px;border-radius:999px;cursor:pointer;background:none;`
      + `color:inherit;border:1px solid ${border}">Copy</button>`
      + `</div>`
      + `<div style="padding:12px 14px;font-size:15px;line-height:1.6;`
      + `white-space:pre-wrap;word-break:break-word">${shown}</div>`
      + `</div>`;
  },
};

registerCard(textCard);

// --- Linear, drawn instead of restated -----------------------------------------
//
// A cycle is four numbers and a date range; a ticket list is rows with a
// state each. Both came back as markdown bullet soup — accurate, and unread.
// The same division of labour as the currency card: the MODEL emits one line
// naming the card and the team or title, and every number, identifier, url
// and status is read from the tool result it came from, because a model
// transcribing fourteen fields through prose drops some of them at any size
// worth running (see CardEvidence).
//
// The engine tells the model about these markers on the result of the very
// call that produced the data (run.ts) — the same recency trick as the
// find_tools recovery hint, and it costs tokens only when a Linear list
// actually ran.

/** A tool result, parsed even when the engine appended prose after the JSON —
 *  which it does: briefing hints ride the result's tail. The JSON is the
 *  prefix, so the parse walks back from the end to the last brace and tries
 *  the longest prefix first. */
function parseLoose(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* appended prose, or not JSON */ }
  const from = t.search(/[[{]/);
  if (from === -1) return null;
  for (let end = t.length; end > from; end -= 1) {
    const ch = t[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try { return JSON.parse(t.slice(from, end)); } catch { /* keep walking */ }
  }
  return null;
}

type LinearCycle = {
  number?: number; name?: string; startsAt?: string; endsAt?: string;
  isCurrent?: boolean;
  issueCountHistory?: number[]; completedIssueCountHistory?: number[];
  scopeHistory?: number[]; completedScopeHistory?: number[];
};

type LinearIssue = {
  id?: string; title?: string; url?: string; status?: string;
  statusType?: string; dueDate?: string | null;
  priority?: { value?: number; name?: string };
};

/** The cycles in evidence: list_cycles answers a bare array of them. */
function cyclesFromEvidence(evidence: CardEvidence): LinearCycle[] {
  for (const text of evidence) {
    const data = parseLoose(text);
    if (Array.isArray(data) && data.length > 0
        && typeof (data[0] as LinearCycle).number === "number"
        && typeof (data[0] as LinearCycle).startsAt === "string") {
      return data as LinearCycle[];
    }
  }
  return [];
}

/** The issues in evidence: list_issues answers { issues: [...] }. */
function issuesFromEvidence(evidence: CardEvidence): LinearIssue[] {
  for (const text of evidence) {
    const data = parseLoose(text) as { issues?: unknown } | null;
    if (data !== null && Array.isArray(data.issues) && data.issues.length > 0
        && typeof (data.issues[0] as LinearIssue).title === "string") {
      return data.issues as LinearIssue[];
    }
  }
  return [];
}

const last = (ns: number[] | undefined): number =>
  Array.isArray(ns) && ns.length > 0 && isFinite(ns[ns.length - 1]) ? ns[ns.length - 1] : 0;

const day = (iso: string | undefined): string => {
  if (typeof iso !== "string" || iso === "") return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** The state chip's ink, by Linear's own statusType vocabulary. */
function stateInk(statusType: string): { ink: string; bg: string } {
  if (statusType === "completed") return { ink: "#2f8a4c", bg: "rgba(47,138,76,.12)" };
  if (statusType === "started") return { ink: "#b7791f", bg: "rgba(183,121,31,.12)" };
  if (statusType === "canceled") return { ink: "#8a8f98", bg: "rgba(138,143,152,.12)" };
  return { ink: "#6b7280", bg: "rgba(107,114,128,.12)" }; // backlog, unstarted
}

const CARD_BORDER = "var(--nuraly-border-color,rgba(128,128,128,.25))";

/** [LINEAR_CYCLE]{"team":"Aymen"}[/LINEAR_CYCLE] — data from evidence. */
export const linearCycleCard: CardPlugin = {
  id: "linear-cycle-card",
  htmlTags: [{ name: "linear-cycle", open: "[LINEAR_CYCLE]", close: "[/LINEAR_CYCLE]" }],
  claimsShape(d: Record<string, unknown>): boolean {
    return d.kind === "cycle" || (typeof d.team === "string" && !("title" in d) && !("body" in d));
  },
  renderHtmlBlock(name: string, content: string, evidence: CardEvidence = []): string {
    if (name !== "linear-cycle") return "";
    let d: { team?: string };
    try { d = JSON.parse(content) as { team?: string }; } catch { return ""; }
    const cycles = cyclesFromEvidence(evidence);
    // The current one, or the newest — the card is "where are we", not an
    // archive browser.
    const cycle = cycles.find((c) => c.isCurrent === true) ?? cycles[cycles.length - 1];
    if (!cycle) return "";

    const team = typeof d.team === "string" && d.team.trim() !== ""
      ? esc(d.team.slice(0, 48)) : "";
    const title = cycle.name && cycle.name.trim() !== ""
      ? esc(String(cycle.name).slice(0, 64)) : `Cycle ${cycle.number ?? "?"}`;
    const span = [day(cycle.startsAt), day(cycle.endsAt)].filter((s) => s !== "").join(" – ");
    const scope = last(cycle.scopeHistory) || last(cycle.issueCountHistory);
    const done = last(cycle.completedScopeHistory) || last(cycle.completedIssueCountHistory);
    const issues = last(cycle.issueCountHistory);
    const doneIssues = last(cycle.completedIssueCountHistory);
    const pct = scope > 0 ? Math.round((done / scope) * 100) : 0;

    return `<div data-linear-card="cycle" style="margin:10px 0;padding:14px 16px;border:1px solid ${CARD_BORDER};border-radius:12px;max-width:440px;font-family:inherit">`
      + `<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">`
      + `<span style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">Linear${team === "" ? "" : " · " + team}</span>`
      + (cycle.isCurrent === true ? `<span style="font-size:10.5px;font-weight:600;color:#2f8a4c;border:1px solid rgba(47,138,76,.4);border-radius:999px;padding:0 7px">current</span>` : "")
      + `</div>`
      + `<div style="font-size:18px;font-weight:600;line-height:1.3">${title}</div>`
      + (span === "" ? "" : `<div style="font-size:12.5px;opacity:.65;margin-top:2px">${span}</div>`)
      + `<div style="margin-top:10px;height:6px;border-radius:999px;background:rgba(128,128,128,.15);overflow:hidden">`
      + `<div style="height:100%;width:${pct}%;border-radius:999px;background:#2f8a4c"></div></div>`
      + `<div style="font-size:12.5px;opacity:.75;margin-top:6px">${doneIssues} of ${issues} issues done · ${pct}% of scope</div>`
      + `</div>`;
  },
};

registerCard(linearCycleCard);

/** [LINEAR_ISSUES]{"title":"This cycle"}[/LINEAR_ISSUES] — rows from evidence.
 *  Each row is a link to the issue in Linear, which is the interactivity that
 *  matters: the next thing anybody does with a ticket list is open one. */
export const linearIssuesCard: CardPlugin = {
  id: "linear-issues-card",
  htmlTags: [{ name: "linear-issues", open: "[LINEAR_ISSUES]", close: "[/LINEAR_ISSUES]" }],
  claimsShape(d: Record<string, unknown>): boolean {
    return d.kind === "issues";
  },
  renderHtmlBlock(name: string, content: string, evidence: CardEvidence = []): string {
    if (name !== "linear-issues") return "";
    let d: { title?: string };
    try { d = JSON.parse(content) as { title?: string }; } catch { return ""; }
    const all = issuesFromEvidence(evidence);
    if (all.length === 0) return "";
    const shown = all.slice(0, 10);

    const rows = shown.map((issue) => {
      const key = esc(String(issue.id ?? "").slice(0, 16));
      const title = esc(String(issue.title ?? "").slice(0, 120));
      const st = String(issue.statusType ?? "");
      const chip = stateInk(st);
      const status = esc(String(issue.status ?? "").slice(0, 24));
      const pr = issue.priority && typeof issue.priority.value === "number"
        && issue.priority.value > 0
        ? `<span style="font-size:11px;opacity:.55;flex:none">${esc(String(issue.priority.name ?? "").slice(0, 12))}</span>` : "";
      const due = typeof issue.dueDate === "string" && issue.dueDate !== ""
        ? `<span style="font-size:11px;opacity:.55;flex:none">due ${esc(day(issue.dueDate))}</span>` : "";
      // The url is only trusted as a link when it is Linear's own host —
      // evidence is tool output, and a link in a card should never be able to
      // point a reader somewhere a tool result invented.
      const url = String(issue.url ?? "");
      const safe = /^https:\/\/linear\.app\//.test(url) ? esc(url) : "";
      const open = safe === "" ? "<div" : `<a href="${safe}" target="_blank" rel="noopener noreferrer"`;
      const shut = safe === "" ? "</div>" : "</a>";
      const struck = st === "canceled" ? "text-decoration:line-through;opacity:.6;" : "";
      return `${open} style="display:flex;align-items:center;gap:10px;padding:8px 12px;`
        + `border-top:1px solid ${CARD_BORDER};color:inherit;text-decoration:none;cursor:${safe === "" ? "default" : "pointer"}">`
        + `<span style="font:600 11.5px ui-monospace,monospace;opacity:.55;flex:none">${key}</span>`
        + `<span style="flex:1;min-width:0;font-size:13.5px;${struck}overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>`
        + pr + due
        + `<span style="flex:none;font-size:11px;font-weight:600;color:${chip.ink};background:${chip.bg};border-radius:999px;padding:2px 9px">${status}</span>`
        + `${shut}`;
    }).join("");

    const title = typeof d.title === "string" && d.title.trim() !== ""
      ? esc(d.title.slice(0, 64)) : "Issues";
    const more = all.length > shown.length
      ? `<div style="padding:7px 12px;border-top:1px solid ${CARD_BORDER};font-size:12px;opacity:.6">and ${all.length - shown.length} more</div>` : "";

    return `<div data-linear-card="issues" style="margin:10px 0;border:1px solid ${CARD_BORDER};border-radius:12px;max-width:640px;font-family:inherit;overflow:hidden">`
      + `<div style="display:flex;align-items:center;gap:8px;padding:9px 12px">`
      + `<span style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">Linear · ${title}</span>`
      + `<span style="flex:1"></span>`
      + `<span style="font-size:11.5px;opacity:.55">${all.length} issue${all.length === 1 ? "" : "s"}</span>`
      + `</div>${rows}${more}</div>`;
  },
};

registerCard(linearIssuesCard);

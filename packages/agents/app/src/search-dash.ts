// The search index, as a screen.
//
// Three views of one API: what the corpus is (stats), what a query gets back
// (search), and what a retrieval call would hand a model (RAG). The first is
// public — it is a paragraph about a web index rendered as numbers, and giving
// a visitor a sense of the thing is the point. The other two are an operator's
// and the server refuses them to anybody else (server/search-proxy.ts).
//
// Everything here is read-only and everything goes through `/search-api`,
// never at the index directly: the index answers on a tailnet with no auth,
// and a browser that could reach it is a browser that could reach all of it.
// The one consequence for this file is that there is no host to configure and
// no CORS to think about — same origin, always.
//
// The numbers are the API's own. Nothing is derived here except the two ratios
// the brief asks for (compression, classified share), and both are computed
// from fields in the same response so they cannot disagree with what is drawn
// beside them.

import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./ui.js";

interface Bucket { key: string; n: number }

interface Stats {
  docs: number; indexed: number; pending: number; excluded: number;
  classified: number; corpus_bytes: number; markdown_bytes_raw: number;
  domains: number; newest_fetch: number; oldest_fetch: number;
  inbox_pending?: number;
}

interface Analytics {
  by_lang: Bucket[]; by_country: Bucket[]; by_category: Bucket[];
  by_domain: Bucket[]; by_tier: Bucket[]; rejects: Bucket[];
  ingest_by_hour: Bucket[];
}

interface Result {
  url: string; title: string; snippet: string; score: number;
  lang: string; country: string; category: string;
  fetched_at: string; source: string;
}

interface Passage {
  url: string; title: string; domain: string; hash: string;
  score: number; fetched_at: string; text: string;
}

interface Suggestion { text: string; source: string }

/** Bytes as a person reads them. Binary units because the number came off a
 *  disk; one decimal because the point is the magnitude. */
function size(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function count(n: number): string {
  return isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/** Unix seconds to something readable, in the reader's own zone. */
function when(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** How long ago, in the one unit that fits. Stats are polled, so this is the
 *  field that tells a reader the page is alive. */
function ago(seconds: number): string {
  if (!seconds) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The API's empty string is a fact — enrichment has not reached the document
 *  — and the brief is explicit that it is never to be drawn as missing data. */
function named(key: string, kind: "country" | "category" | "lang"): string {
  if (key !== "" && key !== "unknown" && key !== "unclassified") return key;
  return kind === "category" ? "unclassified" : "unknown";
}

const TIERS: Record<string, string> = { "0": "news", "1": "docs / reference", "2": "evergreen" };

/** A snippet carries markdown bold around the matched terms. Split rather than
 *  parse, and emit Lit nodes rather than markup: the strings are page titles
 *  and page text off the open web, so nothing here may become HTML. */
function bolded(snippet: string): TemplateResult {
  const parts = snippet.split("**");
  return html`${parts.map((part, i) =>
    i % 2 === 1 ? html`<b>${part}</b>` : html`${part}`)}`;
}

/** How old the answer was, in seconds, when the proxy served it from a cache
 *  the index could no longer refresh. 0 means live. Read off the last call —
 *  the two aggregate calls are made together and share a fate. */
let staleFor = 0;

async function ask<T>(path: string): Promise<T> {
  const answer = await fetch("/search-api" + path, { headers: { accept: "application/json" } });
  const aged = answer.headers.get("x-index-stale");
  staleFor = aged === null ? 0 : Number(aged) || 0;
  const body = (await answer.json()) as T & { error?: string; detail?: string };
  if (!answer.ok) {
    throw new Error(body?.error ? `${body.error}${body.detail ? ` (${body.detail})` : ""}`
      : `the index answered ${answer.status}`);
  }
  return body;
}

@customElement("search-dash")
export class SearchDash extends LitElement {
  /** "public" draws the corpus and nothing else. The server enforces the same
   *  split, so this is a matter of what to show rather than what to allow. */
  @property({ type: String, reflect: true }) mode: "admin" | "public" = "admin";

  @state() private view: "stats" | "search" | "rag" = "stats";
  @state() private stats: Stats | null = null;
  @state() private analytics: Analytics | null = null;
  @state() private trouble = "";
  @state() private loading = true;

  // The search playground.
  @state() private q = "";
  @state() private filters: Record<string, string> = { lang: "", country: "", category: "", site: "" };
  @state() private k = 10;
  @state() private results: Result[] | null = null;
  @state() private took = 0;
  @state() private searching = false;
  @state() private suggestions: Suggestion[] = [];
  @state() private opened = "";
  @state() private doc: { markdown?: string; title?: string; url?: string } | null = null;

  // The RAG playground.
  @state() private rq = "";
  @state() private rk = 5;
  @state() private maxChars = 24000;
  @state() private passages: Passage[] | null = null;
  @state() private rtook = 0;
  @state() private retrieving = false;
  @state() private copied = false;

  private timer = 0;
  private typing = 0;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    // The corpus is actively growing, so the numbers are a live reading rather
    // than a report. The proxy caches for 20s, which means a 30s poll costs
    // the index at most one request per window however many people are here.
    this.timer = window.setInterval(() => { void this.refresh(true); }, 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
    window.clearTimeout(this.typing);
  }

  private async refresh(quiet = false): Promise<void> {
    if (!quiet) this.loading = true;
    try {
      const [stats, analytics] = await Promise.all([
        ask<Stats>("/stats"),
        ask<Analytics>("/analytics"),
      ]);
      this.stats = stats;
      this.analytics = analytics;
      // Not an error — the numbers are real, they are just not current, and
      // saying so is the difference between stale data and wrong data.
      this.trouble = staleFor > 0
        ? `The index is not answering. These numbers are ${ago(Math.floor(Date.now() / 1000) - staleFor)}.`
        : "";
    } catch (err) {
      // A quiet poll that fails leaves the last good numbers on screen and
      // says so in the header. Blanking a working page because one poll missed
      // is worse than a slightly stale figure.
      this.trouble = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private query(): string {
    const p = new URLSearchParams();
    for (const [name, value] of Object.entries(this.filters)) {
      if (value !== "") p.append(name, value);
    }
    return p.toString();
  }

  private async search(): Promise<void> {
    const q = this.q.trim();
    if (q === "") return;
    this.searching = true;
    this.suggestions = [];
    try {
      const extra = this.query();
      const answer = await ask<{ results: Result[]; took_ms: number }>(
        `/search?q=${encodeURIComponent(q)}&k=${this.k}${extra ? "&" + extra : ""}`);
      this.results = answer.results ?? [];
      this.took = answer.took_ms ?? 0;
      this.trouble = "";
    } catch (err) {
      this.trouble = err instanceof Error ? err.message : String(err);
      this.results = null;
    } finally {
      this.searching = false;
    }
  }

  /** Autocomplete is sub-5ms and safe on every keystroke, but a keystroke is
   *  not a question — a short debounce keeps a fast typist from queuing eight
   *  answers to see the last. */
  private suggest(text: string): void {
    this.q = text;
    window.clearTimeout(this.typing);
    if (text.trim().length < 2) { this.suggestions = []; return; }
    this.typing = window.setTimeout(() => {
      void ask<{ suggestions: Suggestion[] }>(`/suggest?q=${encodeURIComponent(text.trim())}&k=8`)
        .then((a) => { this.suggestions = a.suggestions ?? []; })
        .catch(() => { this.suggestions = []; });
    }, 120);
  }

  private async retrieve(): Promise<void> {
    const q = this.rq.trim();
    if (q === "") return;
    this.retrieving = true;
    try {
      const extra = this.query();
      const answer = await ask<{ passages: Passage[]; took_ms: number }>(
        `/retrieve?q=${encodeURIComponent(q)}&k=${this.rk}&max_chars=${this.maxChars}`
        + (extra ? "&" + extra : ""));
      this.passages = answer.passages ?? [];
      this.rtook = answer.took_ms ?? 0;
      this.trouble = "";
    } catch (err) {
      this.trouble = err instanceof Error ? err.message : String(err);
      this.passages = null;
    } finally {
      this.retrieving = false;
    }
  }

  private async open(hash: string): Promise<void> {
    if (this.opened === hash) { this.opened = ""; this.doc = null; return; }
    this.opened = hash;
    this.doc = null;
    try { this.doc = await ask(`/doc/${hash}`); }
    catch (err) { this.doc = { markdown: err instanceof Error ? err.message : String(err) }; }
  }

  private assembled(): string {
    return (this.passages ?? [])
      .map((p) => `# ${p.title}\n${p.url}\n\n${p.text}`)
      .join("\n\n---\n\n");
  }

  // --- pieces ---------------------------------------------------------------

  /** One headline number. The note under it is the second fact that makes the
   *  first one mean something — a count with no denominator is trivia. */
  private figure(label: string, value: string, note = ""): TemplateResult {
    return html`
      <div class="fig">
        <div class="fig-label">${label}</div>
        <div class="fig-value">${value}</div>
        ${note === "" ? nothing : html`<div class="fig-note">${note}</div>`}
      </div>`;
  }

  /** A ranked distribution. Bars rather than a pie: these are ordered counts
   *  with a long tail, and length is the one encoding a reader can compare
   *  across rows without a legend. */
  private bars(
    title: string, buckets: Bucket[] | undefined, limit: number,
    label: (key: string) => string = (k) => k,
  ): TemplateResult {
    const rows = (buckets ?? []).slice(0, limit);
    const top = rows.length > 0 ? Math.max(...rows.map((r) => r.n), 1) : 1;
    const all = (buckets ?? []).reduce((sum, r) => sum + r.n, 0);
    return html`
      <section class="panel">
        <header class="panel-head">
          <h3>${title}</h3>
          ${(buckets ?? []).length > limit
            ? html`<span class="of">top ${limit} of ${(buckets ?? []).length}</span>` : nothing}
        </header>
        ${rows.length === 0
          ? html`<p class="empty">Nothing here yet.</p>`
          : html`<div class="bars">
              ${rows.map((r) => html`
                <div class="bar-row">
                  <span class="bar-key" title=${label(r.key)}>${label(r.key)}</span>
                  <span class="bar-track">
                    <span class="bar-fill" style="width:${Math.max(1.5, (r.n / top) * 100)}%"></span>
                  </span>
                  <span class="bar-n">${count(r.n)}</span>
                  <span class="bar-pc">${all > 0 ? `${((r.n / all) * 100).toFixed(1)}%` : ""}</span>
                </div>`)}
            </div>`}
      </section>`;
  }

  private ingest(): TemplateResult {
    // Newest-first out of the API, which is the wrong order for a time axis.
    const series = [...(this.analytics?.ingest_by_hour ?? [])].reverse();
    const points = series.map((b) => b.n);
    const labels = series.map((b) => b.key.slice(5).replace("T", " "));
    const total = points.reduce((s, n) => s + n, 0);
    return html`
      <section class="panel wide">
        <header class="panel-head">
          <h3>Documents ingested per hour</h3>
          <span class="of">${count(total)} over ${points.length} hours</span>
        </header>
        ${points.length < 2
          ? html`<p class="empty">Not enough hours recorded yet.</p>`
          : html`<nr-sparkline
              points=${JSON.stringify(points)}
              labels=${JSON.stringify(labels)}
              unit="docs"></nr-sparkline>`}
      </section>`;
  }

  private statsView(): TemplateResult {
    const s = this.stats;
    if (s === null) {
      return html`<p class="empty big">${this.loading ? "Reading the index…" : "No numbers yet."}</p>`;
    }
    const ratio = s.corpus_bytes > 0 ? s.markdown_bytes_raw / s.corpus_bytes : 0;
    const share = s.docs > 0 ? (s.classified / s.docs) * 100 : 0;
    return html`
      <div class="figs">
        ${this.figure("Documents indexed", count(s.indexed),
          `${count(s.docs)} fetched · ${count(s.pending)} pending · ${count(s.excluded)} excluded`)}
        ${this.figure("Domains", count(s.domains),
          s.domains > 0 ? `${(s.indexed / s.domains).toFixed(1)} pages per domain` : "")}
        ${this.figure("Corpus on disk", size(s.corpus_bytes),
          `${size(s.markdown_bytes_raw)} raw · ${ratio.toFixed(1)}× compression`)}
        ${this.figure("Classified", `${share.toFixed(0)}%`,
          `${count(s.classified)} of ${count(s.docs)} · enrichment runs on a timer`)}
      </div>
      <p class="freshness">
        Newest page fetched ${ago(s.newest_fetch)} <span class="dim">(${when(s.newest_fetch)})</span>
        · crawl began ${when(s.oldest_fetch)}
      </p>
      ${this.ingest()}
      <div class="grid">
        ${this.bars("Languages", this.analytics?.by_lang, 8, (k) => named(k, "lang"))}
        ${this.bars("Countries", this.analytics?.by_country, 8, (k) => named(k, "country"))}
        ${this.bars("Categories", this.analytics?.by_category, 8, (k) => named(k, "category"))}
        ${this.bars("Tiers", this.analytics?.by_tier, 3, (k) => TIERS[k] ?? k)}
      </div>
      <div class="grid">
        ${this.bars("Top domains", this.analytics?.by_domain, 12)}
        ${this.bars("Why pages were rejected", this.analytics?.rejects, 12)}
      </div>`;
  }

  /** A field, as this console draws fields: nr-input, never a bare <input>.
   *  The value is read off the element rather than out of the event, because
   *  the three LumenUI fields describe their payloads differently and `.value`
   *  is the one thing all of them agree on (app/CLAUDE.md). Both events are
   *  bound for the same reason the settings forms bind both. */
  private field(f: {
    id: string; value: string; label?: string; placeholder?: string;
    type?: string; on: (v: string) => void; onEnter?: () => void;
  }): TemplateResult {
    const read = (e: Event) => f.on((e.target as unknown as { value?: string }).value ?? "");
    return html`
      <nr-input id=${f.id} .value=${f.value} type=${f.type ?? "text"}
        placeholder=${f.placeholder ?? ""}
        @nr-input=${read} @input=${read}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && f.onEnter) { e.preventDefault(); f.onEnter(); }
          if (e.key === "Escape") this.suggestions = [];
        }}>
        ${f.label === undefined ? nothing : html`<span slot="label">${f.label}</span>`}
      </nr-input>`;
  }

  /** A choice, as this console draws choices: nr-dropdown rather than
   *  nr-select, so every menu in the app is the same object — the reasoning is
   *  written out on `choice()` in settings.ts. Three consequences, all of them
   *  here: the label sits beside the field because a dropdown has no label
   *  slot; the trigger has to draw the current value because a dropdown does
   *  not know it; and the event carries the item, not a value. */
  private pick(f: {
    id: string; label: string; value: string;
    options: { value: string; label: string }[]; on: (v: string) => void;
  }): TemplateResult {
    const chosen = f.options.find((o) => o.value === f.value);
    return html`
      <div class="f">
        <span class="label">${f.label}</span>
        <nr-dropdown block class="pick" id=${f.id} trigger="click"
          placement="bottom-start" auto-close
          .items=${f.options.filter((o) => Boolean(o.label))
            .map((o) => ({ id: o.value, label: o.label }))}
          @nr-dropdown-item-click=${(e: CustomEvent<{ item: { id: string } }>) =>
            f.on(e.detail.item.id)}>
          <button slot="trigger" type="button" class="pick-face" aria-haspopup="listbox">
            <span class="pick-value">${chosen === undefined ? f.value : chosen.label}</span>
            <nr-icon name="chevron-down" size="small"></nr-icon>
          </button>
        </nr-dropdown>
      </div>`;
  }

  private filterRow(): TemplateResult {
    // Populated from the analytics keys, which is what makes a filter honest:
    // every option offered is a value some document actually carries, with its
    // count beside it, so an empty result is the query's doing and not a
    // filter for something the corpus has never seen.
    const from = (list: Bucket[] | undefined, kind: "country" | "category" | "lang") =>
      [{ value: "", label: "any" }].concat((list ?? []).slice(0, 40)
        .map((b) => ({ value: b.key, label: `${named(b.key, kind)} (${count(b.n)})` })));
    return html`
      <div class="filters">
        ${this.pick({ id: "f-lang", label: "Language", value: this.filters.lang,
          options: from(this.analytics?.by_lang, "lang"),
          on: (v) => { this.filters = { ...this.filters, lang: v }; } })}
        ${this.pick({ id: "f-country", label: "Country", value: this.filters.country,
          options: from(this.analytics?.by_country, "country"),
          on: (v) => { this.filters = { ...this.filters, country: v }; } })}
        ${this.pick({ id: "f-category", label: "Category", value: this.filters.category,
          options: from(this.analytics?.by_category, "category"),
          on: (v) => { this.filters = { ...this.filters, category: v }; } })}
        <div class="f">
          ${this.field({ id: "f-site", label: "Site", value: this.filters.site,
            placeholder: "react.dev",
            on: (v) => { this.filters = { ...this.filters, site: v.trim() }; } })}
        </div>
      </div>`;
  }

  private searchView(): TemplateResult {
    return html`
      <div class="ask">
        <div class="ask-field">
          ${this.field({ id: "s-q", value: this.q, placeholder: "Search the index…",
            on: (v) => this.suggest(v), onEnter: () => { void this.search(); } })}
          ${this.suggestions.length === 0 ? nothing : html`
            <ul class="suggest">
              ${this.suggestions.map((s) => html`
                <li @mousedown=${(e: Event) => {
                  e.preventDefault();
                  this.q = s.text;
                  this.suggestions = [];
                  void this.search();
                }}>
                  <span>${s.text}</span>
                  <span class="src">${s.source}</span>
                </li>`)}
            </ul>`}
        </div>
        <div class="f k">
          ${this.field({ id: "s-k", label: "k", type: "number", value: String(this.k),
            on: (v) => { this.k = Number(v) || 10; } })}
        </div>
        <button class="go" ?disabled=${this.searching} @click=${() => void this.search()}>
          ${this.searching ? "Searching…" : "Search"}
        </button>
      </div>
      ${this.filterRow()}
      ${this.results === null ? nothing : this.results.length === 0
        ? html`<p class="empty big">No coverage for that query yet — the corpus is young.</p>`
        : html`
          <p class="tookline">${count(this.results.length)} results in ${this.took} ms</p>
          <ol class="results">
            ${this.results.map((r) => html`
              <li>
                <a class="r-title" href=${r.url} target="_blank" rel="noreferrer noopener">${r.title || r.url}</a>
                <div class="r-url">${r.url}</div>
                <p class="r-snip">${bolded(r.snippet ?? "")}</p>
                <div class="r-meta">
                  <span class="tag score">BM25 ${r.score.toFixed(2)}</span>
                  <span class="tag">${named(r.lang, "lang")}</span>
                  <span class="tag">${named(r.country, "country")}</span>
                  <span class="tag">${named(r.category, "category")}</span>
                  <span class="tag">${r.source}</span>
                  <span class="dim">fetched ${new Date(r.fetched_at).toLocaleDateString()}</span>
                </div>
              </li>`)}
          </ol>`}`;
  }

  private ragView(): TemplateResult {
    const passages = this.passages ?? [];
    let running = 0;
    return html`
      <div class="ask">
        <div class="ask-field">
          ${this.field({ id: "r-q", value: this.rq,
            placeholder: "What would the agent be retrieving for?",
            on: (v) => { this.rq = v; }, onEnter: () => { void this.retrieve(); } })}
        </div>
        <div class="f k">
          ${this.field({ id: "r-k", label: "k", type: "number", value: String(this.rk),
            on: (v) => { this.rk = Number(v) || 5; } })}
        </div>
        <div class="f k wide-k">
          ${this.field({ id: "r-max", label: "Max chars", type: "number",
            value: String(this.maxChars),
            on: (v) => { this.maxChars = Number(v) || 24000; } })}
        </div>
        <button class="go" ?disabled=${this.retrieving} @click=${() => void this.retrieve()}>
          ${this.retrieving ? "Retrieving…" : "Retrieve"}
        </button>
      </div>
      ${this.filterRow()}
      ${this.passages === null ? nothing : passages.length === 0
        ? html`<p class="empty big">Nothing retrievable for that query yet.</p>`
        : html`
          <div class="budget">
            <p class="tookline">
              ${count(passages.length)} passages in ${this.rtook} ms ·
              ${count(passages.reduce((s, p) => s + p.text.length, 0))} of
              ${count(this.maxChars)} characters
            </p>
            <button class="copy" @click=${async () => {
              await navigator.clipboard.writeText(this.assembled());
              this.copied = true;
              window.setTimeout(() => { this.copied = false; }, 1600);
            }}>${this.copied ? "Copied" : "Copy assembled context"}</button>
          </div>
          <div class="passages">
            ${passages.map((p) => {
              running += p.text.length;
              const over = running > this.maxChars;
              return html`
                <article class="passage ${over ? "over" : ""}">
                  <header>
                    <a href=${p.url} target="_blank" rel="noreferrer noopener">${p.title || p.url}</a>
                    <span class="dim">${p.domain}</span>
                    <span class="tag score">BM25 ${p.score.toFixed(2)}</span>
                    <span class="tag">${count(p.text.length)} chars</span>
                    <span class="tag ${over ? "warn" : ""}">${count(running)} running</span>
                    <button class="linky" @click=${() => void this.open(p.hash)}>
                      ${this.opened === p.hash ? "hide source" : "view source"}
                    </button>
                  </header>
                  <pre>${p.text}</pre>
                  ${this.opened !== p.hash ? nothing : html`
                    <div class="doc">
                      ${this.doc === null
                        ? html`<p class="empty">Loading the document…</p>`
                        : html`<pre class="full">${this.doc.markdown ?? ""}</pre>`}
                    </div>`}
                </article>`;
            })}
          </div>`}`;
  }

  render(): TemplateResult {
    const publicOnly = this.mode === "public";
    return html`
      <div class="wrap">
        <header class="top">
          <div>
            <h2>${publicOnly ? "Inside the Joule index" : "Search index"}</h2>
            <p class="sub">
              ${publicOnly
                ? "A markdown-first web index: pages crawled, converted, gated for quality and indexed for search and retrieval. These numbers are live."
                : "Read-only. Every figure and result comes from the index API."}
            </p>
          </div>
          ${publicOnly ? nothing : html`
            <nav class="views">
              ${(["stats", "search", "rag"] as const).map((v) => html`
                <button class=${this.view === v ? "on" : ""} @click=${() => { this.view = v; }}>
                  ${v === "stats" ? "Stats" : v === "search" ? "Search" : "RAG"}
                </button>`)}
            </nav>`}
        </header>

        ${this.trouble === "" ? nothing : html`
          <p class="trouble">
            <nr-icon name="alert-triangle" size="small"></nr-icon>
            <span>${this.trouble}</span>
          </p>`}

        ${publicOnly || this.view === "stats" ? this.statsView()
          : this.view === "search" ? this.searchView() : this.ragView()}
      </div>`;
  }

  static styles = css`
    :host { display: block; color: var(--fg); }
    /* Every box here is border-box. Not a habit — the query field is
       width:100% inside a flex column with padding and a border, and under the
       default content-box it overflowed its container by exactly those 26px
       and sat on top of the k input beside it. A shadow root inherits no
       reset, so the rule has to be stated. */
    *, *::before, *::after { box-sizing: border-box; }
    .wrap { display: flex; flex-direction: column; gap: 18px; }

    .top { display: flex; align-items: flex-start; justify-content: space-between;
           gap: 20px; flex-wrap: wrap; }
    h2 { margin: 0; font: 600 19px var(--display, inherit); }
    .sub { margin: 5px 0 0; font-size: 13.5px; color: var(--muted); max-width: 62ch;
           line-height: 1.5; }

    /* The three views, as one track. Same shape as the theme picker in
       settings so the page has one idea of what a segmented choice looks
       like. */
    .views { display: flex; gap: 4px; padding: 4px; border-radius: 12px;
             background: var(--bg-sunken); flex: none; }
    .views button { padding: 7px 16px; border: 0; border-radius: 9px; background: none;
                    font: inherit; font-size: 13.5px; color: var(--muted); cursor: pointer;
                    transition: background-color .15s cubic-bezier(.23,1,.32,1),
                                color .15s cubic-bezier(.23,1,.32,1); }
    .views button:hover { color: var(--fg); }
    .views button.on { background: var(--bg-card); color: var(--fg); font-weight: 550;
                       box-shadow: 0 1px 2px rgba(0,0,0,.12); }

    .trouble { display: flex; align-items: center; gap: 9px; margin: 0;
               padding: 10px 13px; border-radius: 12px; font-size: 13px;
               background: var(--bg-sunken); border: 1px solid var(--border); }

    /* Headline numbers. Tabular figures so a column of counts lines up, and a
       label above rather than below — the reader is scanning for the thing,
       not the number. */
    .figs { display: grid; gap: 12px;
            grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
    .fig { padding: 15px 16px; border: 1px solid var(--border); border-radius: 14px;
           background: var(--bg-card); }
    .fig-label { font-size: 11px; letter-spacing: .09em; text-transform: uppercase;
                 color: var(--muted); font-weight: 600; }
    .fig-value { margin-top: 7px; font: 600 27px var(--display, inherit);
                 font-variant-numeric: tabular-nums; }
    .fig-note { margin-top: 5px; font-size: 12px; color: var(--muted); line-height: 1.45; }

    .freshness { margin: -4px 0 0; font-size: 12.5px; color: var(--muted); }
    .dim { color: var(--faint, var(--muted)); }

    .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .panel { padding: 15px 16px 17px; border: 1px solid var(--border);
             border-radius: 14px; background: var(--bg-card); min-width: 0; }
    .panel.wide { grid-column: 1 / -1; }
    .panel-head { display: flex; align-items: baseline; justify-content: space-between;
                  gap: 10px; margin-bottom: 12px; }
    .panel h3 { margin: 0; font-size: 13.5px; font-weight: 600; }
    .of { font-size: 11.5px; color: var(--muted); }

    /* A bar row is a grid and not a flex line: the key column and the two
       number columns have to align down the panel, which flex would only do
       by accident. */
    .bars { display: flex; flex-direction: column; gap: 7px; }
    .bar-row { display: grid; grid-template-columns: minmax(64px, 30%) 1fr auto auto;
               align-items: center; gap: 9px; font-size: 12.5px; }
    .bar-key { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { height: 8px; border-radius: 999px; background: var(--bg-sunken);
                 overflow: hidden; }
    .bar-fill { display: block; height: 100%; border-radius: 999px;
                background: var(--accent, #4B6BFB); }
    .bar-n { font-variant-numeric: tabular-nums; }
    .bar-pc { font-variant-numeric: tabular-nums; color: var(--muted); min-width: 44px;
              text-align: right; }

    nr-sparkline { display: block; width: 100%; }

    .empty { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); }
    .empty.big { padding: 34px 0; text-align: center; font-size: 14px; }

    /* The query row. One field, one k, one verb — the filters sit under it so
       the common case is a single line. */
    .ask { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
    .ask-field { position: relative; flex: 1 1 320px; min-width: 0; }
    /* A field and whatever labels it. nr-input slots its own label; a dropdown
       cannot, so `.label` is dressed to match one. */
    .f { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .f .label { font-size: 12px; color: var(--muted); font-weight: 500; }
    .k { flex: none; width: 82px; }
    .wide-k { width: 124px; }
    nr-input { display: block; width: 100%; }
    /* The dropdown's own face, copied from the settings forms so a choice
       looks the same in both places. */
    .pick-face { display: flex; align-items: center; justify-content: space-between;
                 gap: 8px; width: 100%; padding: 8px 11px; cursor: pointer;
                 border: 1px solid var(--border); border-radius: 6px;
                 background: var(--bg-card); color: var(--fg);
                 font: inherit; font-size: 13px; text-align: left; }
    .pick-face:hover { border-color: var(--muted); }
    .pick-face:focus, .pick-face:focus-visible { outline: none; }
    .pick-face:focus-visible { border-color: var(--accent, #4B6BFB); }
    .pick-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .go { padding: 10px 20px; border: 0; border-radius: 11px; background: var(--fg);
          color: var(--bg); font: inherit; font-size: 14px; font-weight: 550;
          cursor: pointer; }
    .go[disabled] { opacity: .55; cursor: default; }

    .suggest { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 5px);
               margin: 0; padding: 5px; list-style: none; border-radius: 12px;
               border: 1px solid var(--border); background: var(--bg-card);
               box-shadow: 0 14px 34px -14px rgba(0,0,0,.35); max-height: 300px;
               overflow-y: auto; }
    .suggest li { display: flex; align-items: center; justify-content: space-between;
                  gap: 12px; padding: 8px 10px; border-radius: 8px; cursor: pointer;
                  font-size: 13.5px; }
    .suggest li:hover { background: var(--bg-sunken); }
    .suggest .src { font-size: 11px; color: var(--muted); flex: none; }

    .filters { display: grid; gap: 10px;
               grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }

    .tookline { margin: 0; font-size: 12.5px; color: var(--muted);
                font-variant-numeric: tabular-nums; }

    .results { margin: 0; padding: 0; list-style: none;
               display: flex; flex-direction: column; gap: 16px; }
    .r-title { font-size: 15px; font-weight: 600; color: var(--fg); text-decoration: none; }
    .r-title:hover { text-decoration: underline; }
    .r-url { font-size: 12px; color: var(--ok, #157F4D); overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
    .r-snip { margin: 6px 0 7px; font-size: 13.5px; line-height: 1.55; color: var(--fg); }
    .r-snip b { font-weight: 650; }
    .r-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
              font-size: 11.5px; }
    .tag { padding: 2px 8px; border-radius: 999px; background: var(--bg-sunken);
           color: var(--muted); font-variant-numeric: tabular-nums; }
    .tag.score { color: var(--fg); font-weight: 550; }
    .tag.warn { background: #FDF0EC; color: #8A2E12; }

    .budget { display: flex; align-items: center; justify-content: space-between;
              gap: 14px; flex-wrap: wrap; }
    .copy { padding: 7px 14px; border: 1px solid var(--border); border-radius: 10px;
            background: var(--bg-card); color: var(--fg); font: inherit;
            font-size: 13px; cursor: pointer; }
    .copy:hover { background: var(--bg-sunken); }

    .passages { display: flex; flex-direction: column; gap: 14px; }
    .passage { border: 1px solid var(--border); border-radius: 14px;
               background: var(--bg-card); overflow: hidden; }
    /* Past the budget the passage is still shown, dimmed, because what falls
       off the end is exactly what this view exists to make visible. */
    .passage.over { opacity: .62; }
    .passage header { display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
                      padding: 11px 14px; border-bottom: 1px solid var(--border);
                      font-size: 12px; }
    .passage header a { font-size: 13.5px; font-weight: 600; color: var(--fg);
                        text-decoration: none; }
    .passage header a:hover { text-decoration: underline; }
    .linky { margin-left: auto; border: 0; background: none; padding: 0; font: inherit;
             font-size: 12px; color: var(--muted); cursor: pointer;
             text-decoration: underline; }
    .linky:hover { color: var(--fg); }
    /* Monospace and pre-wrap: this is the literal text a model would receive,
       and re-flowing it into prose would be showing something else. */
    pre { margin: 0; padding: 13px 14px; font-family: ui-monospace, SFMono-Regular,
          Menlo, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap;
          overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; }
    .doc { border-top: 1px solid var(--border); background: var(--bg-sunken); }
    pre.full { max-height: 460px; }

    @media (max-width: 720px) {
      .top { flex-direction: column; }
      .bar-row { grid-template-columns: minmax(56px, 34%) 1fr auto; }
      .bar-pc { display: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap { "search-dash": SearchDash }
}

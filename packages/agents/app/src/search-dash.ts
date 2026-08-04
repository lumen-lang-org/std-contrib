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

interface Nodes {
  now: number;
  rate: {
    per_minute_1m: number; per_minute_5m: number; per_minute_60m: number;
    per_hour_estimate: number; per_day_estimate: number;
  };
  data_node: {
    role: string; up: boolean; status: string; last_doc_age_sec: number;
    docs: number; inbox_pending: number; spool_queued: number;
  };
  // Strings once, records since sharding landed. Both are still in the wild —
  // a data node that has not been redeployed answers the old way — so the
  // client accepts either rather than assuming the newer one.
  crawl_nodes: (string | { name?: string; host?: string; shard?: number })[];
}

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

/** A crawl node, as a word.
 *
 *  The endpoint used to answer this as "ubuntu@100.87.212.31" and now answers
 *  it as {name, host, shard}. Joining the array without looking printed
 *  "[object Object]" under the count — the one failure mode a panel like this
 *  must not have, because it is the reading that says the data is wrong when
 *  the data is fine. Both shapes are handled, and anything else falls back to
 *  something a person can still read. */
function nodeName(n: unknown): string {
  if (typeof n === "string") return n;
  if (n !== null && typeof n === "object") {
    const r = n as { name?: unknown; host?: unknown; shard?: unknown };
    if (typeof r.name === "string" && r.name !== "") return r.name;
    if (typeof r.host === "string" && r.host !== "") return r.host;
    if (typeof r.shard === "number") return `shard ${r.shard}`;
  }
  return "unnamed node";
}

/** The same node with its address, for a title attribute — the detail somebody
 *  wants when a node looks wrong, and clutter when none of them do. */
function nodeDetail(n: unknown): string {
  if (typeof n === "string") return n;
  if (n !== null && typeof n === "object") {
    const r = n as { name?: unknown; host?: unknown; shard?: unknown };
    const bits = [
      typeof r.name === "string" ? r.name : "",
      typeof r.host === "string" ? r.host : "",
      typeof r.shard === "number" ? `shard ${r.shard}` : "",
    ].filter((b) => b !== "");
    return bits.join(" · ");
  }
  return "";
}

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

  // The pipeline panel. `nodes` is the last answer that ARRIVED, kept across a
  // failed poll on purpose: zeros would read as a dead pipeline, which is a
  // different and much louder claim than "we could not ask".
  @state() private nodes: Nodes | null = null;
  @state() private nodesAt = 0;
  @state() private nodesStale = false;
  /** One sample of per_minute_1m per poll, newest last. Forty is about ten
   *  minutes at this cadence — long enough to show a slump, short enough that
   *  a spike two hours ago is not still flattening today's chart. */
  @state() private rateHistory: number[] = [];
  /** Backlog depths, same cadence, for the direction arrows. A queue is only
   *  legible as a trend: 1,600 spooled is normal, 1,600 and climbing is not. */
  @state() private spoolHistory: number[] = [];
  @state() private inboxHistory: number[] = [];

  private timer = 0;
  private nodeTimer = 0;
  private typing = 0;
  private onVisible: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    // The corpus is actively growing, so the numbers are a live reading rather
    // than a report. The proxy caches for 20s, which means a 30s poll costs
    // the index at most one request per window however many people are here.
    this.timer = window.setInterval(() => { void this.refresh(true); }, 30_000);
    if (this.mode === "admin") {
      void this.pollNodes();
      this.nodeTimer = window.setInterval(() => { void this.pollNodes(); }, 12_000);
      // A hidden tab is a tab nobody is reading, and this one polls five times
      // a minute against a single box. Browsers already throttle a background
      // interval, but throttled is not stopped — and the first thing somebody
      // wants on coming back is a fresh reading, not a stale one plus a wait.
      this.onVisible = () => {
        if (document.visibilityState === "visible") void this.pollNodes();
      };
      document.addEventListener("visibilitychange", this.onVisible);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
    window.clearInterval(this.nodeTimer);
    window.clearTimeout(this.typing);
    if (this.onVisible !== null) {
      document.removeEventListener("visibilitychange", this.onVisible);
      this.onVisible = null;
    }
  }

  private async pollNodes(): Promise<void> {
    if (document.visibilityState === "hidden") return;
    try {
      const n = await ask<Nodes>("/nodes");
      this.nodes = n;
      this.nodesAt = Date.now();
      this.nodesStale = false;
      const keep = (list: number[], value: number) =>
        [...list, value].slice(-40);
      this.rateHistory = keep(this.rateHistory, n.rate?.per_minute_1m ?? 0);
      this.spoolHistory = keep(this.spoolHistory, n.data_node?.spool_queued ?? 0);
      this.inboxHistory = keep(this.inboxHistory, n.data_node?.inbox_pending ?? 0);
    } catch {
      // Nothing is cleared. The panel dims and says when it last heard.
      this.nodesStale = true;
    }
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
          ? html`<p class="empty">No documents counted.</p>`
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
          ? html`<p class="empty">${points.length === 0
              ? "No hours recorded." : "One hour recorded; a line needs two."}</p>`
          : html`<nr-sparkline
              points=${JSON.stringify(points)}
              labels=${JSON.stringify(labels)}
              unit="docs"></nr-sparkline>`}
      </section>`;
  }

  /** The corpus as a masthead rather than a dashboard.
   *
   *  The first version of this was three rounded cards in a row, each with an
   *  uppercase letter-spaced micro-label over a big number, over a grey note —
   *  which is the shape every generated dashboard has, and it says nothing
   *  about a web index in particular. It also buried the one number worth
   *  reading among two others of equal weight.
   *
   *  This is a colophon instead: one count at display size, the rest as a
   *  sentence under it, and the language split as a single segmented rule. The
   *  ink is one hue at falling opacity rather than a palette — these are parts
   *  of one quantity, and eight hues would imply eight unrelated things. */
  private publicView(s: Stats): TemplateResult {
    const langs = this.analytics?.by_lang ?? [];
    const total = langs.reduce((sum, b) => sum + b.n, 0);
    const lead = langs.slice(0, 6);
    const rest = total - lead.reduce((sum, b) => sum + b.n, 0);
    const parts = rest > 0 ? lead.concat([{ key: "other", n: rest }]) : lead;
    return html`
      <div class="mast">
        <p class="eyebrow">The Joule index</p>
        <p class="count">${count(s.indexed)}</p>
        <p class="lede">
          documents from ${count(s.domains)} domains.
        </p>
        <!-- No disk figure and no compression ratio. Both are facts about how
             the corpus is STORED, which is the operator's business; a visitor
             is being told how much there is and how fresh it is. -->
        <p class="facts">
          The newest page landed <b>${ago(s.newest_fetch)}</b>;
          the crawl has been running since ${when(s.oldest_fetch)}.
        </p>
      </div>

      ${parts.length === 0 ? nothing : html`
        <section class="split">
          <h3>Languages</h3>
          <div class="rule" role="img"
            aria-label=${parts.map((b) => `${named(b.key, "lang")} ${b.n}`).join(", ")}>
            ${parts.map((b, i) => html`
              <span class="seg" title=${`${named(b.key, "lang")} — ${count(b.n)}`}
                style=${`flex: ${b.n}; opacity: ${(1 - i * 0.13).toFixed(2)}`}></span>`)}
          </div>
          <p class="legend">
            ${parts.map((b, i) => html`${i === 0 ? nothing : html`<span class="sep">·</span>`}<span
              class="leg"><span class="swatch"
                style=${`opacity: ${(1 - i * 0.13).toFixed(2)}`}></span>${named(b.key, "lang")}
              <span class="n">${count(b.n)}</span></span>`)}
          </p>
        </section>`}`;
  }

  /** Which way a queue is moving, over the last handful of samples.
   *
   *  Compared against five polls back (about a minute) rather than the
   *  previous one: a queue that ticks 1,600 -> 1,598 -> 1,601 is flat, and an
   *  arrow that flips on every poll is noise wearing the costume of a signal.
   *  The 5% band is what makes "flat" a real answer. */
  private trend(list: number[]): { dir: "up" | "down" | "flat"; delta: number } {
    if (list.length < 3) return { dir: "flat", delta: 0 };
    const now = list[list.length - 1];
    const then = list[Math.max(0, list.length - 6)];
    const delta = now - then;
    const band = Math.max(5, then * 0.05);
    if (delta > band) return { dir: "up", delta };
    if (delta < -band) return { dir: "down", delta };
    return { dir: "flat", delta };
  }

  /** A backlog, with its direction. Up is bad here and the colour says so —
   *  a growing queue means processing is falling behind the crawlers, which is
   *  the whole reason to look at this number rather than the rate above it. */
  private gauge(
    label: string, value: number, history: number[], what: string, detail = "",
  ): TemplateResult {
    const { dir, delta } = this.trend(history);
    const icon = dir === "up" ? "arrow-up" : dir === "down" ? "arrow-down" : "minus";
    return html`
      <div class="gauge">
        <div class="g-label">${label}</div>
        <div class="g-row">
          <span class="g-value">${count(value)}</span>
          <span class="g-trend ${dir}">
            <nr-icon name=${icon} size="small"></nr-icon>
            ${dir === "flat" ? "steady" : `${delta > 0 ? "+" : ""}${count(delta)}`}
          </span>
        </div>
        <div class="g-what" title=${detail === "" ? what : detail}>${what}</div>
      </div>`;
  }

  /** The pipeline, as an operations panel.
   *
   *  Three questions in the order somebody asks them: is it alive, how fast is
   *  it going, is anything piling up. Everything here is one GET; nothing is
   *  derived except the trend arrows, which are computed from samples this
   *  component kept rather than from anything the API was asked to remember. */
  /** Whether the data node is the one doing the extracting.
   *
   *  Inferred, because the payload does not say. Spool queued above zero means
   *  the crawl nodes are shipping raw pages for somebody else to extract, and
   *  the only somebody else is the data node. Inferred from anything ever
   *  seen rather than from the current sample: spool drains to zero regularly
   *  on a healthy fleet, and a gauge that reappeared every time it did would
   *  be worse than one that never went away.
   *
   *  The clean answer is `extract_on` in the payload. That is the index API's
   *  own repo and not this one's to change — if this inference is ever wrong,
   *  that is the fix, not a cleverer guess here. */
  private extractsHere(): boolean {
    return this.spoolHistory.some((n) => n > 0);
  }

  private nodesPanel(): TemplateResult {
    const n = this.nodes;
    if (n === null) {
      return html`
        <section class="panel wide pipeline">
          <p class="empty">${this.nodesStale ? "The pipeline is not answering." : "Reading the pipeline…"}</p>
        </section>`;
    }
    const d = n.data_node;
    // "stalled" is a FAULT, not idleness: a healthy pipeline always has
    // arrivals, so it gets the weight of a failed request rather than the grey
    // of a paused one. "empty" is the only genuinely neutral state — a fresh
    // node legitimately has nothing yet.
    const tone = d.status === "ingesting" ? "ok" : d.status === "stalled" ? "bad" : "idle";
    // A payload that disagrees with itself.
    //
    // The index says "empty" only when the docs table has no rows, and answers
    // -1 for the age in the same breath. Both of those arriving beside a docs
    // count in the hundreds of thousands is not a state the pipeline can be in
    // — it is one request's five separate table scans disagreeing about what
    // they saw, which is what a screenshot of EMPTY beside 130,277 documents
    // and 604 documents a minute actually was.
    //
    // Drawn rather than hidden, and drawn as a fault. Every field here is
    // individually plausible, so a panel that renders them without comment
    // reports a dead pipeline to someone whose pipeline is fine — and the next
    // person to see it has no way to tell this from the real thing.
    const disagrees = (d.status === "empty" || d.last_doc_age_sec < 0) && d.docs > 0;
    const spark = this.rateHistory;
    const secs = Math.round((Date.now() - this.nodesAt) / 1000);
    return html`
      <section class="panel wide pipeline ${this.nodesStale ? "stale" : ""}">
        <header class="panel-head">
          <h3>Pipeline</h3>
          <span class="of">
            ${this.nodesStale
              ? html`<span class="warn-text">not answering</span> · last heard ${secs}s ago`
              : html`updated ${secs < 2 ? "just now" : `${secs}s ago`}`}
          </span>
        </header>

        ${disagrees ? html`
          <p class="disagrees">The index reported
            <strong>${d.status}</strong> beside ${count(d.docs)} documents, which
            cannot both be true. Read this panel as unreliable until the index
            answers consistently.</p>` : nothing}

        <div class="pipe-top">
          <span class="state ${disagrees ? "bad" : tone}">${d.status}</span>
          <div class="rate">
            <span class="rate-n">${count(n.rate.per_minute_5m)}</span>
            <span class="rate-u">documents / minute</span>
          </div>
          <div class="proj">
            <span>${count(n.rate.per_hour_estimate)} / hour</span>
            <span>${count(n.rate.per_day_estimate)} / day</span>
          </div>
          <div class="proj total">
            <span>${count(d.docs)} documents</span>
            <!-- -1 is a sentinel, not an age: it is what the index answers when
                 MAX(first_seen) found no rows at all. It satisfied the <= 1 test, so a
                 node that has never ingested a single document reported that its
                 newest document arrived this second — the most reassuring
                 possible rendering of the emptiest possible state. -->
            <span>${d.last_doc_age_sec < 0 ? "no documents yet"
              : d.last_doc_age_sec <= 1 ? "newest just now"
              : `newest ${ago(Math.floor(Date.now() / 1000) - d.last_doc_age_sec)}`}</span>
          </div>
        </div>

        ${spark.length < 2 ? nothing : html`
          <nr-sparkline class="pipe-spark"
            points=${JSON.stringify(spark)}
            unit="docs/min"></nr-sparkline>`}

        <div class="gauges">
          ${this.gauge("Spool queued", d.spool_queued, this.spoolHistory,
            "raw pages awaiting processing")}
          <!-- Inbox pending counts bundles awaiting absorption, and only means
               anything where the crawl nodes extract. This fleet extracts on the
               data node, so nothing ever produces a bundle and the number is
               structurally 0 — healthy or dead alike. A gauge that reads zero
               through a total outage does not merely fail to inform; it trains
               whoever is watching to take a meaningless number as reassurance.

               Which mode is running is not in the payload. Adding extract_on
               upstream is the clean fix and it belongs to the index API's own
               repo, so this infers it instead: spool that has ever been seen
               queued is proof the crawl nodes ship raw pages, which is the data
               side doing the extracting. -->
          ${this.extractsHere() ? nothing
            : this.gauge("Inbox pending", d.inbox_pending, this.inboxHistory,
                "bundles awaiting absorption")}
          ${this.gauge("Crawl nodes", n.crawl_nodes.length, [],
            n.crawl_nodes.length === 0 ? "none reporting"
              : n.crawl_nodes.map(nodeName).join(", "),
            n.crawl_nodes.map(nodeDetail).join(" | "))}
        </div>
      </section>`;
  }

  private statsView(): TemplateResult {
    const s = this.stats;
    if (s === null) {
      return html`<p class="empty big">${this.loading
        ? "Reading the index…" : "The index answered with nothing."}</p>`;
    }
    const ratio = s.corpus_bytes > 0 ? s.markdown_bytes_raw / s.corpus_bytes : 0;
    const share = s.docs > 0 ? (s.classified / s.docs) * 100 : 0;

    // The public reading is its own layout, not this one with rows removed.
    // See publicView(): a dashboard is for somebody who operates the thing,
    // and a visitor is not operating anything.
    if (this.mode === "public") { return this.publicView(s); }

    return html`
      ${this.nodesPanel()}
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
      ${this.results === null
        ? html`<p class="empty big resting">Ask the index something. Results are
            the pages themselves — title, URL and the matched text — ranked by
            BM25, not by a model.</p>`
        : this.results.length === 0
        ? html`<p class="empty big">Nothing matched.
            ${Object.values(this.filters).some((v) => v !== "")
              ? "Clear the filters, or try fewer words."
              : "Try fewer words, or a term the pages would use themselves."}</p>`
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
            placeholder: "A question an agent would need context for",
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
      ${this.passages === null
        ? html`<p class="empty big resting">Ask what an agent would need context
            for. This returns the passages a retrieval call would hand the
            model, with the scores and the budget they would spend.</p>`
        : passages.length === 0
        ? html`<p class="empty big">No passages.
            Run the same query under Search to see whether anything matches.</p>`
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
      <div class="wrap ${publicOnly ? "public" : ""}">
        ${publicOnly ? nothing : html`
        <header class="top">
          <div>
            <h2>Search index</h2>
          </div>
          ${html`
            <nav class="views">
              ${(["stats", "search", "rag"] as const).map((v) => html`
                <button class=${this.view === v ? "on" : ""} @click=${() => { this.view = v; }}>
                  ${v === "stats" ? "Stats" : v === "search" ? "Search" : "RAG"}
                </button>`)}
            </nav>`}
        </header>`}

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
    /* The admin dashboard fills the pane it was given.
       :host was display:block with no height, so the shadow content was only
       ever as tall as itself — which is right on Stats, where the panels
       overflow and the pane scrolls, and wrong on Search and RAG, where a
       query box and a filter row came to 190px inside an 845px pane and left
       655px of nothing under them. The public page keeps its natural height:
       it is a document that ends, not a surface to fill. */
    :host { display: block; color: var(--fg); }
    :host([mode="admin"]) { display: flex; flex-direction: column; min-height: 100%; }
    /* Every box here is border-box. Not a habit — the query field is
       width:100% inside a flex column with padding and a border, and under the
       default content-box it overflowed its container by exactly those 26px
       and sat on top of the k input beside it. A shadow root inherits no
       reset, so the rule has to be stated. */
    *, *::before, *::after { box-sizing: border-box; }
    .wrap { display: flex; flex-direction: column; gap: 18px; }
    :host([mode="admin"]) .wrap { flex: 1; min-height: 0; }
    /* Whatever the view puts last takes the slack, so an empty state sits in
       the middle of the space it owns rather than pinned under the filters
       with the rest of the pane blank beneath it. */
    :host([mode="admin"]) .wrap > :last-child { flex: 1 1 auto; min-height: 0; }
    .empty.big { display: grid; place-content: center; }
    /* The state before anybody has asked anything. Quieter than a result that
       came back empty: nothing has gone wrong, the view is simply waiting. */
    .empty.big.resting { color: var(--faint); max-width: 44ch;
                         margin-inline: auto; text-align: center; }

    /* --- the public page ---------------------------------------------------
       Set as a colophon: an eyebrow, one count at display size, and two
       sentences. No cards, no uppercase micro-labels, no row of equal figures
       — the point of the page is a single quantity and everything else is
       context for it. */
    .wrap.public { gap: 30px; }
    .mast { max-width: 60ch; }
    .eyebrow { margin: 0; font-size: 12.5px; color: var(--muted); }
    /* The count is the page. Tabular so a digit change does not shift the
       ones beside it while it polls, tight tracking because a number this
       size loosens on its own. */
    .count { margin: 2px 0 0; font: 600 clamp(56px, 11vw, 92px)/1 var(--display, inherit);
             letter-spacing: -0.035em; font-variant-numeric: tabular-nums; }
    .lede { margin: 10px 0 0; font-size: 19px; line-height: 1.45; max-width: 34ch; }
    .facts { margin: 14px 0 0; font-size: 14px; line-height: 1.65; color: var(--muted); }
    .facts b { color: var(--fg); font-weight: 550; }

    /* One rule, segmented — the shape of the whole rather than eight bars to
       compare. Parts of one quantity, so one ink at falling opacity; eight
       hues would say eight unrelated things. */
    /* Held to the text's own measure. Run full-width and the rule reads as a
       progress bar for the page rather than as a fact about the corpus, and
       the legend under it strands itself against an empty right half. */
    .split { max-width: 60ch; }
    .split h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
    .rule { display: flex; height: 14px; border-radius: 999px; overflow: hidden;
            gap: 2px; background: var(--bg-sunken); }
    .seg { background: var(--fg); min-width: 3px; }
    .legend { display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
              margin: 11px 0 0; font-size: 12.5px; color: var(--muted); }
    .leg { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 9px; height: 9px; border-radius: 3px; background: var(--fg);
              display: inline-block; }
    .legend .n { font-variant-numeric: tabular-nums; color: var(--fg); }
    .legend .sep { opacity: .45; }

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

    /* --- the pipeline panel ------------------------------------------------
       An operations panel, so it is read at a glance rather than studied: the
       state first, the rate as the one large number, projections and totals as
       supporting text, then the queues. Everything tabular, because a figure
       that reflows on every poll is a figure nobody can watch. */
    .pipeline { display: flex; flex-direction: column; gap: 14px; }
    /* A poll that failed dims the panel rather than blanking it. The values are
       still true, they are just older than they look, and the header says how
       much older. */
    .pipeline.stale { opacity: .6; }
    .warn-text { color: var(--alert, #B23434); font-weight: 600; }
    /* A payload that contradicts itself. Above the numbers rather than beside
       them, because it is about all of them at once. */
    .disagrees { margin: 0 0 12px; padding: 9px 12px; border-radius: 8px;
                 background: color-mix(in srgb, var(--alert, #B23434) 9%, transparent);
                 border: 1px solid color-mix(in srgb, var(--alert, #B23434) 30%, transparent);
                 font-size: 12.5px; line-height: 1.5; color: var(--fg); }

    .pipe-top { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
    /* The state, as a word. "stalled" carries the weight of a failed request,
       because five minutes without an arrival is a fault and not a rest. */
    .state { font-size: 11.5px; font-weight: 650; letter-spacing: .08em;
             text-transform: uppercase; padding: 4px 11px; border-radius: 999px;
             border: 1px solid currentColor; display: inline-flex;
             align-items: center; gap: 7px; }
    .state::before { content: ""; width: 7px; height: 7px; border-radius: 50%;
                     background: currentColor; }
    .state.ok { color: var(--ok, #157F4D); }
    .state.bad { color: var(--alert, #B23434); }
    .state.idle { color: var(--muted); }

    .rate { display: flex; align-items: baseline; gap: 8px; }
    .rate-n { font: 600 30px var(--display, inherit); font-variant-numeric: tabular-nums;
              letter-spacing: -.02em; }
    .rate-u { font-size: 12.5px; color: var(--muted); }
    .proj { display: flex; flex-direction: column; font-size: 12.5px;
            color: var(--muted); font-variant-numeric: tabular-nums; }
    .proj.total { margin-left: auto; text-align: right; }

    .pipe-spark { height: 54px; }

    .gauges { display: grid; gap: 12px;
              grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .gauge { padding: 11px 13px; border: 1px solid var(--border); border-radius: 12px;
             background: var(--bg-sunken); }
    .g-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
               color: var(--muted); font-weight: 600; }
    .g-row { display: flex; align-items: baseline; gap: 9px; margin-top: 5px; }
    .g-value { font: 600 20px var(--display, inherit); font-variant-numeric: tabular-nums; }
    .g-trend { display: inline-flex; align-items: center; gap: 3px; font-size: 12px;
               font-variant-numeric: tabular-nums; color: var(--muted); }
    /* A queue climbing is the bad direction — it means processing is falling
       behind the crawlers. Draining is the good one. Neither is loud. */
    .g-trend.up { color: var(--alert, #B23434); }
    .g-trend.down { color: var(--ok, #157F4D); }
    .g-what { margin-top: 4px; font-size: 11.5px; color: var(--muted);
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .empty { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); }
    .empty.big { padding: 34px 0; text-align: center; font-size: 14px; }

    /* The query row. One field, one k, one verb — the filters sit under it so
       the common case is a single line. */
    .ask { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
    .ask-field { position: relative; flex: 1 1 320px; min-width: 0; }
    /* A field and whatever labels it. nr-input slots its own label; a dropdown
       cannot, so the .label span is dressed to match one. (No backticks in
       this comment: it lives inside a css template literal, where one ends the
       literal — and the result still BUILDS, so the only symptom is a
       TypeError at import time.) */
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

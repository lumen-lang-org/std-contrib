// Discover: what the crawl found, read rather than searched.
//
// A feed, not a search result page. The distinction drives the whole layout:
// somebody arriving here has no query and no goal, so the page has to be
// worth reading top to bottom — which means one story leads, the rest are
// scannable, and nothing is a wall of equal-weight rows.
//
// Everything on screen was written by a background pass (digestLoop in the
// engine), so this element fetches rows and draws them. It never calls a
// model, never waits on one, and cannot show a spinner where a story should
// be: a feed whose freshness depends on the reader opening it is not a feed.
//
// Two honest limits are DESIGNED FOR rather than hidden:
//
//   * Most stories carry ONE source today, because the crawl's per-topic
//     source diversity is still thin. The card says "1 source" plainly. When
//     the crawl widens the same card says seven, with no change here.
//
//   * `fetchedAt` is when the crawler FETCHED the oldest source, never when
//     anything was published — the index does not know that. The card says
//     "fetched", which is a smaller claim than every news UI makes and the
//     only true one.

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DiscoverFeed, DiscoverStory, listDiscover } from "./api.js";

/** The host a url belongs to, as a person reads it: no scheme, no www. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** How long ago, in the words a person uses. */
function ago(stamp: string): string {
  const ms = Date.parse(stamp);
  if (!isFinite(ms)) return "";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** What the weather proxy answers. */
type Sky = {
  city: string; country: string; temperature: number; unit: string;
  code: number; day: boolean; high: number | null; low: number | null;
  /** The next few days, for the strip under the card. */
  week: { day: string; code: number; high: number; low: number }[];
};

/* A WMO weather code, as a word and a drawing.
 *
 * The glyphs are inline rather than nr-icon, and that is forced rather than a
 * preference: the icon set carries "cloud" and "zap" and nothing else
 * weather-shaped — no sun, no moon, no rain. nr-icon prints the NAME when it
 * has no glyph, so asking it for "cloud-rain" would put the words cloud-rain
 * on the page, which is the failure mode CLAUDE.md warns about. These are the
 * Lucide paths the set would have carried, drawn here.
 *
 * The codes are grouped rather than enumerated: WMO separates "slight" from
 * "moderate" drizzle, and a strip on a news page does not. */
type Glyph = { dot?: [number, number, number]; paths: string[]; word: string };

const SUN_RAYS = ["M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41",
  "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41",
  "m19.07 4.93-1.41 1.41"];
const CLOUD = "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242";

function sky(code: number, day: boolean): Glyph {
  if (code === 0) {
    return day
      ? { dot: [12, 12, 4], paths: SUN_RAYS, word: "Clear" }
      : { paths: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"], word: "Clear" };
  }
  if (code <= 2) {
    return { paths: ["M12 2v2", "m4.93 4.93 1.41 1.41", "M20 12h2",
      "m19.07 4.93-1.41 1.41", "M15.947 12.65a4 4 0 0 0-5.925-4.128",
      "M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"], word: "Partly cloudy" };
  }
  if (code === 3) {
    return { paths: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"],
      word: "Overcast" };
  }
  if (code <= 48) {
    return { paths: [CLOUD, "M3 20h18", "M5 16h14"], word: "Fog" };
  }
  if (code <= 57) {
    return { paths: [CLOUD, "M8 19v1", "M12 21v1", "M16 19v1"], word: "Drizzle" };
  }
  if (code <= 67 || (code >= 80 && code <= 82)) {
    return { paths: [CLOUD, "M16 14v6", "M8 14v6", "M12 16v6"],
      word: code >= 80 ? "Showers" : "Rain" };
  }
  if (code <= 77 || (code >= 85 && code <= 86)) {
    return { paths: [CLOUD, "M8 15h.01", "M8 19h.01", "M12 17h.01",
      "M12 21h.01", "M16 15h.01", "M16 19h.01"], word: "Snow" };
  }
  return { paths: ["M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973",
    "m13 12-3 5h4l-3 5"], word: "Thunderstorm" };
}

/** One weather glyph, drawn. Shared by the card and the forecast row so the
 *  two cannot end up with different pictures for the same sky. */
function glyph(g: Glyph) {
  return html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${g.dot === undefined ? nothing
        : svg`<circle cx=${g.dot[0]} cy=${g.dot[1]} r=${g.dot[2]}/>`}
      ${g.paths.map((d) => svg`<path d=${d}/>`)}
    </svg>`;
}

@customElement("discover-page")
export class DiscoverPage extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; flex: 1;
            height: 100%; min-height: 0;
            background: var(--bg-chat, var(--bg)); }

    /* The masthead. Name on the left, the choice in the middle, and that is
       the whole of it — a feed's chrome should not compete with the feed. */
    .top { display: flex; align-items: center; gap: 18px; flex: none;
           padding: 12px 24px; border-bottom: 1px solid var(--border); }
    .brand { font: 600 15px/1 var(--display); letter-spacing: -.01em; }
    .tabs { display: flex; align-items: center; gap: 2px; margin: 0 auto; }
    .tab { flex: none; font: inherit; font-size: 13.5px; cursor: pointer;
           border: 0; background: none; color: var(--muted);
           padding: 8px 12px; border-radius: 8px; position: relative;
           transition: color .15s cubic-bezier(.23,1,.32,1); }
    .tab:hover { color: var(--fg); }
    .tab.on { color: var(--fg); font-weight: 600; }
    /* An underline rather than a pill: the tabs sit ON the rule under the
       masthead, so the marker belongs to the rule. */
    .tab.on::after { content: ""; position: absolute; left: 12px; right: 12px;
                     bottom: -13px; height: 2px; background: var(--fg);
                     border-radius: 2px; }
    .when { flex: none; font-size: 12px; color: var(--faint); }

    .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 26px 24px 48px; }

    /* Two columns: the feed, and the things beside it.
       The rail is a fixed 330px and the feed takes the rest, because the rail
       holds cards whose contents have a natural width — a forecast row, a
       list of topics — and a feed does not. Below 1080 the rail drops UNDER
       the feed rather than narrowing: half a weather card is worse than one
       further down. */
    .page { display: grid; gap: 28px; max-width: 1320px; margin: 0 auto;
            grid-template-columns: minmax(0, 1fr) 330px; align-items: start; }
    @media (max-width: 1080px) {
      .page { grid-template-columns: minmax(0, 1fr); }
    }

    .feed { display: flex; flex-direction: column; gap: 26px; min-width: 0; }

    /* The lead: words on the left, picture on the right. The picture is the
       smaller half deliberately — this is a story you are meant to read the
       first sentence of, not a poster. */
    .lead { display: grid; gap: 22px; grid-template-columns: minmax(0, 1fr) 42%;
            align-items: start; padding-bottom: 26px;
            border-bottom: 1px solid var(--border); }
    .lead.noshot { grid-template-columns: minmax(0, 1fr); }
    .lead h2 { margin: 0 0 10px; font: 600 clamp(23px, 2.3vw, 30px)/1.16 var(--display);
               letter-spacing: -.02em; text-wrap: balance; }
    .lead .sum { margin: 0; font-size: 15.5px; line-height: 1.6; color: var(--fg);
                 max-width: 54ch; }
    @media (max-width: 640px) {
      .lead { grid-template-columns: minmax(0, 1fr); }
      .lead .shot { order: -1; }
    }

    /* Three across, each with its picture on top and its headline under it. */
    .row { display: grid; gap: 18px;
           grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
    .story { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
    .story h3 { margin: 0; font: 600 16px/1.32 var(--display);
                letter-spacing: -.01em; text-wrap: balance; }
    .story .sum { margin: 0; font-size: 13.5px; line-height: 1.5;
                  color: var(--muted); }

    .can-open { cursor: pointer; }
    .can-open:focus-visible { outline: 2px solid var(--focus); outline-offset: 6px;
                              border-radius: 10px; }
    .can-open h2, .can-open h3 { transition: opacity .15s cubic-bezier(.23,1,.32,1); }
    .can-open:hover h2, .can-open:hover h3 { opacity: .7; }

    /* The picture. A 16/9 crop so a row of three lines up whatever shape the
       publishers' own images are, and nothing is laid out around its absence:
       most stories have none and are simply shorter. */
    .shot { width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
            border-radius: 12px; display: block; background: var(--bg-sunken); }
    .lead .shot { aspect-ratio: 4 / 3; border-radius: 14px; }

    .meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
            margin-top: 2px;
            font-size: 12px; color: var(--faint); }
    .meta a { color: var(--faint); text-decoration: none;
              border-bottom: 1px solid transparent; }
    .meta a:hover { color: var(--fg); border-bottom-color: var(--border); }
    .sep { opacity: .5; }
    .why { color: var(--muted); }

    /* --- the rail ------------------------------------------------------ */

    .rail { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .card { border: 1px solid var(--border); border-radius: 14px;
            padding: 16px; background: var(--bg); }
    .card h4 { margin: 0 0 4px; font: 600 14.5px/1.3 var(--display); }
    .card p { margin: 0 0 14px; font-size: 13px; line-height: 1.5;
              color: var(--muted); }

    .picks { display: flex; flex-wrap: wrap; gap: 8px; }
    .pick { font: inherit; font-size: 13px; cursor: pointer;
            border: 1px solid var(--border); border-radius: 999px;
            background: none; color: var(--muted); padding: 7px 13px;
            transition: color .15s cubic-bezier(.23,1,.32,1),
                        border-color .15s cubic-bezier(.23,1,.32,1); }
    .pick:hover { color: var(--fg); border-color: var(--muted); }
    .pick.on { color: var(--fg); border-color: var(--fg); font-weight: 600; }

    /* The weather card: now on the left, the sky on the right, the week
       under both. Numbers are tabular so the forecast row lines up. */
    .wx-top { display: flex; align-items: flex-start; gap: 12px; }
    .wx-now { display: flex; align-items: center; gap: 9px; }
    .wx-now svg { width: 26px; height: 26px; flex: none; color: var(--muted); }
    .wx-deg { font: 600 26px/1 var(--display); letter-spacing: -.02em;
              font-variant-numeric: tabular-nums; }
    .wx-said { margin-left: auto; text-align: right; font-size: 12.5px;
               color: var(--muted); }
    .wx-place { font-size: 12.5px; color: var(--faint); margin-top: 6px; }
    .week { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px;
            margin-top: 14px; padding-top: 14px;
            border-top: 1px solid var(--border); }
    .day { display: flex; flex-direction: column; align-items: center; gap: 5px;
           font-size: 11.5px; color: var(--faint);
           font-variant-numeric: tabular-nums; }
    .day svg { width: 17px; height: 17px; color: var(--muted); }
    .day b { font-weight: 600; font-size: 12.5px; color: var(--fg); }

    .empty { max-width: 60ch; margin: 40px auto; color: var(--muted);
             font-size: 15px; line-height: 1.6; text-align: center; }
    .empty b { color: var(--fg); font-weight: 600; }

    @media (max-width: 640px) {
      .scroll { padding: 18px 16px 40px; }
      .top { padding: 10px 16px; gap: 10px; }
      .when { display: none; }
    }
  `;

  @state() private feeds: DiscoverFeed[] = [];
  @state() private on = "";
  @state() private loading = true;
  @state() private sky: Sky | null = null;

  /* What the route's loader already read, handed in by the console.
   *
   * The point is the FIRST PAINT. Discover is the page a link lands on and
   * the page a crawler reads, and both used to get an empty column while the
   * browser asked for the feeds — a spinner where the news should be, on the
   * one screen whose whole job is to have news on it. The loader reads the
   * same public route this element would, so the server can render the real
   * thing and this element then refreshes it in the background. */
  @property({ attribute: false }) seed: DiscoverFeed[] | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this.load();
    void this.loadSky();
  }

  /* Take the seed before the first render — on the server too, where
     `connectedCallback` never runs. Guarded, because `willUpdate` fires on
     every property change and a re-seed would throw away a topic the reader
     has since chosen. */
  private tookSeed = false;
  willUpdate(): void {
    if (this.tookSeed || this.seed === null || this.seed.length === 0) { return; }
    this.tookSeed = true;
    this.feeds = this.seed;
    this.loading = false;
    if (this.on === "") { this.on = this.seed[0].id; }
  }

  /* The weather where the reader is.
   *
   * The city comes from the browser's own TIME ZONE and not from their IP.
   * "Africa/Tunis" says Tunis, "America/New_York" says New York, and the
   * browser hands it over without anybody being located: no address is looked
   * up, nothing is asked of a third party, and a reader behind a VPN gets the
   * weather where their clock is, which is the honest answer to a question
   * nobody asked precisely.
   *
   * The proxy does the rest (server/weather-proxy.ts), so this fetch goes to
   * our own origin. A 204 — no such city, upstream down — leaves `sky` null
   * and the card simply is not there. A front page must not carry a box
   * apologising for the weather. */
  private async loadSky() {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
      const city = zone.split("/").pop()?.replace(/_/g, " ") ?? "";
      if (city === "") return;
      const answer = await fetch(`/weather?city=${encodeURIComponent(city)}`);
      if (answer.status !== 200) return;
      this.sky = await answer.json() as Sky;
    } catch {
      /* no weather is a fine amount of weather to have */
    }
  }

  private async load() {
    // The browser's own language, narrowed to the code the index uses. No
    // country: the console does not know where somebody is and guessing from
    // a locale is how a French reader in Tunisia gets a feed about France.
    const lang = (navigator.language ?? "").slice(0, 2).toLowerCase();
    let got = await listDiscover(lang).catch(() => []);
    if (got.length === 0 && lang !== "") {
      // Nothing in their language yet — the worldwide feeds are better than an
      // empty page, and the engine already falls back, so an empty answer here
      // means there is genuinely nothing.
      got = await listDiscover().catch(() => []);
    }
    // Never replace a seeded feed with nothing: a failed refresh must cost
    // freshness, not the page.
    if (got.length > 0 || this.feeds.length === 0) { this.feeds = got; }
    if (this.on === "" && this.feeds.length > 0) { this.on = this.feeds[0].id; }
    this.loading = false;
  }

  private shown(): DiscoverFeed | null {
    return this.feeds.find((f) => f.id === this.on) ?? this.feeds[0] ?? null;
  }

  /** A story's sources, named where there are few and counted where there are
   *  many. Under four, a reader learns more from the hosts than from a number;
   *  past that the names stop fitting and the count is the fact. */
  private credit(story: DiscoverStory) {
    const urls = story.sources.split("\n").map((u) => u.trim()).filter((u) => u !== "");
    if (urls.length === 0) return nothing;
    if (urls.length > 3) return html`<span>${urls.length} sources</span>`;
    // `stopPropagation` because the card around this is clickable: without it,
    // following a source would ALSO open the article behind the new tab.
    return html`${urls.map((u, i) => html`
      ${i === 0 ? nothing : html`<span class="sep">·</span>`}
      <a href=${u} target="_blank" rel="noopener noreferrer"
        @click=${(e: Event) => e.stopPropagation()}>${host(u)}</a>`)}`;
  }

  /* Open one. An event rather than a navigation, because Discover is a view
   * inside the console: moving between two of its own screens must not throw
   * away the shell and reload everything. */
  private open(s: DiscoverStory) {
    if (!s.hasBody) return;
    this.dispatchEvent(new CustomEvent("open-article", {
      detail: { id: s.id }, bubbles: true, composed: true,
    }));
  }

  /* The picture, from this origin.
   *
   * Never the publisher's own url: an img pointed at a third party is the
   * reader's browser announcing itself to a site they did not choose to
   * visit, once per card they scroll past. The proxy fetches it once, caches
   * it, and answers 204 when there is nothing — server/image-proxy.ts. */
  private shot(s: DiscoverStory) {
    if (s.image === "") return nothing;
    return html`<img class="shot"
      src=${`/img/story/${encodeURIComponent(s.id)}`} alt="" loading="lazy"
      @error=${(e: Event) => { (e.target as HTMLElement).style.display = "none"; }}>`;
  }

  private line(s: DiscoverStory) {
    return html`
      <div class="meta">
        <span>${ago(s.fetchedAt)} · fetched</span>
        <span class="sep">·</span>
        ${this.credit(s)}
        ${s.why.trim() === "" ? nothing : html`
          <span class="sep">·</span><span class="why">${s.why}</span>`}
      </div>`;
  }

  private hooks(s: DiscoverStory) {
    return {
      role: s.hasBody ? "button" : "article",
      tab: s.hasBody ? "0" : "-1",
      key: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.open(s); }
      },
    };
  }

  /* The lead. Words left, picture right — and the picture is the smaller half
   * on purpose: this is a story you read the first sentence of. With no
   * picture the text simply takes the width, which is the common case. */
  private lead(s: DiscoverStory) {
    const h = this.hooks(s);
    const cls = "lead" + (s.hasBody ? " can-open" : "") + (s.image === "" ? " noshot" : "");
    return html`
      <div class=${cls} role=${h.role} tabindex=${h.tab}
        @click=${() => this.open(s)} @keydown=${h.key}>
        <div>
          <h2>${s.headline}</h2>
          <p class="sum">${s.summary}</p>
          ${this.line(s)}
        </div>
        ${this.shot(s)}
      </div>`;
  }

  private story(s: DiscoverStory) {
    const h = this.hooks(s);
    return html`
      <div class=${s.hasBody ? "story can-open" : "story"}
        role=${h.role} tabindex=${h.tab}
        @click=${() => this.open(s)} @keydown=${h.key}>
        ${this.shot(s)}
        <h3>${s.headline}</h3>
        <p class="sum">${s.summary}</p>
        ${this.line(s)}
      </div>`;
  }

  /* The weather card, or nothing at all.
   *
   * Nothing at all is a real answer and the common one on a box that cannot
   * reach the internet: no city in the time zone, an upstream that is down, a
   * geocoder that does not know the place. None of those is worth a card
   * explaining itself, so the card is simply absent. */
  private weather() {
    const w = this.sky;
    if (w === null) return nothing;
    const now = sky(w.code, w.day);
    return html`
      <div class="card">
        <div class="wx-top">
          <div class="wx-now">
            ${glyph(now)}
            <span class="wx-deg">${w.temperature}°</span>
          </div>
          <div class="wx-said">
            ${now.word}
            ${w.high === null || w.low === null ? nothing : html`
              <div class="wx-place">H: ${w.high}° L: ${w.low}°</div>`}
          </div>
        </div>
        <div class="wx-place">${w.city}</div>
        ${w.week.length === 0 ? nothing : html`
          <div class="week">
            ${w.week.map((d) => html`
              <div class="day">
                <span>${d.day}</span>
                ${glyph(sky(d.code, true))}
                <b>${d.high}°</b>
              </div>`)}
          </div>`}
      </div>`;
  }

  /* The topic picker, in the rail.
   *
   * The same feeds the tabs above offer, in the place a reader looks for
   * "make this mine". It does NOT pretend to save a preference: there is no
   * per-person Discover yet, and a Save button that stored nothing would be
   * the one dishonest control on the page. It switches the feed, which is
   * what it looks like it does. */
  private topics() {
    if (this.feeds.length < 2) return nothing;
    return html`
      <div class="card">
        <h4>Topics</h4>
        <p>What the crawl is digesting. Pick one to read it.</p>
        <div class="picks">
          ${this.feeds.map((f) => html`
            <button class=${f.id === this.on ? "pick on" : "pick"}
              @click=${() => { this.on = f.id; }}>${f.topic}</button>`)}
        </div>
      </div>`;
  }

  render() {
    const feed = this.shown();
    const stories = feed?.stories ?? [];
    return html`
      <div class="top">
        <span class="brand">Discover</span>
        <div class="tabs">
          ${this.feeds.map((f) => html`
            <button class=${f.id === this.on ? "tab on" : "tab"}
              @click=${() => { this.on = f.id; }}>${f.topic}</button>`)}
        </div>
        ${feed === null || feed.digestedAt === "" ? nothing : html`
          <span class="when">Digested ${ago(new Date(Number(feed.digestedAt)).toISOString())}</span>`}
      </div>

      <div class="scroll">
        ${this.loading
          ? html`<p class="empty">Reading the index…</p>`
          : stories.length === 0
            ? html`<p class="empty">Nothing digested yet. Discover is written by a
                background pass over the crawl, so it fills in on its own
                schedule rather than when you open it — <b>check back shortly</b>.</p>`
            : html`
              <div class="page">
                <div class="feed">
                  ${this.lead(stories[0])}
                  ${stories.length < 2 ? nothing : html`
                    <div class="row">
                      ${stories.slice(1).map((s) => this.story(s))}
                    </div>`}
                </div>
                <aside class="rail">
                  ${this.weather()}
                  ${this.topics()}
                </aside>
              </div>`}
      </div>
    `;
  }
}

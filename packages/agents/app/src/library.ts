// Everything this person has made, in one place.
//
// The artifact panel beside a conversation answers "what does THIS one hold".
// This answers "what have I made" — the question somebody asks when they
// remember a document and not which conversation produced it, which is the
// ordinary case a week later. Same rows, different question, and the second
// one has no home until there is a library.
//
// A PAGE and not an overlay, and the reason is the same one that moved
// Settings onto a route: this is a destination. You browse it, search it,
// leave it and come back, and you want to be able to link somebody to it. An
// overlay can do none of those — no address, no Back, no reload — and it
// would be a modal covering the conversation it is meant to be independent
// of. The directory overlay next door is the counter-example that proves the
// rule: it is for picking something mid-sentence, so it must not take the
// screen away from what you were writing.
//
// The search is client-side over what the engine already sent. A library of a
// few hundred cards fits in one answer, and a round trip per keystroke would
// buy nothing but latency — when it stops fitting, the cap in libraryFor is
// the thing that has to change first, and the engine will say so by returning
// exactly the cap.

import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ArtifactCard, listLibrary } from "./api.js";

/** A file's kind, as a word a person recognises rather than a mime type. */
function kindWord(kind: string): string {
  if (kind === "markdown") return "Markdown";
  if (kind === "html") return "Page";
  if (kind === "code") return "Code";
  if (kind === "sheet" || kind === "xlsx") return "Sheet";
  if (kind === "docx") return "Document";
  if (kind === "pptx") return "Slides";
  if (kind === "pdf") return "PDF";
  if (kind === "image") return "Image";
  return kind === "" ? "File" : kind;
}

/** When, in the words a person uses for it. */
function when(stamp: string): string {
  const ms = Number(stamp);
  if (!isFinite(ms) || ms <= 0) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

@customElement("artifact-library")
export class ArtifactLibrary extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0;
            background: var(--bg-chat, var(--bg)); }

    .top { padding: 22px 24px 14px; display: flex; flex-direction: column; gap: 14px; }
    h1 { margin: 0; font: 600 22px/1.2 var(--display); letter-spacing: -.01em; }
    .lede { margin: 0; color: var(--muted); font-size: 14px; max-width: 62ch; }

    /* The search field, the shape the rest of the console gives a field. */
    .find { display: flex; align-items: center; gap: 10px;
            border: 1px solid var(--border); border-radius: 12px;
            padding: 10px 14px; background: var(--bg); }
    .find:focus-within { border-color: var(--muted); }
    .find input { flex: 1; min-width: 0; border: 0; background: none; padding: 0;
                  font: inherit; font-size: 14.5px; color: inherit; outline: none; }
    .find nr-icon { color: var(--muted); flex: none; }

    .grid { flex: 1; min-height: 0; overflow-y: auto;
            padding: 4px 24px 28px;
            display: grid; gap: 14px;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            align-content: start; }

    /* A card is its own first page, then its name. The preview carries the
       text because that is what tells two briefs apart — a row of identical
       file glyphs tells you nothing you did not already know.
       A div and not a button, with the role and the key handling put back by
       hand. As a button it collapsed to its two borders — 2px tall with
       children measuring 29 and 68 overflowing out of it — because a button's
       content is laid out in an anonymous box that does not become the flex
       container the rule asks for. The role and tabindex give a screen reader
       and the keyboard everything the element gave up. */
    /* No overflow:hidden here, and that is the fix rather than a preference.
       An element that clips its overflow contributes ZERO to intrinsic
       sizing in the block axis, so the grid sized every row to the card's two
       borders, grid-template-rows reading 2px for every one, and the 161px preview
       inside spilled out of a 2px box. The corners are clipped on the
       children instead, which is the same picture and costs the row nothing. */
    .card { display: flex; flex-direction: column; text-align: left;
            border: 1px solid var(--border); border-radius: 14px;
            background: var(--bg); cursor: pointer;
            font: inherit; color: inherit; padding: 0;
            transition: border-color .15s cubic-bezier(.23,1,.32,1),
                        transform .15s cubic-bezier(.23,1,.32,1); }
    .card:hover { border-color: var(--muted); transform: translateY(-1px); }
    .card:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    /* flex: none on both children, and this is the whole bug rather than a
       tidy-up. The card is a column flex container, so its children are flex
       items and shrink by default; the grid row sizes itself to the item, the
       item sizes itself to its content, and with shrinking allowed the two
       resolved each other to nothing — a card 2px tall, its two borders, with
       a 132px preview squeezed to 1px inside it. Refusing to shrink breaks
       the circle: the preview keeps its height, the card adds it up, and the
       row is that tall. */
    .peek { flex: none;
            height: 132px; padding: 14px 16px; overflow: hidden;
            border-radius: 13px 13px 0 0;
            border-bottom: 1px solid var(--border);
            font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
            color: var(--muted); white-space: pre-wrap; word-break: break-word;
            /* Faded at the foot rather than cut: a hard edge mid-letter reads
               as a rendering fault, a fade reads as "there is more". */
            -webkit-mask-image: linear-gradient(#000 60%, transparent);
            mask-image: linear-gradient(#000 60%, transparent); }
    .peek.none { display: grid; place-items: center; color: var(--faint);
                 -webkit-mask-image: none; mask-image: none; }

    .body { flex: none;
            padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 4px;
            border-radius: 0 0 13px 13px; }
    .name { font-size: 14.5px; font-weight: 600; line-height: 1.35;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { font-size: 12px; color: var(--muted);
            display: flex; align-items: center; gap: 6px; }
    .dot { opacity: .5; }

    .empty { padding: 40px 24px; color: var(--muted); font-size: 14px; }
  `;

  @state() private cards: ArtifactCard[] = [];
  @state() private find = "";
  @state() private loading = true;

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.cards = await listLibrary().catch(() => []);
    this.loading = false;
  }

  /* Matched on the name AND the text.
   *
   * Half of what anybody remembers about a document is a phrase inside it
   * rather than what it was called — the excerpt is already here, so a search
   * that ignored it would be withholding an answer it is holding. */
  private shown(): ArtifactCard[] {
    const q = this.find.trim().toLowerCase();
    if (q === "") return this.cards;
    return this.cards.filter((c) =>
      (c.title + " " + c.path + " " + c.excerpt).toLowerCase().includes(q));
  }

  private open(card: ArtifactCard) {
    // To the conversation that holds it, with the artifact named in the
    // address — the console opens its panel on that path. A library that
    // could only tell you a file exists would be a catalogue, not a way in.
    location.assign(`/c/${card.threadId}?open=${encodeURIComponent(card.path)}`);
  }

  render() {
    const rows = this.shown();
    return html`
      <div class="top">
        <h1>Artifacts</h1>
        <p class="lede">Everything you have made, across every conversation.
          Search runs over the names and the text inside.</p>
        <label class="find">
          <nr-icon name="search" size="small"></nr-icon>
          <input type="text" .value=${this.find} placeholder="Search artifacts…"
            aria-label="Search artifacts"
            @input=${(e: Event) => { this.find = (e.target as HTMLInputElement).value; }}>
        </label>
      </div>

      ${this.loading ? html`<p class="empty">Reading your files…</p>`
        : this.cards.length === 0
          ? html`<p class="empty">Nothing yet. Files an agent saves in a
              conversation are collected here.</p>`
          : rows.length === 0
            ? html`<p class="empty">Nothing matches “${this.find.trim()}”.</p>`
            : html`<div class="grid">
                ${rows.map((c) => html`
                  <div class="card" role="button" tabindex="0"
                    title=${c.path}
                    @click=${() => this.open(c)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        this.open(c);
                      }
                    }}>
                    ${c.excerpt.trim() === ""
                      ? html`<div class="peek none">
                          <nr-icon name="file" size="medium"></nr-icon></div>`
                      : html`<div class="peek">${c.excerpt}</div>`}
                    <div class="body">
                      <span class="name">${c.title === "" ? c.path : c.title}</span>
                      <span class="meta">
                        <span>${kindWord(c.kind)}</span>
                        <span class="dot">·</span>
                        <span>v${c.currentVersion}</span>
                        ${when(c.updatedAt) === "" ? nothing : html`
                          <span class="dot">·</span><span>${when(c.updatedAt)}</span>`}
                      </span>
                    </div>
                  </div>`)}
              </div>`}
    `;
  }
}

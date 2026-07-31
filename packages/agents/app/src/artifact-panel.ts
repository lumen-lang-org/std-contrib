// The rail's other half: what the conversation produced. A workspace file is
// state the agent rewrites while it works; an artifact is a result — addressed
// by a path, with every version it ever had still readable.
//
// This file has one rule, and it is the reason the feature exists: a body here
// was written by a model, and it never becomes part of this document. It is
// loaded from the preview URL into a sandboxed iframe, which is a document of
// its own with its own origin. `srcdoc`, a `data:` URI and unsafeHTML all
// inherit *this* origin instead — the console's session, and through /api
// every agent, every document and every key envelope reference in the
// database. The three are not stylistic alternatives to the src attribute
// below; they are the whole attack the preview host exists to contain.
//
// The panel opens at 320px because the rail does, and is resizable from its
// left edge — a page preview at 320px is a keyhole. The width a person drags
// it to is kept in localStorage, so it is a preference, not a per-visit fight.
// Reading an artifact properly still happens in a tab of its own, which is
// what the expand button is for.

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  ArtifactListing, ArtifactVersion, deleteArtifact, listArtifacts, previewUrl,
  readArtifactVersion, rotateArtifact, uploadFileArtifact,
  WorkspaceFile, listFiles, readFile,
} from "./api.js";
import { DiffRow, diffCounts, diffLines } from "./diff.js";
import * as live from "./live.js";
import { officeKind, renderOffice } from "./office-view.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import hljs from "highlight.js/lib/core";
import hljsJson from "highlight.js/lib/languages/json";

// JSON only, deliberately: it is what docflows are, its tokens never span
// lines (so a per-line highlight cannot tear one), and hljs escapes every
// character of the source — the spans below are hljs's own wrappers around
// escaped text, which keeps the panel's never-execute-a-body rule intact.
hljs.registerLanguage("json", hljsJson);

function jsonLine(text: string) {
  if (text === "") return text;
  try {
    return unsafeHTML(hljs.highlight(text, { language: "json", ignoreIllegals: true }).value);
  } catch {
    return text;
  }
}

// The kinds a browser can be trusted to render, given the sandbox. Everything
// else — markdown, json, source, plain text — is text, and text is read as
// text: a <pre> says what the bytes are without asking a parser what they mean.
function embeds(kind: string): boolean {
  // An image artifact is base64 text in the store; the preview route wraps it
  // in a page, so the iframe is how it becomes visible here too.
  return kind === "html" || kind === "svg" || kind === "image";
}

@customElement("artifact-panel")
export class ArtifactPanel extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; width: 320px;
            background: var(--bg-rail); border-left: 1px solid var(--border);
            position: relative; }
    /* The left edge is the handle. Wider than the border it sits on, because a
       1px target is not a target; the visible affordance is the cursor. */
    .grip { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px;
            cursor: col-resize; z-index: 2; }
    .grip:hover, .grip.active { background: var(--accent); opacity: 0.35; }
    /* While a drag is live the iframe must not swallow the pointer — it is a
       separate document, and a pointermove that crosses into it never comes
       back to this one. */
    :host(.resizing) iframe { pointer-events: none; }
    h3 { margin: 0; padding: 16px 16px 8px; font-size: 12px; text-transform: uppercase;
         letter-spacing: 0.06em; color: var(--muted); display: flex; align-items: center;
         justify-content: space-between; gap: 8px; }
    .list { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
    .artifact { padding: 8px 12px; cursor: pointer; font-size: 13.5px; border-radius: 12px;
                transition: background-color .15s cubic-bezier(.23,1,.32,1); }
    .artifact:hover { background: var(--bg-user); }
    .artifact .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .artifact .meta { color: var(--muted); font-size: 11.5px; }
    .none { padding: 16px; color: var(--muted); font-size: 13px; }

    .view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 12px 8px;
            position: relative; }
    /* The kebab menu, anchored to the head. A backdrop rather than a document
       listener: the panel lives in a shadow root, and a click anywhere should
       close the menu without this code reaching outside its own tree. */
    .menu-backdrop { position: fixed; inset: 0; z-index: 25; }
    .kebab { position: absolute; right: 40px; top: 40px; z-index: 30; min-width: 176px;
             background: var(--bg-card); border: 1px solid var(--border);
             border-radius: 12px; padding: 4px;
             box-shadow: 0 4px 12px rgba(0,0,0,.06), 0 10px 28px -8px rgba(0,0,0,.18); }
    .kebab button { display: flex; align-items: center; gap: 10px; width: 100%;
                    padding: 8px 12px; border: 0; background: none; cursor: pointer;
                    font: inherit; font-size: 13.5px; color: var(--fg);
                    border-radius: 8px; text-align: left; }
    .kebab button:hover { background: var(--bg-user); }
    .kebab button[disabled] { opacity: .45; cursor: default; }
    .kebab button.danger { color: var(--danger, #a8321f); }
    .head .name { flex: 1; min-width: 0; font: 600 14px var(--display);
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head .meta { color: var(--muted); font-size: 11.5px; font-weight: 400;
                  font-family: var(--mono); }
    /* The frame is a separate document. It gets a border and nothing else —
       no styling of ours reaches inside it, and none of its reaches out. */
    iframe { flex: 1; min-height: 0; width: auto; margin: 0 12px; border: 1px solid var(--border);
             border-radius: 8px; background: #FFFFFF; }
    pre { flex: 1; overflow: auto; margin: 0 12px; padding: 12px; font: 12.5px/1.55 var(--mono);
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
    .loading { flex: 1; display: grid; place-items: center; color: var(--muted); font-size: 13px; }

    .versions { padding: 10px 12px 0; }
    .versions .label { color: var(--muted); font-size: 11.5px; text-transform: uppercase;
                       letter-spacing: 0.06em; margin-bottom: 6px; }
    .versions .row { display: flex; flex-wrap: wrap; gap: 6px; }
    .v { border: 1px solid var(--border); background: var(--bg-card); color: var(--muted);
         border-radius: 999px; padding: 2px 10px; font: 12px var(--mono); cursor: pointer; }
    .v:hover { border-color: var(--accent); color: var(--fg); }
    .v[aria-current="true"] { background: var(--accent); border-color: var(--accent);
                              color: var(--accent-fg); }
    .note { color: var(--muted); font-size: 12px; padding: 8px 12px 0; }

    .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px; }
    nr-button { font-size: 12.5px; }
    .problem { color: var(--danger); font-size: 12.5px; padding: 0 12px 12px; }
    .said { color: var(--ok); font-size: 12.5px; padding: 0 12px 12px; }

    /* The diff replaces the <pre>, one row per line. The colours are the
       same pair the chat's edit cards use, so "added" and "removed" look the
       same everywhere a change is shown. */
    .diff { flex: 1; overflow: auto; margin: 0 12px; font: 12px/1.5 var(--mono);
            background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; }
    .diff .r { display: flex; align-items: baseline; }
    .diff .g { flex: none; width: 18px; text-align: center; user-select: none; color: var(--muted); }
    .diff .t { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; padding-right: 8px; }
    /* Line numbers: the old version's and the new version's, side by side —
       a deleted row has only the first, an added row only the second. */
    .diff .n, .pre .n { flex: none; min-width: 30px; padding: 0 6px 0 4px; text-align: right;
           user-select: none; color: var(--muted); opacity: 0.7;
           font-variant-numeric: tabular-nums; font-size: 11px; }
    .pre { flex: 1; overflow: auto; margin: 0 12px; font: 12.5px/1.55 var(--mono);
           background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
           padding: 8px 0; }
    /* The document browsers. White on purpose, whatever the theme: a page of
       a Word file or a sheet of numbers is its own artefact, not console
       chrome, and reads as the document it is on paper-white. Two columns:
       the nav rail (pages or sheets) and the document. */
    .office { flex: 1; display: flex; min-height: 0; margin: 0 12px; background: #fff; color: #111;
              border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .office .office-nav { flex: none; width: 116px; overflow-y: auto; padding: 8px;
              display: flex; flex-direction: column; gap: 8px; align-items: center;
              background: #f7f7f6; border-right: 1px solid #e5e5e3; }
    .office .office-nav button { border: 1px solid transparent; background: none; text-align: left;
              border-radius: 8px; padding: 5px 10px; font: 12px var(--sans, sans-serif); width: 100%;
              color: #444; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .office .office-nav button:hover { background: #ededeb; }
    .office .office-nav button[aria-current="true"] { background: #111; color: #fff; }
    /* A page's miniature: the page itself at ~10%, boxed, numbered. The
       current one wears the ink ring the text entries wear as background. */
    .office .office-nav button.thumb { padding: 0; width: auto; background: none; position: relative;
              border-radius: 4px; border: 2px solid transparent; flex: none; }
    .office .office-nav button.thumb:hover { border-color: #bbb; background: none; }
    .office .office-nav button.thumb[aria-current="true"] { border-color: #111; background: none; }
    .office .thumb-port { width: 92px; overflow: hidden; background: #fff;
              box-shadow: 0 0 0 1px #e0e0de; border-radius: 3px; }
    .office .thumb-tag { position: absolute; right: 3px; bottom: 3px; background: #111c;
              color: #fff; font: 10px/1 var(--sans, sans-serif); padding: 2px 5px; border-radius: 6px; }
    .office .office-doc { flex: 1; min-width: 0; overflow: auto; padding: 10px; }
    /* docx-preview lays pages out at the document's own paper width; in a
       side panel that clips. Fluid pages keep every word readable at any
       panel width — page boundaries stay (the rail still navigates them),
       only the paper metaphor relaxes. */
    .office .office-doc .docx-wrapper { background: none !important; padding: 0 !important; }
    /* A page keeps paper's proportion however little it says: width from
       the column, height at least A4's ratio of it, growing only when the
       text needs more. Short pages read as pages, not as strips. */
    .office .office-doc .docx-wrapper > section.docx { width: auto !important; min-height: 0 !important;
              aspect-ratio: 210 / 297; height: auto;
              padding: 28px 32px !important; margin-bottom: 12px;
              background: #fff; box-shadow: 0 1px 3px #00000014, 0 0 0 1px #e5e5e3; }
    /* Slides keep their aspect but never exceed the column. */
    .office .office-doc .pptx-preview-wrapper { width: 100% !important; background: none !important; }
    .office .office-doc .pptx-preview-slide-wrapper { max-width: 100%; background: #fff;
              box-shadow: 0 0 0 1px #e5e5e3; margin: 0 auto 10px; overflow: hidden; }
    .office table { border-collapse: collapse; font: 12px/1.5 var(--mono); }
    .office td { border: 1px solid #e3e3e3; padding: 2px 8px; max-width: 380px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .office tr:first-child td { background: #f7f7f7; font-weight: 600; position: sticky; top: 0; }
    .office .sheet-cut { padding: 8px; color: #777; font: 11.5px var(--sans, sans-serif); }
    .pre .r { display: flex; align-items: baseline; }
    .pre .t { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; padding-right: 10px; }
    .diff .r.add { background: rgba(47, 138, 76, 0.10); }
    .diff .r.add .g { color: #2f8a4c; }
    .diff .r.del { background: rgba(179, 56, 46, 0.10); }
    .diff .r.del .g { color: #b3382e; }
    /* Sticky, and above the rows it floats over: without the z-index the
       scrolled lines paint through it, numbers bleeding into the tally. The
       tint separates it from the body the way the console's own headers do. */
    .diff .tally { position: sticky; top: 0; z-index: 2;
                   background: var(--bg-rail, var(--bg-card));
                   border-bottom: 1px solid var(--border); padding: 5px 10px 5px 8px;
                   font-size: 11.5px; color: var(--muted);
                   display: flex; align-items: center; gap: 8px; }
    .diff .tally > span:first-child { flex: 1; min-width: 0; }
    .diff .tally b.plus { color: #2f8a4c; } .diff .tally b.minus { color: #b3382e; }
    .diff .nav { display: flex; gap: 2px; flex: none; }
    .hop { display: grid; place-items: center; width: 22px; height: 22px;
           border: none; border-radius: 6px; background: transparent;
           color: var(--muted); cursor: pointer; padding: 0; }
    .hop:hover { background: var(--bg-hover, rgba(127, 127, 127, 0.12)); color: var(--fg); }
    .hop:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    /* The base picker sits in the tally as a word, not a widget: same type,
       same colour, a border only on hover. */
    .base { font: inherit; color: inherit; background: transparent; border: none;
            padding: 0 2px; cursor: pointer; border-radius: 4px; }
    .base:hover { background: var(--bg-hover, rgba(127, 127, 127, 0.12)); }

    /* JSON tokens, on the console's own palette. hljs wraps escaped text;
       these only colour what it wrapped. */
    .hljs-attr { color: var(--accent, #4a5aef); }
    .hljs-string { color: #2f8a4c; }
    .hljs-number, .hljs-literal { color: #a3512e; }
    .hljs-punctuation { color: var(--muted); }

    /* --- the tree (Kimi's All files, in this palette) -------------------- */
    .row { display: flex; align-items: center; gap: 12px; padding: 7px 10px;
           border-radius: 10px; cursor: pointer; }
    .row:hover { background: var(--bg-user); }
    .tile { width: 38px; height: 38px; flex: none; display: grid; place-items: center;
            border: 1px solid var(--border); border-radius: 11px;
            color: var(--muted); background: var(--bg-card); }
    .row .fbody { flex: 1; min-width: 0; }
    .fname { font-size: 14px; color: var(--fg); overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }
    .fmeta { font-size: 12px; color: var(--muted); margin-top: 1px; }
    .chev { color: var(--muted); flex: none; }
    .indent { margin-left: 26px; }
    .sect { margin: 10px 16px 2px; font-size: 11.5px; text-transform: uppercase;
            letter-spacing: 0.06em; color: var(--muted); }
    .wsread { flex: 1; overflow: auto; margin: 8px; padding: 12px; font-size: 12.5px;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 8px; white-space: pre-wrap; }
  `;

  @property() threadId = "";

  // --- width -----------------------------------------------------------------
  // Dragged from the left edge, clamped so it can neither vanish nor eat the
  // conversation, and remembered across visits.
  private static readonly WIDTH_KEY = "artifact-panel-width";
  private static readonly WIDTH_MIN = 260;
  @state() private panelWidth = ArtifactPanel.readWidth();

  private static readonly widthMax = () => Math.max(ArtifactPanel.WIDTH_MIN, Math.floor(window.innerWidth * 0.7));

  private static clampWidth(w: number): number {
    return Math.min(Math.max(w, ArtifactPanel.WIDTH_MIN), ArtifactPanel.widthMax());
  }

  private static readWidth(): number {
    const kept = Number(localStorage.getItem(ArtifactPanel.WIDTH_KEY) ?? "320");
    return ArtifactPanel.clampWidth(Number.isFinite(kept) ? kept : 320);
  }

  @state() private resizing = false;
  private dragFromX = 0;
  private dragFromW = 0;

  private beginResize(e: PointerEvent) {
    this.dragFromX = e.clientX;
    this.dragFromW = this.panelWidth;
    this.resizing = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private moveResize(e: PointerEvent) {
    if (!this.resizing) return;
    // The handle is the left edge: moving the pointer left grows the panel.
    this.panelWidth = ArtifactPanel.clampWidth(this.dragFromW + (this.dragFromX - e.clientX));
  }

  private endResize() {
    if (!this.resizing) return;
    this.resizing = false;
    localStorage.setItem(ArtifactPanel.WIDTH_KEY, `${this.panelWidth}`);
  }

  // A double-click on the handle goes back to the rail's own width.
  private resetWidth() {
    this.panelWidth = 320;
    localStorage.setItem(ArtifactPanel.WIDTH_KEY, "320");
  }

  protected willUpdate() {
    // The dragged width is a desktop affordance. Below the breakpoint the
    // panel is the screen — the stylesheet says 100vw — and an inline width
    // beats a stylesheet, so writing one here left a 309px panel on a 440px
    // phone and starved the document host to 149px, which is what made a
    // page render three words wide. Nothing inline under 1024; the CSS wins.
    if (window.innerWidth > 1024) {
      this.style.width = `${this.panelWidth}px`;
    } else {
      this.style.removeProperty("width");
    }
    this.classList.toggle("resizing", this.resizing);
  }

  private grip() {
    return html`<div class=${this.resizing ? "grip active" : "grip"}
      @pointerdown=${(e: PointerEvent) => this.beginResize(e)}
      @pointermove=${(e: PointerEvent) => this.moveResize(e)}
      @pointerup=${() => this.endResize()}
      @pointercancel=${() => this.endResize()}
      @dblclick=${() => this.resetWidth()}></div>`;
  }

  @state() private artifacts: ArtifactListing[] = [];
  /* The conversation's workspace files, in the same rail. One panel, because
     a person asking "what did this conversation produce" should not have to
     know which of two buttons the answer is behind — Kimi's "All files" is
     the model: one tree, folders first, sizes and kinds on the rows. */
  @state() private wsFiles: WorkspaceFile[] = [];
  @state() private wsOpen = "";
  @state() private wsContent = "";
  /* Folders the reader closed. Paths, not names: two folders may share a
     name at different depths. Everything starts open, as Kimi does. */
  @state() private folded = new Set<string>();
  // The artifact being read, and the version of it on screen. Two pieces of
  // state and not one: the frame is pinned to a version number, and the row
  // carries the token that number is addressed through.
  @state() private open: ArtifactListing | null = null;
  @state() private shown: ArtifactVersion | null = null;
  // Rotate and delete both destroy something that cannot be recovered — a link
  // somebody is holding, a history nothing else has — so each takes two
  // clicks. "" when neither is armed.
  @state() private arming = "";
  /* The kebab, open or not. Armed actions live inside it, so it must survive
     the first click of a two-click action: Delete shows "Delete all
     versions?" in place, and closing the menu between the two clicks would
     disarm by navigation, which is the arming rule working as intended. */
  @state() private menuOpen = false;
  @state() private problem = "";
  @state() private said = "";
  // The diff of the shown version against the one before it, or null when
  // the panel is showing content. Cleared by every navigation, so the toggle
  // never survives into a version it was not computed for.
  @state() private diff: DiffRow[] | null = null;

  async updated(changed: Map<string, unknown>) {
    if (changed.has("threadId")) {
      this.close();
      await this.refresh();
    }
    await this.drawOffice();
  }

  // Which slot:version the office host currently shows, so a Lit re-render
  // does not re-parse the same document. Rendering is async and happens
  // after the template put the empty host in the DOM.
  private officeShown = "";

  private async drawOffice() {
    const a = this.open;
    const v = this.shown;
    if (a === null || v === null) { this.officeShown = ""; return; }
    const kind = officeKind(a.path);
    const host = this.renderRoot.querySelector<HTMLElement>("#office-host");
    if (kind === null || host === null) { this.officeShown = ""; return; }
    const key = `${a.slot}:${v.version}`;
    if (this.officeShown === key) return;
    this.officeShown = key;
    try {
      await renderOffice(host, kind, v.content);
    } catch (e) {
      this.officeShown = "";
      this.problem = (e as Error).message;
    }
  }

  // The rail stays current on its own. A conversation produces artifacts
  // while the panel is open — a round's writes, a script's reconcile — and a
  // list that only moved when the thread changed sat on "nothing produced
  // yet" through all of it.
  //
  // The listing is pushed now; this timer is the fallback for when it is not
  // (a socket that never opened, or a feed that stopped). Same 4 seconds, same work,
  // skipped whenever the pushes are arriving. It stops the moment the panel
  // leaves the DOM — and so does the listener beside it.
  private ticker: ReturnType<typeof setInterval> | null = null;
  private unlisten: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.unlisten = live.on("artifacts", ({ threadId, artifacts }) => {
      if (threadId !== this.threadId) return;
      void this.adopt(artifacts);
    });
    this.ticker = setInterval(() => { void this.tick(); }, 4000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.ticker !== null) { clearInterval(this.ticker); this.ticker = null; }
    if (this.unlisten !== null) { this.unlisten(); this.unlisten = null; }
  }

  private async tick() {
    if (this.threadId === "") return;
    if (live.fresh()) return;
    await this.refresh();
    await this.followOpen();
  }

  async refresh() {
    if (this.threadId === "") {
      this.artifacts = [];
      this.wsFiles = [];
      return;
    }
    // Both halves of the tree; neither may take the other down with it.
    this.wsFiles = await listFiles(this.threadId).catch(() => [] as WorkspaceFile[]);
    const listed = await listArtifacts(this.threadId).catch(() => [] as ArtifactListing[]);
    this.sortInto(listed);
  }

  // A listing that arrived rather than one that was asked for. Everything
  // after the fetch is the same, which is the point of splitting it out.
  private async adopt(listed: ArtifactListing[]) {
    this.sortInto(listed);
    await this.followOpen();
  }

  private sortInto(listed: ArtifactListing[]) {
    // The API answers in slot order, which is creation order. Newest first is
    // what a rail wants — and by the clock rather than by slot, so an artifact
    // saved again rises to the top the way a conversation does.
    this.artifacts = [...listed].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || b.slot - a.slot);
  }

  // The artifact being read moved on: follow its pointer so the pills and
  // the preview show the version that now exists, not the one from when it
  // was opened.
  private async followOpen() {
    if (this.open === null) return;
    const fresh = this.artifacts.find((a) => a.slot === this.open!.slot);
    if (fresh && fresh.version !== this.open.version) {
      this.open = fresh;
      await this.show(fresh, fresh.version);
    }
  }

  private close() {
    this.menuOpen = false;
    this.open = null;
    this.shown = null;
    this.wsOpen = "";
    this.arming = "";
    this.problem = "";
    this.said = "";
  }

  private async showWs(name: string) {
    const file = await readFile(this.threadId, name).catch(() => null);
    if (file === null) { return; }
    this.wsOpen = name;
    this.wsContent = file.content;
  }

  // --- the tree ---------------------------------------------------------------
  // Folders come from the artifact paths themselves: "site/css/main.css" is a
  // file main.css inside css inside site. Nothing invents structure — a flat
  // conversation renders as flat rows, which is also what Kimi does.

  private static iconFor(kind: string, mime: string, name: string): string {
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    if (kind === "image" || mime.startsWith("image/") || ["png","jpg","jpeg","gif","svg","webp"].includes(ext)) return "image";
    if (["csv","tsv","parquet"].includes(ext) || mime === "text/csv") return "table";
    if (kind === "html" || kind === "json" || kind === "code" || ["ts","js","py","sh","html","json","css"].includes(ext)) return "code";
    if (kind === "markdown" || kind === "text" || mime.startsWith("text/")) return "file-text";
    return "file";
  }

  /* Artifacts, as nested folders. A node owns the files directly in it and
     the folders under it; rendering walks depth-first with indentation. */
  private tree() {
    type Node = { path: string; dirs: Map<string, Node>; files: ArtifactListing[] };
    const root: Node = { path: "", dirs: new Map(), files: [] };
    for (const a of this.artifacts) {
      const parts = a.path.split("/").filter((p) => p !== "");
      let at = root;
      for (const dir of parts.slice(0, -1)) {
        let next = at.dirs.get(dir);
        if (next === undefined) {
          next = { path: at.path + "/" + dir, dirs: new Map(), files: [] };
          at.dirs.set(dir, next);
        }
        at = next;
      }
      at.files.push(a);
    }
    const fileRow = (a: ArtifactListing, depth: number) => {
      const name = a.path.split("/").filter(Boolean).pop() ?? a.path;
      return html`
        <div class="row ${depth > 0 ? "indent" : ""}" style=${depth > 1 ? `margin-left:${depth * 26}px` : ""}
          title=${a.path} @click=${() => this.show(a, a.version)}>
          <span class="tile"><nr-icon name=${ArtifactPanel.iconFor(a.kind, a.mime, name)}></nr-icon></span>
          <span class="fbody">
            <div class="fname">${this.label(a)}</div>
            <div class="fmeta">${a.kind} · ${a.version} version${a.version === 1 ? "" : "s"}</div>
          </span>
        </div>`;
    };
    const folderRow = (name: string, node: Node, depth: number): unknown => {
      const closed = this.folded.has(node.path);
      const count = node.files.length + node.dirs.size;
      return html`
        <div class="row ${depth > 0 ? "indent" : ""}" style=${depth > 1 ? `margin-left:${depth * 26}px` : ""}
          @click=${() => this.toggleFold(node.path)}>
          <span class="tile"><nr-icon name="folder"></nr-icon></span>
          <span class="fbody">
            <div class="fname">${name}</div>
            <div class="fmeta">${count} item${count === 1 ? "" : "s"}</div>
          </span>
          <nr-icon class="chev" name=${closed ? "chevron-right" : "chevron-down"} size="small"></nr-icon>
        </div>
        ${closed ? "" : html`
          ${[...node.dirs.entries()].map(([n, d]) => folderRow(n, d, depth + 1))}
          ${node.files.map((f) => fileRow(f, depth + 1))}`}`;
    };
    return html`
      ${[...root.dirs.entries()].map(([n, d]) => folderRow(n, d, 0))}
      ${root.files.map((f) => fileRow(f, 0))}`;
  }

  /* The conversation's working files, as one more folder in the same tree —
     "workspace", after the artifacts, closed by the same chevron. */
  private workspaceRows() {
    if (this.wsFiles.length === 0) { return ""; }
    const closed = this.folded.has("/workspace");
    return html`
      <div class="row" @click=${() => this.toggleFold("/workspace")}>
        <span class="tile"><nr-icon name="folder"></nr-icon></span>
        <span class="fbody">
          <div class="fname">workspace</div>
          <div class="fmeta">${this.wsFiles.length} file${this.wsFiles.length === 1 ? "" : "s"} the agent works on</div>
        </span>
        <nr-icon class="chev" name=${closed ? "chevron-right" : "chevron-down"} size="small"></nr-icon>
      </div>
      ${closed ? "" : this.wsFiles.map((f) => html`
        <div class="row indent" @click=${() => this.showWs(f.name)}>
          <span class="tile"><nr-icon name=${ArtifactPanel.iconFor("", f.mime, f.name)}></nr-icon></span>
          <span class="fbody">
            <div class="fname">${f.name}</div>
            <div class="fmeta">${f.mime} · ${f.origin}</div>
          </span>
        </div>`)}`;
  }

  /* Called by the console when a message's card is clicked: the path the
     message saved, at the version it saved. Public on purpose — it is the
     panel's addressable surface, same as showDiff. */
  async showPath(path: string, version: number): Promise<void> {
    if (this.artifacts.length === 0) { await this.refresh(); }
    const a = this.artifacts.find((x) => x.path === path);
    if (a === undefined) { return; }
    await this.show(a, version > 0 ? version : a.version);
  }

  private toggleFold(path: string) {
    const next = new Set(this.folded);
    if (next.has(path)) { next.delete(path); } else { next.add(path); }
    this.folded = next;
  }

  // Open straight onto one landing's diff — what a chip in a chat card asks
  // for. The base is the version before the landing, whatever the picker's
  // default would be: the chip's question is "what did this run change".
  async showDiff(path: string, version: number): Promise<void> {
    await this.refresh();
    const a = this.artifacts.find((x) => x.path === path);
    if (!a) return;
    this.diffBase = Math.max(1, version - 1);
    await this.show(a, version);
  }

  private async show(artifact: ArtifactListing, version: number) {
    // A fresh open from the list compares against v1 by default; showDiff
    // sets its own base first and show honours whatever is there.
    if (this.open === null || this.open.slot !== artifact.slot) {
      if (this.diffBase === 0) this.diffBase = 1;
    }
    this.open = artifact;
    this.shown = null;
    this.arming = "";
    this.problem = "";
    this.said = "";
    this.diff = null;
    this.hunkAt = -1;
    try {
      this.shown = await readArtifactVersion(this.threadId, artifact.slot, version);
    } catch (e) {
      this.problem = (e as Error).message;
      return;
    }
    // Diff first, content on the toggle: a version past the first is an edit,
    // and the first question about an edit is what it changed. Three
    // exceptions open as content instead: an image and an office document
    // (a line diff of base64 answers nothing), and anything the panel can
    // RENDER — an html page or an svg is a thing before it is a text, so the
    // first look is the thing itself and the diff is one click away.
    if (version >= 2 && artifact.kind !== "image" && artifact.kind !== "file"
      && !embeds(artifact.kind) && officeKind(artifact.path) === null) {
      await this.computeDiff();
    }
  }

  // Which version the diff reads against. 1 by default — "what has this file
  // become since it arrived" is the question a rail full of edits asks — and
  // changeable from the tally's select for the step-by-step reading.
  @state() private diffBase = 1;

  private async computeDiff() {
    if (this.open === null || this.shown === null || this.shown.version < 2) return;
    const base = Math.min(Math.max(1, this.diffBase), this.shown.version - 1);
    try {
      const before = await readArtifactVersion(this.threadId, this.open.slot, base);
      // JSON diffs compare both sides formatted the same way. An upload
      // arrives minified, the first edit pretty-prints it, and a line diff of
      // that is one enormous deletion followed by the whole file added — true
      // and useless. Formatting is display-only: the stored bytes and the
      // content view keep exactly what was written.
      let a = before.content, b = this.shown.content;
      if (this.open.kind === "json") {
        try {
          a = JSON.stringify(JSON.parse(a), null, 2);
          b = JSON.stringify(JSON.parse(b), null, 2);
        } catch { a = before.content; b = this.shown.content; }
      }
      const rows = diffLines(a, b);
      if (rows === null) { return; }
      this.diffBase = base;
      this.diff = rows;
      this.hunkAt = -1;
    } catch (e) {
      this.problem = (e as Error).message;
    }
  }

  // The toggle between what a version says and what it changed.
  private async toggleDiff() {
    if (this.diff !== null) { this.diff = null; return; }
    if (this.shown !== null && this.shown.version < 2) return;
    await this.computeDiff();
    if (this.diff === null && this.problem === "") {
      this.problem = "these versions are too large to diff here";
    }
  }

  // Copy the bytes, not the rendering. The panel holds the version's own
  // content already — the frame is showing the same body through a different
  // door, and there is no reading back through that door by design.
  private async copy() {
    if (this.shown === null) return;
    try {
      await navigator.clipboard.writeText(this.shown.content);
      this.said = "Copied.";
    } catch {
      // Clipboard access is a secure-context permission, so this fails on a
      // plain-http deployment and saying why is the only useful answer.
      this.problem = "the browser would not give this page the clipboard";
    }
  }

  private expand() {
    if (this.open === null || this.shown === null) return;
    // noreferrer for the same reason the server sends Referrer-Policy: the
    // token in that URL is the whole authorisation, and a page the artifact
    // links to must not be handed it. noopener follows from it and also keeps
    // the new document from reaching back through window.opener.
    window.open(previewUrl(this.open.previewToken, this.shown.version), "_blank",
      "noopener,noreferrer");
  }

  private async rotate() {
    if (this.open === null) return;
    if (this.arming !== "rotate") {
      this.arming = "rotate";
      return;
    }
    const slot = this.open.slot;
    try {
      const turned = await rotateArtifact(this.threadId, slot);
      // Rebuilt rather than assigned into, so Lit sees a new row and the frame
      // reloads against the new token — the old one is a 404 from now on.
      const swap = (a: ArtifactListing) =>
        a.slot === slot ? { ...a, previewToken: turned.previewToken } : a;
      this.artifacts = this.artifacts.map(swap);
      this.open = swap(this.open);
      this.said = "Every link shared before now is dead.";
    } catch (e) {
      this.problem = (e as Error).message;
    }
    this.arming = "";
  }

  private async destroy() {
    if (this.open === null) return;
    if (this.arming !== "delete") {
      this.arming = "delete";
      return;
    }
    try {
      await deleteArtifact(this.threadId, this.open.slot);
      this.close();
      await this.refresh();
    } catch (e) {
      this.arming = "";
      this.problem = (e as Error).message;
    }
  }

  private label(a: ArtifactListing): string {
    return a.title === "" ? a.path : a.title;
  }

  // Which change block the arrows last jumped to; -1 before any jump. Reset
  // whenever a new diff is computed.
  @state() private hunkAt = -1;

  // A hunk is a run of changed rows with unchanged rows (or an edge) around
  // it. The arrows walk these, not individual lines — a reader steps between
  // changes, and a ten-line insertion is one change.
  private hunkStarts(rows: DiffRow[]): number[] {
    const starts: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind !== "same" && (i === 0 || rows[i - 1].kind === "same")) starts.push(i);
    }
    return starts;
  }

  private jump(dir: 1 | -1) {
    const rows = this.diff;
    if (rows === null) return;
    const starts = this.hunkStarts(rows);
    if (starts.length === 0) return;
    const next = (this.hunkAt + dir + starts.length) % starts.length;
    this.hunkAt = next;
    const el = this.renderRoot.querySelector(`.diff .r[data-row="${starts[next]}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private diffView() {
    const rows = this.diff as DiffRow[];
    const v = this.shown as ArtifactVersion;
    const { added, removed } = diffCounts(rows);
    const hunks = this.hunkStarts(rows).length;
    const json = (this.open as ArtifactListing).kind === "json";
    return html`
      <div class="diff">
        <div class="tally">
          <span><select class="base" title="Compare against"
              @change=${(e: Event) => { this.diffBase = Number((e.target as HTMLSelectElement).value); void this.computeDiff(); }}>
              ${Array.from({ length: v.version - 1 }, (_, i) => i + 1).map((n) => html`
                <option value=${n} ?selected=${n === this.diffBase}>v${n}</option>`)}
            </select> &rarr; v${v.version} ·
            <b class="plus">+${added}</b> <b class="minus">&minus;${removed}</b> ·
            ${hunks} change${hunks === 1 ? "" : "s"}${this.hunkAt < 0 ? "" : `, at ${this.hunkAt + 1}`}</span>
          <span class="nav">
            <button class="hop" id="a-diff-prev" title="Previous change"
              @click=${() => this.jump(-1)}><nr-icon name="arrow-up" size="small"></nr-icon></button>
            <button class="hop" id="a-diff-next" title="Next change"
              @click=${() => this.jump(1)}><nr-icon name="arrow-down" size="small"></nr-icon></button>
          </span>
        </div>
        ${rows.map((r, i) => html`<div class="r ${r.kind === "same" ? "" : r.kind}" data-row=${i}><span
          class="n">${r.a === 0 ? "" : r.a}</span><span
          class="n">${r.b === 0 ? "" : r.b}</span><span
          class="g">${r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span><span
          class="t">${json ? jsonLine(r.text) : r.text}</span></div>`)}
      </div>
    `;
  }

  // The content, one numbered row per line. Past the cap the numbers stop
  // paying for their DOM and the body falls back to one <pre>.
  private contentView(text: string, kind: string) {
    const lines = text.split("\n");
    if (lines.length > 8000) return html`<pre>${text}</pre>`;
    const json = kind === "json";
    return html`
      <div class="pre">
        ${lines.map((t, i) => html`<div class="r"><span class="n">${i + 1}</span><span
          class="t">${json ? jsonLine(t) : t}</span></div>`)}
      </div>
    `;
  }

  // The version numbers this artifact has, newest first.
  //
  // Counted, not fetched: there is no route that lists versions, and there
  // does not need to be one — the log is append-only, numbered from 1, and
  // never has a hole, so the pointer's number is the count.
  private versions(a: ArtifactListing): number[] {
    const all: number[] = [];
    for (let n = a.version; n >= 1; n--) all.push(n);
    return all;
  }

  private viewing() {
    const a = this.open as ArtifactListing;
    const v = this.shown;
    return html`
      ${this.grip()}
      <div class="view">
        <div class="head">
          <!-- Kimi's split: back returns to the file list, X puts the whole
               rail away. Before this the X did back's job and nothing did
               X's, which read as a preview you could not leave. -->
          <nr-button id="a-back" size="small" title="Back to files"
            @click=${() => this.close()}>
            <nr-icon name="chevron-left" size="small"></nr-icon>
          </nr-button>
          <div class="name">
            ${this.label(a)}
            <div class="meta">${a.path}</div>
          </div>
          <nr-button id="a-diff" size="small"
            ?disabled=${v === null || v.version < 2 || a.kind === "image" || a.kind === "file" || officeKind(a.path) !== null}
            title=${this.diff === null
              ? (v !== null && v.version >= 2
                ? `What v${v.version} changed against v${v.version - 1}` : "A first version has nothing to differ from")
              : "Back to the content"}
            @click=${() => this.toggleDiff()}>
            <nr-icon name="arrow-up-down" size="small"></nr-icon>
          </nr-button>
          <nr-button id="a-menu" size="small" title="More"
            @click=${() => { this.menuOpen = !this.menuOpen; }}>
            <nr-icon name="more-vertical" size="small"></nr-icon>
          </nr-button>
          <nr-button id="a-close" size="small" title="Close the panel"
            @click=${() => { this.close(); this.dispatchEvent(new CustomEvent("close-rail")); }}>
            <nr-icon name="x" size="small"></nr-icon>
          </nr-button>
        </div>
        ${!this.menuOpen ? "" : html`
          <div class="menu-backdrop" @click=${() => { this.menuOpen = false; }}></div>
          <div class="kebab">
            <button id="a-copy" ?disabled=${v === null}
              @click=${() => { void this.copy(); this.menuOpen = false; }}>
              <nr-icon name="copy" size="small"></nr-icon>Copy</button>
            <button id="a-expand" ?disabled=${v === null}
              @click=${() => { this.expand(); this.menuOpen = false; }}>
              <nr-icon name="external-link" size="small"></nr-icon>Open</button>
            <button id="a-rotate" @click=${() => { void this.rotate(); }}>
              <nr-icon name="refresh-cw" size="small"></nr-icon>
              ${this.arming === "rotate" ? "Break links?" : "New link"}</button>
            <button id="a-delete" class="danger" @click=${() => { void this.destroy(); }}>
              <nr-icon name="trash-2" size="small"></nr-icon>
              ${this.arming === "delete" ? "Delete all versions?" : "Delete"}</button>
          </div>`}

        ${v === null ? html`<div class="loading">Loading…</div>`
          : this.diff !== null ? this.diffView()
          : officeKind(a.path) !== null ? html`
            <div class="office" id="office-host" aria-label="document view"></div>`
          : a.kind === "file" ? html`
            <!-- An opaque body: base64 of whatever the extension means. A
                 wall of base64 tells nobody anything, so the panel says what
                 it is holding instead. -->
            <div class="pre"><div class="none" style="padding:20px">
              A file the console does not render — ${v.bytes} bytes, stored
              as-is. Open serves it; Copy takes the base64 body.
            </div></div>`
          : embeds(a.kind) ? html`
            <!-- src, and only src. The body is a document of its own served
                 from the preview URL; srcdoc or a data: URI would run it here,
                 inside the console's origin. allow-scripts without
                 allow-same-origin is the whole point of the pair: the page may
                 run its own script and may read nothing that belongs to
                 anybody. -->
            <iframe
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
              title=${this.label(a)}
              src=${previewUrl(a.previewToken, v.version)}
            ></iframe>`
          : this.contentView(v.content, a.kind)}

        <div class="versions">
          <div class="label">Versions</div>
          <div class="row">
            ${this.versions(a).map((n) => html`
              <button class="v" aria-current=${String(v !== null && v.version === n)}
                @click=${() => this.show(a, n)}>v${n}</button>`)}
          </div>
        </div>

        ${v === null ? "" : html`
          <div class="note">
            ${v.bytes} bytes · ${v.origin}${v.note === "" ? "" : html` · ${v.note}`}
          </div>`}


        ${this.problem === "" ? "" : html`<div class="problem">${this.problem}</div>`}
        ${this.said === "" ? "" : html`<div class="said">${this.said}</div>`}
      </div>
    `;
  }

  // A person's file, into the store the model writes to. Text arrives as
  // itself; anything binary (an office document, an image) arrives as base64,
  // which is what the store keeps for those kinds anyway. The server is the
  // judge of paths and sizes — its refusal is shown, not paraphrased.
  // How the panel gets a thread when there is none yet: the console hands in
  // the same door the composer's first message uses.
  @property({ attribute: false }) ensureThread?: () => Promise<string>;

  private async upload(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      if (this.threadId === "" && this.ensureThread) {
        this.threadId = await this.ensureThread();
      }
      if (this.threadId === "") { this.problem = "open a conversation first"; return; }
      await uploadFileArtifact(this.threadId, file);
      this.said = `Uploaded ${file.name}.`;
      this.problem = "";
      await this.refresh();
    } catch (e) {
      this.problem = (e as Error).message;
    }
  }

  render() {
    if (this.wsOpen !== "") {
      return html`
        ${this.grip()}
        <h3><span>${this.wsOpen}</span>
          <nr-button size="small" title="Back to files" @click=${() => { this.wsOpen = ""; }}>
            <nr-icon name="chevron-left" size="small"></nr-icon>
          </nr-button>
        </h3>
        <pre class="wsread">${this.wsContent}</pre>`;
    }
    if (this.open !== null) return this.viewing();
    return html`
      ${this.grip()}
      <h3>
        <span>Files</span>
        <nr-button id="a-upload" size="small" title="Upload a file as an artifact"
          @click=${() => (this.renderRoot.querySelector("#a-file") as HTMLInputElement)?.click()}>
          <nr-icon name="upload" size="small"></nr-icon>
        </nr-button>
        <input id="a-file" type="file" hidden
          @change=${(e: Event) => this.upload(e.target as HTMLInputElement)} />
        ${this.threadId === "" ? "" : html`
          <nr-button id="a-refresh" size="small" title="Refresh"
            @click=${() => this.refresh()}>
            <nr-icon name="refresh-cw" size="small"></nr-icon>
          </nr-button>`}
        <!-- The list can put the rail away too — on a phone it covers the
             conversation, and before this the only way out was the header
             toggle hidden behind it. -->
        <nr-button id="a-close-list" size="small" title="Close the panel"
          @click=${() => this.dispatchEvent(new CustomEvent("close-rail"))}>
          <nr-icon name="x" size="small"></nr-icon>
        </nr-button>
      </h3>
      ${this.problem === "" ? "" : html`<div class="problem">${this.problem}</div>`}
      ${this.said === "" ? "" : html`<div class="said">${this.said}</div>`}
      <div class="list">
        ${this.threadId === "" ? html`<div class="none">Open a conversation first.</div>` : ""}
        ${this.threadId !== "" && this.artifacts.length === 0 && this.wsFiles.length === 0
          ? html`<div class="none">Nothing produced in this conversation yet.</div>` : ""}
        ${this.tree()}
        ${this.workspaceRows()}
      </div>
    `;
  }
}

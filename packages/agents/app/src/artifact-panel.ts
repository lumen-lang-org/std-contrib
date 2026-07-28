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
  readArtifactVersion, rotateArtifact,
} from "./api.js";

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
    .artifact { padding: 8px 10px; cursor: pointer; font-size: 13.5px; border-radius: 8px; }
    .artifact:hover { background: var(--bg-user); }
    .artifact .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .artifact .meta { color: var(--muted); font-size: 11.5px; }
    .none { padding: 16px; color: var(--muted); font-size: 13px; }

    .view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 12px 8px; }
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
    this.style.width = `${this.panelWidth}px`;
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
  // The artifact being read, and the version of it on screen. Two pieces of
  // state and not one: the frame is pinned to a version number, and the row
  // carries the token that number is addressed through.
  @state() private open: ArtifactListing | null = null;
  @state() private shown: ArtifactVersion | null = null;
  // Rotate and delete both destroy something that cannot be recovered — a link
  // somebody is holding, a history nothing else has — so each takes two
  // clicks. "" when neither is armed.
  @state() private arming = "";
  @state() private problem = "";
  @state() private said = "";

  async updated(changed: Map<string, unknown>) {
    if (changed.has("threadId")) {
      this.close();
      await this.refresh();
    }
  }

  // The rail stays current on its own. A conversation produces artifacts
  // while the panel is open — a round's writes, a script's reconcile — and a
  // list that only moved when the thread changed sat on "nothing produced
  // yet" through all of it. A 4-second poll of a listing endpoint is cheaper
  // than the confusion; it stops the moment the panel leaves the DOM.
  private ticker: ReturnType<typeof setInterval> | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.ticker = setInterval(() => { void this.tick(); }, 4000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.ticker !== null) { clearInterval(this.ticker); this.ticker = null; }
  }

  private async tick() {
    if (this.threadId === "") return;
    await this.refresh();
    // The artifact being read moved on: follow its pointer so the pills and
    // the preview show the version that now exists, not the one from when it
    // was opened.
    if (this.open !== null) {
      const fresh = this.artifacts.find((a) => a.slot === this.open!.slot);
      if (fresh && fresh.version !== this.open.version) {
        this.open = fresh;
        await this.show(fresh, fresh.version);
      }
    }
  }

  async refresh() {
    if (this.threadId === "") {
      this.artifacts = [];
      return;
    }
    const listed = await listArtifacts(this.threadId).catch(() => [] as ArtifactListing[]);
    // The API answers in slot order, which is creation order. Newest first is
    // what a rail wants — and by the clock rather than by slot, so an artifact
    // saved again rises to the top the way a conversation does.
    this.artifacts = [...listed].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || b.slot - a.slot);
  }

  private close() {
    this.open = null;
    this.shown = null;
    this.arming = "";
    this.problem = "";
    this.said = "";
  }

  private async show(artifact: ArtifactListing, version: number) {
    this.open = artifact;
    this.shown = null;
    this.arming = "";
    this.problem = "";
    this.said = "";
    try {
      this.shown = await readArtifactVersion(this.threadId, artifact.slot, version);
    } catch (e) {
      this.problem = (e as Error).message;
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
          <div class="name">
            ${this.label(a)}
            <div class="meta">${a.path}</div>
          </div>
          <nr-button id="a-close" size="small" title="Back to the list"
            @click=${() => this.close()}>
            <nr-icon name="x" size="small"></nr-icon>
          </nr-button>
        </div>

        ${v === null ? html`<div class="loading">Loading…</div>`
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
          : html`<pre>${v.content}</pre>`}

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

        <!-- A labelled button takes its icon through iconLeft, which is the
             component's own API and sizes the glyph to the button; an
             icon-only one slots an nr-icon, because iconLeft with an empty
             label leaves the space the label would have had. Names are looked
             up in nr-icon's set, and one that is not in it is drawn as the
             word. -->
        <div class="actions">
          <nr-button id="a-copy" size="small" iconLeft="copy"
            ?disabled=${v === null} @click=${() => this.copy()}>Copy</nr-button>
          <nr-button id="a-expand" size="small" iconLeft="external-link"
            ?disabled=${v === null} @click=${() => this.expand()}>Open</nr-button>
          <nr-button id="a-rotate" size="small" iconLeft="refresh-cw"
            @click=${() => this.rotate()}>
            ${this.arming === "rotate" ? "Break links?" : "New link"}
          </nr-button>
          <nr-button id="a-delete" size="small" type="danger" iconLeft="trash-2"
            @click=${() => this.destroy()}>
            ${this.arming === "delete" ? "Delete all versions?" : "Delete"}
          </nr-button>
        </div>

        ${this.problem === "" ? "" : html`<div class="problem">${this.problem}</div>`}
        ${this.said === "" ? "" : html`<div class="said">${this.said}</div>`}
      </div>
    `;
  }

  render() {
    if (this.open !== null) return this.viewing();
    return html`
      ${this.grip()}
      <h3>
        <span>Artifacts</span>
        ${this.threadId === "" ? "" : html`
          <nr-button id="a-refresh" size="small" title="Refresh"
            @click=${() => this.refresh()}>
            <nr-icon name="refresh-cw" size="small"></nr-icon>
          </nr-button>`}
      </h3>
      <div class="list">
        ${this.threadId === "" ? html`<div class="none">Open a conversation first.</div>` : ""}
        ${this.threadId !== "" && this.artifacts.length === 0
          ? html`<div class="none">Nothing produced in this conversation yet.</div>` : ""}
        ${this.artifacts.map((a) => html`
          <div class="artifact" @click=${() => this.show(a, a.version)}>
            <div class="name">${this.label(a)}</div>
            <div class="meta">
              ${a.kind} · ${a.version} version${a.version === 1 ? "" : "s"}
            </div>
          </div>`)}
      </div>
    `;
  }
}

// Read-only browsers for office documents.
//
// Nothing here leaves the machine. That is the deliberate difference from the
// iframe-a-cloud-viewer route (what kimi.com does with
// view.officeApps.live.com) — an artifact is conversation data, and browsing
// one must not mail it to a third party. What changed is only WHERE on this
// machine the layout happens.
//
// A .docx and a .pptx are drawn from a PDF the platform converted with
// LibreOffice (see ../../office-render.ts), rendered here by pdf.js. The
// in-browser renderers they replaced — docx-preview and pptx-preview — are
// re-implementations of a layout engine in JavaScript, and they are honest
// about their limits: charts, SmartArt, gradients and real typography all
// degrade, and a document written in Calibri laid out in whatever font the
// machine happened to have. LibreOffice IS the engine those formats were
// written against, and it ships the metric-compatible fonts, so a page comes
// out the size and shape its author saw. Decks gained the most: pptx-preview
// was the weakest of the three by a distance.
//
// They are still here as a fallback, and that is not sentiment. The converter
// needs docker and a built image; a laptop without them, or a box where the
// image was never built, still opens documents — a little wrong rather than
// not at all. `renderOffice` tries the PDF and falls back on any failure.
//
// A .xlsx keeps SheetJS deliberately, converter or no converter. A workbook
// is not a page — the useful thing to do with one is scroll it and read cells
// at their own size, and paginating it into PDF sheets to look at a total is
// a worse answer than the table, however much more faithful the typography.
//
// Every renderer loads on first use via dynamic import — opening a docflow
// JSON never pays for pdf.js or any of the rest.
//
// View only, by design. There is no edit surface: the store's versions are
// append-only and an office file's edits come from whoever produces the next
// version, not from a browser widget.
//
// The layout is two columns: a nav rail on the left — pages for a document,
// slides for a deck, sheets for a workbook — and the document on the right.
// The rail is the same piece of UI for all three; only what a click means
// differs (scroll vs redraw).

// The extensions this file knows how to draw. The server's `kind` column
// says only "office" — recognition of WHICH viewer is by path alone, which
// keeps the choice client-side.
export function officeKind(path: string): "docx" | "xlsx" | "pptx" | null {
  const p = path.toLowerCase();
  if (p.endsWith(".docx")) return "docx";
  if (p.endsWith(".xlsx") || p.endsWith(".xls")) return "xlsx";
  if (p.endsWith(".pptx")) return "pptx";
  return null;
}

// Binary artifacts are base64 text in the store, same as images. A body that
// does not decode is reported as such rather than drawn as garbage.
function bytesOf(content: string): Uint8Array {
  const clean = content.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const SHEET_ROW_CAP = 2000;
const SHEET_COL_CAP = 100;

// The two-column skeleton every viewer draws into.
function skeleton(host: HTMLElement): { nav: HTMLElement; doc: HTMLElement } {
  host.textContent = "";
  const nav = document.createElement("div");
  nav.className = "office-nav";
  const doc = document.createElement("div");
  doc.className = "office-doc";
  host.append(nav, doc);
  return { nav, doc };
}

// A rail over scrollable items — a document's pages, a deck's slides: a
// miniature of each, click scrolls, and the highlight follows the reader's
// own scrolling so the rail answers "where am I", not "where did I last
// click". The miniature is a scaled clone of the rendered page itself:
// everything already carries its styles (docx-preview's stylesheet lives in
// the same shadow root, pptx-preview styles inline), so a clone at 10% IS
// the page, not a picture of one.
const THUMB_W = 92;

/* Fit a rendered page to the column by scaling it, never by resizing it.
 *
 * docx-preview lays a page out at its true size — 816px for Letter, 794 for
 * A4 — with the document's own margins and fonts. Making that fit by setting
 * width:auto is what turned an A4 page into a 317px column of system-ui: the
 * layout was recomputed at the wrong size instead of the right one being
 * shown smaller. Scaling keeps every measurement the document asked for and
 * changes only how big it appears.
 *
 * The scaled page still occupies its unscaled box in flow, so the height is
 * corrected too — otherwise every page leaves the whitespace of a full-size
 * one beneath it. Re-run on resize because the column's width is what the
 * scale is computed against. */
function fitPages(host: HTMLElement, pages: HTMLElement[]): void {
  const apply = () => {
    // The padding the host already has; the page must not sit under it.
    const room = host.clientWidth - 20;
    for (const page of pages) {
      page.style.transform = "";
      page.style.height = "";
      const natural = page.offsetWidth;
      if (natural <= 0) { continue; }
      // Never enlarge: a page smaller than the column stays its own size,
      // because a document rendered bigger than it was written is a lie about
      // its typography, and the reader can zoom.
      const scale = Math.min(1, room / natural);
      if (scale >= 1) { continue; }
      page.style.transform = `scale(${scale})`;
      page.style.height = `${page.offsetHeight * scale}px`;
    }
  };
  apply();
  // Fonts land after the first layout and change the page's height; a second
  // pass once they have is the difference between a gap under the page and
  // none.
  if ((document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts) {
    void (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready.then(apply);
  }
  new ResizeObserver(apply).observe(host);
}

function railOver(nav: HTMLElement, doc: HTMLElement, items: HTMLElement[], word: string, portHeight: number): void {
  items.forEach((item, i) => {
    const b = document.createElement("button");
    b.className = "thumb";
    b.title = `${word} ${i + 1}`;
    const w = Math.max(1, item.offsetWidth);
    const scale = THUMB_W / w;
    const port = document.createElement("div");
    port.className = "thumb-port";
    // Every miniature wears the medium's own proportion — paper for pages,
    // 16:9 for slides — however little is printed on it. A thumbnail sized
    // by its content turns a short page into a squashed strip.
    port.style.height = `${portHeight}px`;
    const mini = item.cloneNode(true) as HTMLElement;
    mini.style.width = `${w}px`;
    mini.style.transform = `scale(${scale})`;
    mini.style.transformOrigin = "top left";
    mini.style.pointerEvents = "none";
    port.append(mini);
    const tag = document.createElement("span");
    tag.className = "thumb-tag";
    tag.textContent = String(i + 1);
    b.append(port, tag);
    b.setAttribute("aria-current", "false");
    b.addEventListener("click", () => {
      for (const s of Array.from(nav.children)) s.setAttribute("aria-current", "false");
      b.setAttribute("aria-current", "true");
      item.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.append(b);
  });
  if (items.length === 0) return;
  nav.children[0]?.setAttribute("aria-current", "true");
  const watcher = new IntersectionObserver((hits) => {
    for (const h of hits) {
      if (!h.isIntersecting) continue;
      const i = items.indexOf(h.target as HTMLElement);
      if (i < 0) continue;
      for (const s of Array.from(nav.children)) s.setAttribute("aria-current", "false");
      nav.children[i]?.setAttribute("aria-current", "true");
    }
  }, { root: doc, threshold: 0.4 });
  for (const it of items) watcher.observe(it);
}

function navEntry(nav: HTMLElement, label: string, onPick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", () => {
    for (const s of Array.from(nav.children)) s.setAttribute("aria-current", "false");
    b.setAttribute("aria-current", "true");
    onPick();
  });
  b.setAttribute("aria-current", "false");
  nav.append(b);
  return b;
}

// Where a converted PDF comes from. The panel knows the artifact it is
// showing; this file knows nothing about threads, so the identity is passed
// in rather than looked up.
export type OfficeSource = { threadId: string; slot: number; version: number };

// How wide a page is drawn, in CSS pixels of the column, and how much more
// than that is rendered so it stays sharp. A canvas rendered at CSS size is
// visibly soft on any screen with a device pixel ratio above 1, which is most
// of them; capped at 2 because past that the memory costs more than the
// sharpness is worth on a page nobody is zooming into.
function pdfScaleFor(page: { getViewport: (o: { scale: number }) => { width: number } }, room: number): number {
  const unit = page.getViewport({ scale: 1 });
  // Never enlarge: a page smaller than the column stays its own size, because
  // a document drawn bigger than it was written is a lie about its
  // typography. Same rule the old fitPages held to.
  return Math.min(1, room / unit.width);
}

function pdfRatio(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}

// Draw one PDF page onto a canvas at `scale`, sized in CSS pixels and
// rendered at `ratio` times that many device pixels.
async function drawPage(page: PdfPage, scale: number, ratio: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: scale * ratio });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
  // Height follows the width rather than being pinned to it. The stylesheet's
  // `max-width: 100%` can narrow this canvas — that is the guard that keeps a
  // page inside a column narrower than it was drawn for — and a height fixed
  // in pixels does not narrow with it, which squashed 4:3 slides to 0.94.
  // Inline, not left to the stylesheet, because an inline width would
  // otherwise outrank a stylesheet's `height: auto` and reintroduce it.
  canvas.style.height = "auto";
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("this browser would not give the page a canvas to draw on");
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

// The shapes of pdf.js this file uses, named rather than `any` so a version
// bump that moves one of them fails here instead of at runtime.
type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
};
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };

// A converted document, drawn page by page.
//
// Each page is rendered twice — once into the column, once small into the
// rail — because a canvas cannot be cloned into a thumbnail the way the old
// renderers' DOM pages could. `cloneNode` on a canvas copies the element and
// not one pixel of what was drawn on it, so the rail would have been a column
// of blank rectangles. Rendering again at thumbnail scale is cheap and is
// also more correct: the miniature is drawn for its size rather than scaled
// down from a bigger one.
async function renderPdfInto(nav: HTMLElement, doc: HTMLElement, bytes: Uint8Array, word: string): Promise<void> {
  const pdfjs = await import("pdfjs-dist");
  // The worker is loaded as a URL Vite resolves and fingerprints at build
  // time. Without this pdf.js looks for a worker beside the page, does not
  // find one, and falls back to parsing on the main thread — which works and
  // locks the interface up on any document worth looking at.
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const file = (await pdfjs.getDocument({ data: bytes }).promise) as unknown as PdfDoc;

  // The rail FIRST, then the pages. Not cosmetic ordering: the rail is a fixed
  // 116px column of the same flex row, so until it exists the document column
  // measures ~60px wider than it will end up. Rendering pages against that
  // measurement produced slides 240px wide in 174px of column, hanging off the
  // right edge of the panel and clipped. Building the rail first means the one
  // measurement below is taken against the layout the pages will actually live
  // in.
  const pages: HTMLElement[] = [];
  await railOverPdf(nav, doc, file, pages, word);

  const room = pdfRoom(doc);
  const ratio = pdfRatio();
  for (let n = 1; n <= file.numPages; n++) {
    const page = await file.getPage(n);
    const canvas = await drawPage(page, pdfScaleFor(page, room), ratio);
    const sheet = document.createElement("div");
    sheet.className = "pdf-page";
    sheet.append(canvas);
    doc.append(sheet);
    pages.push(sheet);
  }
  followScroll(nav, doc, pages);
  watchWidth(doc, file, pages);
}

// The width a page is drawn to. Floored so a panel dragged very narrow asks
// for a page rather than a sliver; the CSS max-width keeps that legal on
// screen even when the floor is wider than the column.
function pdfRoom(doc: HTMLElement): number {
  return Math.max(200, doc.clientWidth - 20);
}

// Re-draw the pages when the column's width really changes.
//
// A canvas is drawn at one size and cannot reflow, so a panel dragged wider
// leaves every page at its old resolution — sharp-edged but small, with the
// CSS holding it inside the column and nothing filling the new space. This
// redraws at the new width so the document uses the panel it was given.
//
// Debounced, and only past a real change, because a drag fires this on every
// frame and re-rendering a PDF per frame is how a resize becomes a freeze.
// The 12% threshold is what keeps a scrollbar appearing — a few pixels — from
// counting as a resize.
function watchWidth(doc: HTMLElement, file: PdfDoc, pages: HTMLElement[]): void {
  let drawnAt = pdfRoom(doc);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drawing = false;
  const observer = new ResizeObserver(() => {
    const room = pdfRoom(doc);
    if (drawing || Math.abs(room - drawnAt) / drawnAt < 0.12) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        // The column can be gone by the time this fires — the reader closed
        // the panel or opened another document. Its own pages are the check:
        // renderOffice rebuilds the host, so pages detached from it are stale
        // and redrawing them would cost work nobody can see.
        if (pages.length === 0 || !doc.contains(pages[0])) { observer.disconnect(); return; }
        drawing = true;
        const room = pdfRoom(doc);
        const ratio = pdfRatio();
        for (let n = 1; n <= file.numPages && n <= pages.length; n++) {
          const page = await file.getPage(n);
          const canvas = await drawPage(page, pdfScaleFor(page, room), ratio);
          pages[n - 1].replaceChildren(canvas);
        }
        drawnAt = room;
        drawing = false;
      })();
    }, 220);
  });
  observer.observe(doc);
}

// The rail for a converted document: one miniature per page, each its own
// small render. Otherwise identical to `railOver` — same click-to-scroll,
// same highlight that follows the reader rather than the last click.
//
// `pages` is empty when this is called and filled by the caller afterwards —
// the rail has to exist before the column can be measured. The click handlers
// read it at click time, by which point it is full; the highlight observer
// cannot, so it is installed separately by `followScroll` once there is
// something to observe.
async function railOverPdf(nav: HTMLElement, doc: HTMLElement, file: PdfDoc, pages: HTMLElement[], word: string): Promise<void> {
  for (let n = 1; n <= file.numPages; n++) {
    const page = await file.getPage(n);
    const unit = page.getViewport({ scale: 1 });
    const b = document.createElement("button");
    b.className = "thumb";
    b.title = `${word} ${n}`;
    const port = document.createElement("div");
    port.className = "thumb-port";
    port.style.height = `${Math.round((THUMB_W * unit.height) / unit.width)}px`;
    port.append(await drawPage(page, THUMB_W / unit.width, pdfRatio()));
    const tag = document.createElement("span");
    tag.className = "thumb-tag";
    tag.textContent = String(n);
    b.append(port, tag);
    b.setAttribute("aria-current", n === 1 ? "true" : "false");
    b.addEventListener("click", () => {
      for (const s of Array.from(nav.children)) s.setAttribute("aria-current", "false");
      b.setAttribute("aria-current", "true");
      pages[n - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.append(b);
  }
}

// The rail highlight follows where the reader is looking, not where they last
// clicked. Installed after the pages exist — see the note on railOverPdf.
function followScroll(nav: HTMLElement, doc: HTMLElement, pages: HTMLElement[]): void {
  const watcher = new IntersectionObserver((hits) => {
    for (const h of hits) {
      if (!h.isIntersecting) continue;
      const i = pages.indexOf(h.target as HTMLElement);
      if (i < 0) continue;
      for (const s of Array.from(nav.children)) s.setAttribute("aria-current", "false");
      nav.children[i]?.setAttribute("aria-current", "true");
    }
  }, { root: doc, threshold: 0.4 });
  for (const p of pages) watcher.observe(p);
}

// Draw `content` into `host`. Throws with a person-readable message when the
// body is not what the extension claims; the panel shows that message.
//
// `source` is what makes the converted path possible; without it — or when
// the conversion fails for any reason — this falls back to laying the
// document out in the browser. The fallback is silent on purpose: a reader
// opening a document does not need to be told which of two renderers drew it,
// and the difference shows in the page rather than in a banner.
export async function renderOffice(host: HTMLElement, kind: "docx" | "xlsx" | "pptx", content: string, source?: OfficeSource): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = bytesOf(content);
  } catch {
    throw new Error("this artifact is not base64 — an office file must be stored as base64 bytes");
  }
  // A workbook is never converted — see the note at the top of this file.
  if (source && kind !== "xlsx") {
    const converted = skeleton(host);
    try {
      const { officePdf } = await import("./api.js");
      const made = await officePdf(source.threadId, source.slot, source.version);
      await renderPdfInto(converted.nav, converted.doc, bytesOf(made.pdf),
        kind === "pptx" ? "Slide" : "Page");
      return;
    } catch {
      // Docker down, image not built, a document the converter declined — all
      // of them mean the same thing here: draw it the old way. Falling through
      // rebuilds the skeleton below, which is also what clears whatever half a
      // document the failed attempt left in the host.
    }
  }
  const { nav, doc } = skeleton(host);
  return renderInBrowser(nav, doc, kind, bytes);
}

// The original renderers, kept as the fallback for a machine with no
// converter — and, for .xlsx, as the only path.
async function renderInBrowser(nav: HTMLElement, doc: HTMLElement, kind: "docx" | "xlsx" | "pptx", bytes: Uint8Array): Promise<void> {
  if (kind === "docx") {
    const { renderAsync } = await import("docx-preview");
    // docx-preview appends both the styles and the pages to the container,
    // which is inside this panel's shadow root — the styles land where the
    // pages are and touch nothing else.
    await renderAsync(bytes.buffer as ArrayBuffer, doc, undefined, {
      inWrapper: true,
      ignoreLastRenderedPageBreak: false,
    });
    // One rail entry per rendered page: docx-preview lays each page out as a
    // <section class="docx">, and scrolling a section into view IS the
    // navigation — there is no page state beyond where the reader looks.
    const pages = Array.from(doc.querySelectorAll<HTMLElement>("section.docx"));
    railOver(nav, doc, pages, "Page", 130);
    fitPages(doc, pages);
    return;
  }
  if (kind === "pptx") {
    // pptx-preview draws each slide as a fixed-size .pptx-preview-slide-wrapper
    // div; the rail navigates them exactly like a document's pages. Fidelity
    // is the format's weak point client-side — text, images and plain shapes
    // come through; charts and SmartArt degrade. The on-box trade stands: a
    // presentation is conversation data and does not get mailed to a cloud
    // viewer for the sake of prettier gradients.
    const { init } = await import("pptx-preview");
    const width = Math.max(480, doc.clientWidth - 24);
    const previewer = init(doc, { width: width, height: Math.round(width * 9 / 16) });
    await previewer.preview(bytes.buffer as ArrayBuffer);
    railOver(nav, doc, Array.from(doc.querySelectorAll<HTMLElement>(".pptx-preview-slide-wrapper")), "Slide", 54);
    return;
  }
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array" });
  const draw = (name: string) => {
    doc.textContent = "";
    const ws = wb.Sheets[name];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const table = document.createElement("table");
    for (const r of rows.slice(0, SHEET_ROW_CAP)) {
      const tr = document.createElement("tr");
      for (const c of r.slice(0, SHEET_COL_CAP)) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.append(td);
      }
      table.append(tr);
    }
    doc.append(table);
    if (rows.length > SHEET_ROW_CAP || rows.some((r) => r.length > SHEET_COL_CAP)) {
      const note = document.createElement("div");
      note.className = "sheet-cut";
      note.textContent = `showing the first ${Math.min(rows.length, SHEET_ROW_CAP)} rows — download the file for the rest`;
      doc.append(note);
    }
  };
  for (const name of wb.SheetNames) navEntry(nav, name, () => draw(name));
  if (wb.SheetNames.length > 0) {
    nav.children[0]?.setAttribute("aria-current", "true");
    draw(wb.SheetNames[0]);
  }
}

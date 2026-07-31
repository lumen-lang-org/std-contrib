// Read-only browsers for office documents, rendered entirely in this page.
//
// Nothing here leaves the machine: a .docx is laid out by docx-preview and a
// .xlsx is parsed by SheetJS, both from the artifact's own bytes. That is the
// deliberate difference from the iframe-a-cloud-viewer route (what kimi.com
// does with view.officeApps.live.com) — an artifact is conversation data, and
// browsing one must not mail it to a third party.
//
// Both libraries are heavy, so they load on first use via dynamic import —
// opening a docflow JSON never pays for them.
//
// View only, by design. There is no edit surface: the store's versions are
// append-only and an office file's edits come from whoever produces the next
// version, not from a browser widget.
//
// The layout is two columns: a nav rail on the left — pages for a document,
// sheets for a workbook — and the document on the right. The rail is the same
// piece of UI for both; only what a click means differs (scroll vs redraw).

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

// Draw `content` into `host`. Throws with a person-readable message when the
// body is not what the extension claims; the panel shows that message.
export async function renderOffice(host: HTMLElement, kind: "docx" | "xlsx" | "pptx", content: string): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = bytesOf(content);
  } catch {
    throw new Error("this artifact is not base64 — an office file must be stored as base64 bytes");
  }
  const { nav, doc } = skeleton(host);
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

// Changing cells in a workbook without touching anything else.
//
// The obvious way to save an edited spreadsheet — read it with SheetJS, write
// it back out — quietly destroys most of the file: the community build does
// not carry styles, conditional formatting, charts or drawings through a
// write, so "I changed B4 to 1200" would also mean "and the Gantt bars, the
// palette and both charts are gone". That is not an edit, it is a rewrite
// with losses.
//
// So this does the small thing instead. A .xlsx is a zip of XML parts; a cell
// edit touches exactly one of them (xl/worksheets/sheetN.xml). The original
// bytes are opened as a zip, the one worksheet's XML gets its changed cells
// replaced, and every other part — styles, charts, themes, the lot — is
// carried over untouched. Fidelity is not a feature here; it is the absence
// of a step that loses things.
//
// What an edit CAN do is bounded and worth saying: a changed cell becomes a
// literal. Editing a formula cell replaces the formula with the typed value —
// the honest reading of typing over a formula — and calcChain.xml is dropped
// whenever that happens, because a stale chain makes Excel warn; it rebuilds
// the chain from the formulas that remain.

import JSZip from "jszip";

export type CellEdit = {
  /** The sheet's display name, as the tab shows it. */
  sheet: string;
  /** A1-style reference. */
  ref: string;
  /** What was typed. Numbers are stored as numbers, everything else inline. */
  value: string;
};

const SSML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Which worksheet part a sheet name lives in, read from the workbook's own
 *  tables rather than guessed from "sheet1.xml" — a workbook that ever had a
 *  sheet deleted numbers its parts sparsely. */
async function sheetPart(zip: JSZip, sheetName: string): Promise<string> {
  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  const relXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (wbXml === undefined || relXml === undefined) {
    throw new Error("this file has no workbook inside it");
  }
  const dp = new DOMParser();
  const wb = dp.parseFromString(wbXml, "application/xml");
  const rels = dp.parseFromString(relXml, "application/xml");
  let rid = "";
  for (const s of Array.from(wb.getElementsByTagNameNS(SSML, "sheet"))) {
    if (s.getAttribute("name") === sheetName) {
      rid = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
    }
  }
  if (rid === "") throw new Error(`no sheet called "${sheetName}" in this workbook`);
  for (const r of Array.from(rels.getElementsByTagName("Relationship"))) {
    if (r.getAttribute("Id") === rid) {
      const target = r.getAttribute("Target") ?? "";
      return target.startsWith("/") ? target.slice(1) : "xl/" + target;
    }
  }
  throw new Error(`the workbook names "${sheetName}" but carries no part for it`);
}

const colOf = (ref: string) => ref.replace(/\d+$/, "");
const rowOf = (ref: string) => parseInt(ref.replace(/^[A-Z]+/i, ""), 10);
/** Column letters as a number, for keeping a row's cells in sheet order. */
function colNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** One cell written into its row element: found and rewritten, or created in
 *  column order. Returns whether a formula was displaced. */
function setCell(doc: XMLDocument, row: Element, ref: string, value: string): boolean {
  let cell: Element | null = null;
  for (const c of Array.from(row.getElementsByTagNameNS(SSML, "c"))) {
    if (c.getAttribute("r") === ref) { cell = c; break; }
  }
  if (cell === null) {
    cell = doc.createElementNS(SSML, "c");
    cell.setAttribute("r", ref);
    const mine = colNum(colOf(ref));
    let before: Element | null = null;
    for (const c of Array.from(row.getElementsByTagNameNS(SSML, "c"))) {
      const at = c.getAttribute("r") ?? "";
      if (colNum(colOf(at)) > mine) { before = c; break; }
    }
    row.insertBefore(cell, before);
  }
  const hadFormula = cell.getElementsByTagNameNS(SSML, "f").length > 0;
  // The style index stays: the person changed what the cell says, not what it
  // looks like, and s is what keeps a currency cell a currency cell.
  const kept = cell.getAttribute("s");
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  cell.removeAttribute("t");
  if (value.trim() === "") {
    // An emptied cell keeps its element (and its style) and just says nothing.
    return hadFormula;
  }
  if (NUMERIC.test(value.trim())) {
    const v = doc.createElementNS(SSML, "v");
    v.textContent = value.trim();
    cell.appendChild(v);
  } else {
    // Inline string, not a sharedStrings entry: correct forever at the cost
    // of a few bytes, and it leaves the shared table exactly as it was.
    cell.setAttribute("t", "inlineStr");
    const is = doc.createElementNS(SSML, "is");
    const t = doc.createElementNS(SSML, "t");
    if (/^\s|\s$/.test(value)) t.setAttribute("xml:space", "preserve");
    t.textContent = value;
    is.appendChild(t);
    cell.appendChild(is);
  }
  if (kept !== null) cell.setAttribute("s", kept);
  return hadFormula;
}

/** The row element for 1-based row n: found, or created in row order. */
function rowElement(doc: XMLDocument, sheetData: Element, n: number): Element {
  let before: Element | null = null;
  for (const r of Array.from(sheetData.getElementsByTagNameNS(SSML, "row"))) {
    const at = parseInt(r.getAttribute("r") ?? "0", 10);
    if (at === n) return r;
    if (at > n) { before = r; break; }
  }
  const made = doc.createElementNS(SSML, "row");
  made.setAttribute("r", String(n));
  sheetData.insertBefore(made, before);
  return made;
}

/** The original workbook with the edits applied — and nothing else different.
 *  Takes and returns base64, because that is how the artifact store holds a
 *  binary body. */
export async function patchWorkbook(b64: string, edits: CellEdit[]): Promise<string> {
  const zip = await JSZip.loadAsync(b64ToBytes(b64));
  const bySheet = new Map<string, CellEdit[]>();
  for (const e of edits) {
    const held = bySheet.get(e.sheet) ?? [];
    held.push(e);
    bySheet.set(e.sheet, held);
  }
  let displacedFormula = false;
  for (const [sheet, list] of bySheet) {
    const part = await sheetPart(zip, sheet);
    const xml = await zip.file(part)?.async("string");
    if (xml === undefined) throw new Error(`missing worksheet part ${part}`);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const sheetData = doc.getElementsByTagNameNS(SSML, "sheetData")[0];
    if (sheetData === undefined) throw new Error(`${part} has no sheetData`);
    for (const e of list) {
      const row = rowElement(doc, sheetData, rowOf(e.ref));
      if (setCell(doc, row, e.ref.toUpperCase(), e.value)) displacedFormula = true;
    }
    zip.file(part, new XMLSerializer().serializeToString(doc));
  }
  // A cached-value chain that names a formula we just deleted makes Excel
  // complain about a repaired record. It is derivable, so dropping it is
  // always safe — Excel and LibreOffice rebuild it on the next open.
  if (displacedFormula && zip.file("xl/calcChain.xml") !== null) {
    zip.remove("xl/calcChain.xml");
    // And the content-types entry that declared it, or the package lies.
    const ct = await zip.file("[Content_Types].xml")?.async("string");
    if (ct !== undefined) {
      zip.file("[Content_Types].xml",
        ct.replace(/<Override[^>]*calcChain\.xml[^>]*\/>/, ""));
    }
  }
  const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return bytesToB64(out);
}

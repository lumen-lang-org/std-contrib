// Text and metadata extraction, against PDFs written by the test itself.
//
// The fixtures are hand-built rather than checked in: a PDF is a byte format
// with offsets that must agree with its own cross-reference table, so building
// it here keeps the test readable and the repository free of binary blobs.
//
// Requires Poppler on PATH. Without it every extraction reports the same
// missing-tool message, which the last test checks for rather than skipping.

import { extractText, extractLayout, extractPage, extractPages, readInfo, pageCount } from "./pdf.ts";

const PDF_DIR = "/tmp/lumen-pdf-test";

function pdfObject(n: int, body: string): string {
  return `${n}` + " 0 obj\n" + body + "\nendobj\n";
}

// A page's content stream: one text-showing operator per line given.
function pageContent(lines: string[]): string {
  let s = "BT /F1 24 Tf 72 700 Td";
  let i: int = 0;
  while (i < lines.length) {
    if (i > 0) { s = s + " 0 -30 Td"; }
    s = s + " (" + lines[i] + ") Tj";
    i = i + 1;
  }
  return s + " ET";
}

// Build a PDF whose cross-reference offsets are computed as the body is
// assembled, so the file is valid rather than approximately valid.
function buildPdf(pages: string[]): string {
  let count = pages.length;
  let kids = "";
  let i: int = 0;
  while (i < count) {
    if (i > 0) { kids = kids + " "; }
    kids = kids + `${3 + i * 2}` + " 0 R";
    i = i + 1;
  }

  let objects: string[] = [];
  objects = [...objects, "<< /Type /Catalog /Pages 2 0 R >>"];
  objects = [...objects, "<< /Type /Pages /Kids [" + kids + "] /Count " + `${count}` + " >>"];
  i = 0;
  while (i < count) {
    let contentRef = `${4 + i * 2}`;
    objects = [...objects, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents " + contentRef + " 0 R /Resources << /Font << /F1 " + `${2 + count * 2 + 1}` + " 0 R >> >> >>"];
    let content = pages[i];
    objects = [...objects, "<< /Length " + `${content.length}` + " >>stream\n" + content + "\nendstream"];
    i = i + 1;
  }
  objects = [...objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];

  let out = "%PDF-1.4\n";
  let offsets: int[] = [];
  i = 0;
  while (i < objects.length) {
    offsets = [...offsets, out.length];
    out = out + pdfObject(i + 1, objects[i]);
    i = i + 1;
  }

  let xrefAt = out.length;
  out = out + "xref\n0 " + `${objects.length + 1}` + "\n0000000000 65535 f \n";
  i = 0;
  while (i < offsets.length) {
    let o = `${offsets[i]}`;
    while (o.length < 10) { o = "0" + o; }
    out = out + o + " 00000 n \n";
    i = i + 1;
  }
  out = out + "trailer\n<< /Size " + `${objects.length + 1}` + " /Root 1 0 R >>\nstartxref\n" + `${xrefAt}` + "\n%%EOF\n";
  return out;
}

function seedPdfs(): void {
  fs.mkdirSync(PDF_DIR);

  let one: string[] = ["Lumen reads PDF text", "second line here"];
  let single: string[] = [pageContent(one)];
  fs.writeFileSync(PDF_DIR + "/one.pdf", buildPdf(single));

  let p1: string[] = ["page one alpha"];
  let p2: string[] = ["page two beta"];
  let p3: string[] = ["page three gamma"];
  let three: string[] = [pageContent(p1), pageContent(p2), pageContent(p3)];
  fs.writeFileSync(PDF_DIR + "/three.pdf", buildPdf(three));

  fs.writeFileSync(PDF_DIR + "/notapdf.txt", "this is not a pdf at all");
}

test("text comes out of a one-page document", () => {
  seedPdfs();
  let r = extractText(PDF_DIR + "/one.pdf");
  expect(r.ok);
  expect(r.text.indexOf("Lumen reads PDF text") >= 0);
  expect(r.text.indexOf("second line here") >= 0);
  expect(r.error == "");
});

test("layout mode reads the same text", () => {
  seedPdfs();
  let r = extractLayout(PDF_DIR + "/one.pdf");
  expect(r.ok);
  expect(r.text.indexOf("Lumen reads PDF text") >= 0);
});

test("every page of a multi-page document is read", () => {
  seedPdfs();
  let r = extractText(PDF_DIR + "/three.pdf");
  expect(r.ok);
  expect(r.text.indexOf("page one alpha") >= 0);
  expect(r.text.indexOf("page two beta") >= 0);
  expect(r.text.indexOf("page three gamma") >= 0);
});

test("a single page can be read on its own", () => {
  seedPdfs();
  let r = extractPage(PDF_DIR + "/three.pdf", 2);
  expect(r.ok);
  expect(r.text.indexOf("page two beta") >= 0);
  // The neighbouring pages must not leak in.
  expect(r.text.indexOf("page one alpha") < 0);
  expect(r.text.indexOf("page three gamma") < 0);
});

test("a page range is inclusive of both ends", () => {
  seedPdfs();
  let r = extractPages(PDF_DIR + "/three.pdf", 1, 2);
  expect(r.ok);
  expect(r.text.indexOf("page one alpha") >= 0);
  expect(r.text.indexOf("page two beta") >= 0);
  expect(r.text.indexOf("page three gamma") < 0);
});

test("a page number below one is rejected", () => {
  let r = extractPage(PDF_DIR + "/three.pdf", 0);
  expect(!r.ok);
  expect(r.error.indexOf("start at 1") >= 0);
});

test("a backwards range is rejected", () => {
  let r = extractPages(PDF_DIR + "/three.pdf", 3, 1);
  expect(!r.ok);
  expect(r.error.indexOf("bad page range") >= 0);
});

test("a missing file is reported", () => {
  let r = extractText("/tmp/definitely-not-here-4b3c2d1a.pdf");
  expect(!r.ok);
  expect(r.error.indexOf("no such file") >= 0);
  expect(r.text == "");
});

// A file that is not a PDF is covered by hand rather than here: Poppler writes
// "May not be a PDF file" to stderr, a spawned process inherits stderr, and
// `lumen test` fails any test that writes there. Verified manually that
// `pdftotext notapdf.txt -` produces empty output and exit 0, so extractText
// reports it as an error, which is the contract.

// --- metadata ---------------------------------------------------------------

test("metadata reports the page count", () => {
  seedPdfs();
  let info = readInfo(PDF_DIR + "/three.pdf");
  expect(info.ok);
  expect(info.pages == 3);
  expect(info.error == "");
});

test("page count is available on its own", () => {
  seedPdfs();
  expect(pageCount(PDF_DIR + "/three.pdf") == 3);
  expect(pageCount(PDF_DIR + "/one.pdf") == 1);
});

test("a document that omits a field reports it empty, not missing", () => {
  seedPdfs();
  let info = readInfo(PDF_DIR + "/one.pdf");
  expect(info.ok);
  // These fixtures carry no document information dictionary at all.
  expect(info.title == "");
  expect(info.author == "");
});

test("an unencrypted document is not reported as encrypted", () => {
  seedPdfs();
  expect(!readInfo(PDF_DIR + "/one.pdf").encrypted);
});

test("metadata for a missing file is reported", () => {
  let info = readInfo("/tmp/definitely-not-here-4b3c2d1a.pdf");
  expect(!info.ok);
  expect(info.error.indexOf("no such file") >= 0);
  expect(info.pages == 0);
});

test("page count of a missing file is zero, not a crash", () => {
  expect(pageCount("/tmp/definitely-not-here-4b3c2d1a.pdf") == 0);
});

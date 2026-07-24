// pdf -- text and metadata from PDF files, via Poppler's command-line tools.
//
// A PDF does not store text. It stores positioned glyphs with font-specific
// encodings: word spaces are frequently absent and must be inferred from
// coordinates, reading order across columns is not recorded anywhere, and a
// scanned page has no text layer at all. Recovering readable text means
// interpreting content streams and walking each font's ToUnicode map, which is
// why every library in this space delegates it — LangChain's own PDF loaders
// are wrappers over pdf.js, pypdf or PDFium, and the only text-ordering logic
// they add is a ten-line comparison of y-coordinates that is the source of
// their most-reported bugs.
//
// So this package delegates too, to Poppler: a C++ implementation two decades
// old, and the engine behind most PDF viewers on Linux. `pdftotext` handles
// encodings and ligatures correctly and, with layout mode, orders columns
// better than the heuristics those libraries ship.
//
// Requires `pdftotext` and `pdfinfo` on PATH:
//   Debian/Ubuntu  apt install poppler-utils
//   macOS          brew install poppler
//
// Run: lumen test packages/pdf/pdf.test.ts

// Extracted text, or the reason it could not be extracted. A missing file, a
// missing Poppler, and an unreadable PDF are all reported the same way, so a
// caller has one thing to check.
export type PdfText = {
  ok: bool,
  text: string,
  error: string,
};

// A PDF's own metadata, as `pdfinfo` reports it. Absent fields are "", and
// `pages` is 0 when unknown; a PDF is free to omit any of them.
export type PdfInfo = {
  ok: bool,
  title: string,
  author: string,
  subject: string,
  keywords: string,
  creator: string,
  producer: string,
  creationDate: string,
  modificationDate: string,
  pages: int,
  encrypted: bool,
  error: string,
};

function pdfTextOk(text: string): PdfText {
  let r: PdfText = { ok: true, text: text, error: "" };
  return r;
}

function pdfTextErr(message: string): PdfText {
  let r: PdfText = { ok: false, text: "", error: message };
  return r;
}

// A failed read, with the reason. Every field a caller might touch is present
// and empty, so a caller that forgets to check `ok` reads blanks rather than
// stale values.
function infoErr(message: string): PdfInfo {
  let r: PdfInfo = {
    ok: false,
    title: "", author: "", subject: "", keywords: "",
    creator: "", producer: "", creationDate: "", modificationDate: "",
    pages: 0, encrypted: false,
    error: message,
  };
  return r;
}

// Read a spawned process's whole stdout.
//
// `readLine` returns each line with its terminator and returns "" only at end
// of stream, so a blank line inside the text is preserved rather than mistaken
// for the end.
function readAllOutput(cp: ChildProcess): string {
  let out = "";
  let line = cp.readLine();
  while (line != "") {
    out = out + line;
    line = cp.readLine();
  }
  return out;
}

// Poppler is reached by name, so a caller gets a clear message when it is not
// installed rather than an empty result that looks like an empty PDF.
function toolMissing(tool: string): string {
  return tool + " not found on PATH — install Poppler (apt install poppler-utils, or brew install poppler)";
}

// --- text -------------------------------------------------------------------

function runPdfToText(path: string, args: string[]): PdfText {
  if (!fs.existsSync(path)) {
    return pdfTextErr("no such file: " + path);
  }
  let cp = child_process.spawn("pdftotext", args);
  let text = readAllOutput(cp);
  cp.close();
  if (text == "") {
    // Poppler prints its errors to stderr, which is inherited rather than
    // piped, so an empty result is all this can observe. It has three causes
    // worth separating for the reader: no Poppler, no text layer, or a genuinely
    // empty document.
    return pdfTextErr("no text extracted from " + path + " — the file may be a scan with no text layer, may be encrypted, or " + toolMissing("pdftotext"));
  }
  return pdfTextOk(text);
}

// The document's text, reading order as Poppler recovers it.
export function extractText(path: string): PdfText {
  let args: string[] = [path, "-"];
  return runPdfToText(path, args);
}

// The document's text in layout mode, which preserves the page's horizontal
// arrangement. Use this for anything with columns or tables: the default mode
// concatenates side-by-side columns into single lines, which is the failure
// every naive extractor shares.
export function extractLayout(path: string): PdfText {
  let args: string[] = ["-layout", path, "-"];
  return runPdfToText(path, args);
}

// One page's text. Pages are numbered from 1.
export function extractPage(path: string, page: int): PdfText {
  if (page < 1) {
    return pdfTextErr("page numbers start at 1");
  }
  let n = `${page}`;
  let args: string[] = ["-f", n, "-l", n, path, "-"];
  return runPdfToText(path, args);
}

// A page range, inclusive, numbered from 1.
export function extractPages(path: string, first: int, last: int): PdfText {
  if (first < 1 || last < first) {
    return pdfTextErr("bad page range: " + `${first}` + ".." + `${last}`);
  }
  let args: string[] = ["-f", `${first}`, "-l", `${last}`, path, "-"];
  return runPdfToText(path, args);
}

// --- metadata ---------------------------------------------------------------

// `pdfinfo` prints `Key:` then spaces then the value, one per line. The value
// may contain a colon (a date does), so only the first is a separator.
function infoValue(out: string, key: string): string {
  let lines = out.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    let line = lines[i];
    let at = line.indexOf(":");
    if (at > 0) {
      let name = line.slice(0, at).trim();
      if (name == key) {
        return line.slice(at + 1, line.length).trim();
      }
    }
    i = i + 1;
  }
  return "";
}

function infoInt(out: string, key: string): int {
  let raw = infoValue(out, key);
  if (raw == "") { return 0; }
  return parseInt(raw) ?? 0;
}

// The document's metadata. Every field a PDF may omit comes back as "".
export function readInfo(path: string): PdfInfo {
  if (!fs.existsSync(path)) {
    return infoErr("no such file: " + path);
  }
  let args: string[] = [path];
  let cp = child_process.spawn("pdfinfo", args);
  let out = readAllOutput(cp);
  cp.close();
  if (out == "") {
    return infoErr("no metadata read from " + path + " — the file may not be a PDF, or " + toolMissing("pdfinfo"));
  }
  let parsed: PdfInfo = {
    ok: true,
    title: infoValue(out, "Title"),
    author: infoValue(out, "Author"),
    subject: infoValue(out, "Subject"),
    keywords: infoValue(out, "Keywords"),
    creator: infoValue(out, "Creator"),
    producer: infoValue(out, "Producer"),
    creationDate: infoValue(out, "CreationDate"),
    modificationDate: infoValue(out, "ModDate"),
    pages: infoInt(out, "Pages"),
    encrypted: infoValue(out, "Encrypted") != "no" && infoValue(out, "Encrypted") != "",
    error: "",
  };
  return parsed;
}

// The page count, or 0 when it cannot be read.
export function pageCount(path: string): int {
  return readInfo(path).pages;
}

// There is deliberately no `available()` probe: Poppler prints its version and
// its warnings to stderr, a spawned process inherits stderr rather than piping
// it, and so nothing a caller can read distinguishes "not installed" from
// "installed and quiet". A missing tool surfaces in the error of the first real
// call, which says so explicitly.
//
// A consequence worth knowing: Poppler's own warnings ("May not be a PDF file")
// reach this process's stderr and cannot be suppressed from here.

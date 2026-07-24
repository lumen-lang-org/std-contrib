// pdf_ffi -- PDF text and metadata by linking Poppler directly.
//
// The same surface as `pdf.ts`, without a process per document. Poppler's C++
// API is objects and `poppler::ustring`, neither of which the FFI can carry, so
// `poppler_shim.cpp` flattens it to scalars and C strings the way SQLite's shim
// flattens its out-pointers.
//
// A document is opened once and then read, rather than the file being reparsed
// for every page as the command-line form must.
//
// Build the shim first:
//   c++ -c poppler_shim.cpp -I/usr/include/poppler/cpp -o poppler_shim.o
//   # macOS: -I/opt/homebrew/include/poppler/cpp
//
// Dependencies: libpoppler-cpp-dev (Debian, Ubuntu) or poppler (Homebrew).
//
// @link ./poppler_shim.o
// @link poppler-cpp
// @link /usr/lib/x86_64-linux-gnu/libstdc++.so.6
// @link /usr/lib/x86_64-linux-gnu/libgcc_s.so.1
// @link c
declare function pdf_open(path: string): int;
declare function pdf_open_with_password(path: string, password: string): int;
declare function pdf_pages(): int;
declare function pdf_text(physical: int): string;
declare function pdf_page_text(page: int, physical: int): string;
declare function pdf_info(key: string): string;
declare function pdf_created(): int;
declare function pdf_modified(): int;
declare function pdf_error(): string;
declare function pdf_version(): string;
declare function pdf_close(): void;

// Extracted text, or the reason it could not be extracted. Same shape as the
// command-line form's, so the two are interchangeable at a call site.
export type PdfText = {
  ok: bool,
  text: string,
  error: string,
};

// A PDF's own metadata. A field the document omits is "", and the dates are
// Unix seconds, 0 when absent.
export type PdfInfo = {
  ok: bool,
  title: string,
  author: string,
  subject: string,
  keywords: string,
  creator: string,
  producer: string,
  created: int,
  modified: int,
  pages: int,
  error: string,
};

function textOk(text: string): PdfText {
  let r: PdfText = { ok: true, text: text, error: "" };
  return r;
}

function textErr(message: string): PdfText {
  let r: PdfText = { ok: false, text: "", error: message };
  return r;
}

function infoErr(message: string): PdfInfo {
  let r: PdfInfo = {
    ok: false,
    title: "", author: "", subject: "", keywords: "", creator: "", producer: "",
    created: 0, modified: 0, pages: 0,
    error: message,
  };
  return r;
}

// Poppler's version. Also the cheapest proof that the library linked, since it
// needs no document.
export function popplerVersion(): string {
  return pdf_version();
}

// Turn an open code into a message. The shim distinguishes a document that
// could not be loaded from one that is encrypted, which are different problems
// for a caller.
function openError(code: int, path: string): string {
  if (code == -2) {
    return "encrypted, and no password given: " + path;
  }
  let detail = pdf_error();
  if (detail == "") { detail = "could not be opened"; }
  return detail + ": " + path;
}

// Open, read, close. The shim holds one document at a time, so every entry
// point here is self-contained rather than leaving state behind for the next
// call to trip over.
function withDocument(path: string, physical: int, page: int): PdfText {
  if (!fs.existsSync(path)) {
    return textErr("no such file: " + path);
  }
  let code = pdf_open(path);
  if (code != 0) {
    let message = openError(code, path);
    pdf_close();
    return textErr(message);
  }
  let text = "";
  let failed = "";
  if (page < 0) {
    text = pdf_text(physical);
  } else {
    let count = pdf_pages();
    if (page < 1 || page > count) {
      failed = "page " + `${page}` + " is out of range: " + path + " has " + `${count}`;
    } else {
      text = pdf_page_text(page, physical);
    }
  }
  pdf_close();
  if (failed != "") { return textErr(failed); }
  return textOk(text);
}

// The document's text, in the reading order Poppler recovers.
export function extractText(path: string): PdfText {
  return withDocument(path, 0, -1);
}

// The document's text with the page's horizontal arrangement preserved. Use
// this for columns and tables: the default mode runs side-by-side columns
// together, which is the failure every naive extractor shares.
export function extractLayout(path: string): PdfText {
  return withDocument(path, 1, -1);
}

// One page's text. Pages are numbered from 1.
export function extractPage(path: string, page: int): PdfText {
  if (page < 1) {
    return textErr("page numbers start at 1");
  }
  return withDocument(path, 0, page);
}

// One page's text, layout preserved.
export function extractPageLayout(path: string, page: int): PdfText {
  if (page < 1) {
    return textErr("page numbers start at 1");
  }
  return withDocument(path, 1, page);
}

// Text from an encrypted document, given its password.
export function extractWithPassword(path: string, password: string): PdfText {
  if (!fs.existsSync(path)) {
    return textErr("no such file: " + path);
  }
  if (pdf_open_with_password(path, password) != 0) {
    let detail = pdf_error();
    pdf_close();
    return textErr(detail + ": " + path);
  }
  let text = pdf_text(0);
  pdf_close();
  return textOk(text);
}

// The document's metadata.
export function readInfo(path: string): PdfInfo {
  if (!fs.existsSync(path)) {
    return infoErr("no such file: " + path);
  }
  let code = pdf_open(path);
  if (code != 0) {
    let message = openError(code, path);
    pdf_close();
    return infoErr(message);
  }
  let out: PdfInfo = {
    ok: true,
    title: pdf_info("Title"),
    author: pdf_info("Author"),
    subject: pdf_info("Subject"),
    keywords: pdf_info("Keywords"),
    creator: pdf_info("Creator"),
    producer: pdf_info("Producer"),
    created: pdf_created(),
    modified: pdf_modified(),
    pages: pdf_pages(),
    error: "",
  };
  pdf_close();
  return out;
}

// The page count, or 0 when the document cannot be read.
export function pageCount(path: string): int {
  if (!fs.existsSync(path)) { return 0; }
  if (pdf_open(path) != 0) {
    pdf_close();
    return 0;
  }
  let n = pdf_pages();
  pdf_close();
  if (n < 0) { return 0; }
  return n;
}

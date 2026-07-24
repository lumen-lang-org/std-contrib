# pdf

Text and metadata from PDF files, via Poppler.

## Why this delegates

A PDF does not contain text. It contains positioned glyphs with font-specific
encodings. Word spaces are frequently not encoded at all and must be inferred
from coordinates; reading order across columns is recorded nowhere; ligatures
are single glyphs that need a font's `ToUnicode` map to become characters; and a
scanned page has no text layer whatsoever. Extracting readable text means
interpreting content streams and walking font encodings.

Nobody hand-writes this. LangChain's PDF loaders wrap `pdf.js`, `pypdf` or
PDFium; the only ordering logic they add is a ten-line comparison of
y-coordinates, and it is the source of their most-reported bugs — words run
together, text split mid-word, side-by-side columns interleaved.

So this package delegates to [Poppler](https://poppler.freedesktop.org/), the
C++ library behind most PDF viewers on Linux. `pdftotext -layout` orders columns
better than any of those heuristics, and handles encodings and ligatures
correctly.

## Install

Poppler must be on `PATH`:

```sh
apt install poppler-utils     # Debian, Ubuntu
brew install poppler          # macOS
```

A missing tool is reported in the error of the first call, which says how to
install it.

## Use

```ts
import { extractText, extractLayout, extractPage, readInfo } from "https://lumen-lang.org/package/std-contrib/pdf/pdf.ts";

let r = extractText("manual.pdf");
if (!r.ok) {
  console.error(r.error);
} else {
  console.log(r.text);
}

// Columns and tables: layout mode keeps the page's horizontal arrangement.
let laid = extractLayout("report.pdf");

// One page, numbered from 1.
let page3 = extractPage("manual.pdf", 3);

let info = readInfo("manual.pdf");
console.log(`${info.pages} pages, by ${info.author}`);
```

## API

| function | returns |
| --- | --- |
| `extractText(path)` | `PdfText` — the whole document |
| `extractLayout(path)` | `PdfText` — layout preserved, for columns and tables |
| `extractPage(path, page)` | `PdfText` — one page, numbered from 1 |
| `extractPages(path, first, last)` | `PdfText` — an inclusive range |
| `readInfo(path)` | `PdfInfo` — title, author, dates, page count |
| `pageCount(path)` | `int` — 0 when it cannot be read |

`PdfText` is `{ ok, text, error }`. `PdfInfo` is `{ ok, title, author, subject,
keywords, creator, producer, creationDate, modificationDate, pages, encrypted,
error }`. A field the PDF omits is `""` — most PDFs carry few of them.

Every failure is reported, never raised: a missing file, a file that is not a
PDF, an encrypted document, and a missing Poppler all return `ok: false` with a
reason.

## With the ai package

`extractText` returns text, which is what the `ai` package's splitter takes, so
indexing a PDF is the two steps you would expect:

```ts
let r = extractText("manual.pdf");
if (r.ok) {
  let doc = loadText(r.text, "manual.pdf");
  let parts = splitDocument(doc, 1000, 200);
}
```

Use `extractLayout` when the source has columns: the default mode will run them
together, and chunks of interleaved columns retrieve poorly.

## Why the command-line tools rather than FFI

Lumen can link C directly — `sqlite` and `quickjs` in this repository do, through
a small shim and `// @link`. Poppler ships `libpoppler-cpp` with a stable C++
API, so an FFI binding is possible and would be the faster, quieter option: no
process per document, no inherited stderr, and access to per-page objects rather
than re-running a tool for each page.

This package spawns instead, because the tradeoff favours it for a first
version:

- `poppler-utils` is a package manager away on any machine; FFI needs
  `libpoppler-cpp-dev`, a compiled shim, and a build step per platform.
- Spawning cannot corrupt this process. A malformed PDF that crashes the parser
  takes the child down, not the program — worth something when the input is
  user-uploaded.
- Poppler's C++ API is objects and exceptions, which the scalar-and-string FFI
  cannot express directly; it would need a flattening shim, as SQLite's
  out-pointers did.

An FFI binding is the natural upgrade if per-document process cost shows up in
profiling, and it can land behind this same API.

## Limits

- **Scanned PDFs yield nothing.** A page that is an image has no text layer, and
  this does no OCR. Poppler's `pdftoppm` plus Tesseract is the usual answer, and
  is not wrapped here.
- **Poppler's warnings reach stderr and cannot be suppressed from here.** A
  spawned process inherits stderr, so "May not be a PDF file" appears in your
  output even though the call itself reports the failure cleanly. This is also
  why there is no `available()` probe: Poppler prints its version to stderr too,
  so nothing readable distinguishes "not installed" from "installed and quiet".
- **No encrypted-PDF passwords.** An encrypted document is reported as such
  rather than decrypted.
- Reading order for a heavily designed page — a magazine layout, a form — is as
  good as Poppler's, which is good but not perfect. `extractLayout` helps.

## Tests

```sh
lumen test packages/pdf/pdf.test.ts
```

The fixtures are PDFs the test writes itself, cross-reference offsets and all,
so there are no binary files in the repository and the bytes under test are
visible in the source.

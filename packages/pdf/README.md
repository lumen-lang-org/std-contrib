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

| function | `pdf_ffi.ts` | `pdf.ts` | returns |
| --- | --- | --- | --- |
| `extractText(path)` | yes | yes | the whole document |
| `extractLayout(path)` | yes | yes | layout preserved, for columns and tables |
| `extractPage(path, page)` | yes | yes | one page, numbered from 1 |
| `extractPageLayout(path, page)` | yes | — | one page, layout preserved |
| `extractPages(path, first, last)` | — | yes | an inclusive range |
| `extractWithPassword(path, pw)` | yes | — | an encrypted document |
| `readInfo(path)` | yes | yes | title, author, dates, page count |
| `pageCount(path)` | yes | yes | 0 when it cannot be read |
| `popplerVersion()` | yes | — | the linked library's version |

`PdfText` is `{ ok, text, error }` in both. `PdfInfo` differs: the FFI form
reports `created` and `modified` as Unix seconds (0 when absent), the subprocess
form reports `creationDate` and `modificationDate` as the strings `pdfinfo`
prints, and carries `encrypted`. A field the PDF omits is `""` — most PDFs carry
few of them.

The two modules declare the same type names, so a program imports one or the
other, not both.

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

## Two forms: linked, or spawned

The package ships the same API twice.

**`pdf_ffi.ts` links Poppler into the binary.** `poppler_shim.cpp` flattens
poppler-cpp's objects and `ustring` to the scalars and C strings the FFI carries,
the way SQLite's shim flattens its out-pointers. A document is opened once and
then read, so pages cost nothing extra.

**`pdf.ts` spawns `pdftotext` and `pdfinfo`.** No build step, no headers — if
Poppler is installed, it works.

Measured over 200 extractions of a three-page document:

```
ffi            248ms
subprocess    3332ms
```

**13×**, and the gap widens with page count, because the subprocess form reruns
the tool — reparsing the file — for every page or range.

Take the FFI form unless a build step is unacceptable. Take the subprocess form
when you want a binary that runs anywhere Poppler happens to be installed, or
when the input is untrusted enough that you would rather a malformed PDF crash a
child process than yours.

### Building the shim

```sh
apt install libpoppler-cpp-dev     # Debian, Ubuntu
brew install poppler               # macOS
sh packages/pdf/build.sh
```

`build.sh` finds the headers and produces `poppler_shim.o`. Because `// @link`
paths resolve against the working directory, compile a program that imports
`pdf_ffi.ts` from this directory, or adjust the pragma to an absolute path.

The `// @link` lines name libstdc++ and libgcc_s by absolute path, which is
correct for Debian and Ubuntu. On another distribution or on macOS, point them
at that system's C++ runtime and unwinder — a bare `-lstdc++` does not resolve
under the Zig-hosted linker, and without the unwinder `_Unwind_Resume` is left
undefined because Poppler's API can throw.

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

<!-- website:skip -->
## Tests

```sh
lumen test packages/pdf/pdf.test.ts          # subprocess form, from anywhere
cd packages/pdf && lumen test pdf_ffi.test.ts # FFI form, from this directory
```

The fixtures are PDFs the test writes itself, cross-reference offsets and all,
so there are no binary files in the repository and the bytes under test are
visible in the source.
<!-- /website:skip -->

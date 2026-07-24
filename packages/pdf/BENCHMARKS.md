# pdf benchmarks

Poppler linked through the FFI, against LangChain's `PDFLoader` on Node.

Both read the same files. LangChain reaches `pdf.js` through `pdf-parse`; this
package reaches Poppler through `poppler_shim.cpp`.

Machine: x86-64 Linux, Node v20.18.1, `@langchain/community` with `pdf-parse@1`,
Poppler 25.03.0. Fixtures are generated PDFs — a 3-page document, a 50-page
document of 30 lines per page, and a single two-column page.

## Throughput

Each figure is a warm loop: the first extraction is discarded so neither side
pays module initialisation or first-call setup.

| document | iterations | LangChain | Lumen FFI | Lumen subprocess |
| --- | --- | --- | --- | --- |
| 3 pages | 200 | 486 ms | **248 ms** | 3332 ms |
| 50 pages, 1500 lines | 20 | 1229 ms | **432 ms** | — |

Linked Poppler is about **2×** LangChain on the small document and **2.8×** on
the 50-page one. Both extract the same text: 92,380 characters against
LangChain's 92,328, the difference being page-join whitespace.

The subprocess form is an order of magnitude behind both, which is the cost of a
process per document rather than anything about Poppler.

## Startup

One extraction, measured as wall-clock time for the whole command — the figure
that matters for a CLI, a cron job, or a cold serverless invocation.

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| `node one.mjs` | 0.63 s | 0.56 s | 0.57 s |
| Lumen native binary | 0.01 s | 0.02 s | 0.02 s |

**About 30×.** Node spends roughly half a second starting the runtime and
loading `pdf.js` before any PDF is read; the Lumen binary has no runtime to
start. On a warm long-lived server this does not matter. On anything invoked
per-document it dominates everything else.

## Reading order: two columns

Speed is the less interesting difference. This page has two columns of text at
the same vertical positions — the shape of a paper, a report, or a newsletter.

LangChain groups text items by y-coordinate and joins them with an empty
separator (`text_splitter.ts`'s ten-line heuristic, copied from a `pdf-parse`
fork). Both columns share every y, so they interleave, and with no separator the
words collide:

```
LEFT-01 this is the left column sentenceRIGHT-01 this is the right column sentence
LEFT-02 this is the left column sentenceRIGHT-02 this is the right column sentence
```

`sentenceRIGHT-01` is not a word. Chunk that, embed it, and the token is noise in
the index.

Poppler's default keeps the columns apart with a space:

```
LEFT-01 this is the left column sentence RIGHT-01 this is the right column sentence
```

and `extractLayout` preserves the visual arrangement, so the column boundary
survives into the text:

```
LEFT-01 this is the left column sentence   RIGHT-01 this is the right column sentence
```

Neither reads the left column top-to-bottom before the right — that needs real
column detection, which none of these do. But the failure modes differ in kind:
Poppler produces words a retriever can match, and LangChain produces glued
tokens it cannot.

## Reading these numbers

- The throughput figures exclude startup for both, which flatters Node; the
  startup table is where that shows.
- Fixtures are synthetic and text-only. A scanned PDF yields nothing from either
  without OCR, and a heavily designed page will challenge both.
- Poppler and pdf.js are both mature. The speed gap is mostly C++ against
  JavaScript plus the absence of a runtime, not one parser being cleverer.
- The subprocess column exists to show what the FFI buys. If a build step is
  unacceptable, that form still works, an order of magnitude slower.

Reproduce with `packages/pdf/build.sh`, then compile a program importing
`pdf_ffi.ts` from `packages/pdf`.

// Recursive text splitting with provenance.
//
// Chunks are produced as byte ranges into the text they came from, and only
// turned into strings at the end. That is what lets every chunk report where it
// came from, and it makes overlap exact: extending a chunk backwards is moving
// an offset, not re-slicing a string and hoping the arithmetic matches.
//
// The algorithm is LangChain's RecursiveCharacterTextSplitter, with two of its
// behaviours corrected — see spec.md 9a. Sizes are byte counts, because a Lumen
// string is UTF-8 indexed by byte, as in Zig.

import { makeDocument, withMetadata, AiDocument } from "./document.ts";

// A piece of a larger text, and where it came from. `start` and `end` are byte
// offsets into that text, so `text.substring(start, end)` is exactly `text`.
// `forced` marks a chunk whose boundary fell inside a word because the text
// offered no separator to break on — a long URL, or a run of CJK with no
// spaces. The chunk is still valid UTF-8; only the word was broken.
export type AiChunk = {
  text: string,
  start: int,
  end: int,
  forced: bool,
};

// Ordered widest to narrowest. The CRLF spellings are listed so a Windows
// document breaks on paragraphs rather than falling through to words; listing
// them is what lets offsets index the original text, since normalizing newlines
// first would shift every offset after the first CRLF.
const SPLIT_SEPARATORS: string[] = ["\r\n\r\n", "\n\n", "\r\n", "\n", ". ", " "];

// Markdown: headings first, so a section stays whole where it can, then the
// prose separators. Level 1 is deliberately absent — a document usually has one
// title, and breaking on it yields a chunk holding only that title.
const MARKDOWN_SEPARATORS: string[] = ["\n## ", "\n### ", "\n#### ", "\n##### ", "\n\n", "\n", ". ", " "];

// Brace languages: declarations first, then blocks, then lines. One table
// serves them because the shapes that matter — a top-level declaration begins
// at column zero after a blank line — are shared.
const CODE_SEPARATORS: string[] = ["\nclass ", "\nfunction ", "\nexport ", "\nfn ", "\npub fn ", "\ndef ", "\n\n", "\n", " "];

export function textSeparators(): string[] {
  return SPLIT_SEPARATORS;
}

export function markdownSeparators(): string[] {
  return MARKDOWN_SEPARATORS;
}

export function codeSeparators(): string[] {
  return CODE_SEPARATORS;
}

function chunkAt(text: string, start: int, end: int, forced: bool): AiChunk {
  let c: AiChunk = {
    text: text.substring(start, end),
    start: start,
    end: end,
    forced: forced,
  };
  return c;
}

// UTF-8 continuation bytes are 10xxxxxx, so a byte can be tested for
// "starts a code point" on its own — the property that makes cutting UTF-8 by
// byte offset safe without decoding anything.
function isContinuation(text: string, at: int): bool {
  if (at <= 0 || at >= text.length) { return false; }
  let code = text.charCodeAt(at);
  return code >= 128 && code < 192;
}

function charStart(text: string, at: int): int {
  let i = at;
  if (i > text.length) { return text.length; }
  while (isContinuation(text, i)) { i = i - 1; }
  return i;
}

function charEnd(text: string, at: int): int {
  let i = at;
  while (isContinuation(text, i)) { i = i + 1; }
  return i;
}

function occursIn(text: string, start: int, end: int, sep: string): bool {
  if (sep == "") { return false; }
  let i = start;
  while (i + sep.length <= end) {
    if (text.substring(i, i + sep.length) == sep) { return true; }
    i = i + 1;
  }
  return false;
}

// A separator that opens a section rather than closing one: a markdown heading
// or a declaration keyword, which begins on its own line. The test is whether
// anything but a newline follows the leading newline, which is what separates
// "\n## " and "\nfunction " from "\n\n" and "\n".
function isOpener(sep: string): bool {
  if (sep.length < 2 || sep.charAt(0) != "\n") { return false; }
  let i: int = 1;
  while (i < sep.length) {
    let c = sep.charAt(i);
    if (c != "\n" && c != "\r") { return true; }
    i = i + 1;
  }
  return false;
}

// Split [start, end) on `sep`. A separator that terminates a piece stays with
// the piece it terminates; a separator that opens one starts the piece that
// follows. LangChain uses a lookahead regex for every separator, so it always
// attaches to the following piece — right for a heading, wrong for a full stop,
// and the reason Chinese chunks there begin with one (langchain#18770).
//
// Returns flattened [start0, end0, start1, end1, ...] because a Lumen record is
// immutable, so a list of ranges cannot be built up by mutation.
function pieceBounds(text: string, start: int, end: int, sep: string): int[] {
  let out: int[] = [];
  let opener = isOpener(sep);
  let cur = start;
  let i = start;
  while (i + sep.length <= end) {
    if (text.substring(i, i + sep.length) == sep) {
      // An opener cuts before itself, so it heads the next piece; a terminator
      // cuts after itself, so it tails the piece it ended.
      let stop = i + sep.length;
      if (opener) { stop = i; }
      if (stop > cur) {
        out.push(cur);
        out.push(stop);
      }
      cur = stop;
      i = i + sep.length;
      continue;
    }
    i = i + 1;
  }
  if (cur < end) {
    out.push(cur);
    out.push(end);
  }
  return out;
}

// Adjacent pieces joined while they fit the budget. The pieces are contiguous
// ranges, so joining is extending an offset — no string is built here.
function mergeBounds(bounds: int[], size: int): int[] {
  let out: int[] = [];
  if (bounds.length == 0) { return out; }
  let curStart = bounds[0];
  let curEnd = bounds[1];
  let i: int = 2;
  while (i < bounds.length) {
    let pStart = bounds[i];
    let pEnd = bounds[i + 1];
    if (pEnd - curStart <= size) {
      curEnd = pEnd;
    } else {
      out.push(curStart);
      out.push(curEnd);
      curStart = pStart;
      curEnd = pEnd;
    }
    i = i + 2;
  }
  out.push(curStart);
  out.push(curEnd);
  return out;
}

// The last resort: cut at the byte budget, pulled back to a code point
// boundary. Reached only when the text offers no separator at all, which is
// where a language written without spaces ends up. Chunks stay within the
// budget — an embedding endpoint rejects anything larger — and are marked
// `forced` so a caller can see that a word was broken.
function hardCut(text: string, start: int, end: int, size: int): AiChunk[] {
  let out: AiChunk[] = [];
  let cur = start;
  while (cur < end) {
    if (end - cur <= size) {
      out = [...out, chunkAt(text, cur, end, cur > start)];
      return out;
    }
    let stop = charStart(text, cur + size);
    if (stop <= cur) { stop = charEnd(text, cur + size); }
    if (stop <= cur || stop > end) { stop = end; }
    out = [...out, chunkAt(text, cur, stop, true)];
    cur = stop;
  }
  return out;
}

// The recursion. A range that fits is kept whole; otherwise the first separator
// present divides it, pieces that fit accumulate, and a piece that does not is
// re-split with the remaining, narrower separators. That is the difference
// between splitting by structure and cutting at a byte count: only the pieces
// that are actually too long get broken down further.
// An array argument is copied, not shared, so every step returns its chunks
// and the caller joins them rather than filling a buffer passed down.
function splitRange(text: string, start: int, end: int, seps: string[], from: int, size: int): AiChunk[] {
  let out: AiChunk[] = [];
  if (end <= start) { return out; }
  if (end - start <= size) {
    out = [...out, chunkAt(text, start, end, false)];
    return out;
  }
  let k = from;
  while (k < seps.length && !occursIn(text, start, end, seps[k])) { k = k + 1; }
  if (k >= seps.length) {
    return hardCut(text, start, end, size);
  }
  let bounds = pieceBounds(text, start, end, seps[k]);
  if (bounds.length <= 2) {
    // The separator occurs, but not in a position that divides this range (at
    // its very end, say). Move on rather than recursing on the same range.
    return splitRange(text, start, end, seps, k + 1, size);
  }
  let pending: int[] = [];
  let i: int = 0;
  while (i < bounds.length) {
    let pStart = bounds[i];
    let pEnd = bounds[i + 1];
    if (pEnd - pStart > size) {
      out = [...out, ...flushPending(text, pending, size)];
      let fresh: int[] = [];
      pending = fresh;
      out = [...out, ...splitRange(text, pStart, pEnd, seps, k + 1, size)];
    } else {
      pending = [...pending, pStart, pEnd];
    }
    i = i + 2;
  }
  out = [...out, ...flushPending(text, pending, size)];
  return out;
}

function flushPending(text: string, pending: int[], size: int): AiChunk[] {
  let out: AiChunk[] = [];
  if (pending.length == 0) { return out; }
  let merged = mergeBounds(pending, size);
  let i: int = 0;
  while (i < merged.length) {
    out = [...out, chunkAt(text, merged[i], merged[i + 1], false)];
    i = i + 2;
  }
  return out;
}

// Extend each chunk backwards by `overlap` bytes.
//
// LangChain applies overlap only while resolving an overflow, so a document
// whose pieces all fit gets none at all despite asking for it
// (langchain#34804); and what it does apply is whatever whole pieces survive
// eviction, so the figure is never the one configured. Here overlap is a byte
// count taken off the chunk's own start, backed off to a code point boundary,
// and it applies whenever a chunk has a predecessor to overlap into.
// `list`, not `chunks`: modules are inlined into one namespace, so a parameter
// may not share a name with any top-level declaration, and the barrel exports a
// `chunks` function.
function applyOverlap(text: string, list: AiChunk[], overlap: int): AiChunk[] {
  if (overlap <= 0 || list.length < 2) { return list; }
  let out: AiChunk[] = [list[0]];
  let i: int = 1;
  while (i < list.length) {
    let c = list[i];
    let want = c.start - overlap;
    let floor = list[i - 1].start + 1;
    if (want < floor) { want = floor; }
    let at = charEnd(text, want);
    if (at >= c.start) {
      out.push(c);
    } else {
      out.push(chunkAt(text, at, c.end, c.forced));
    }
    i = i + 1;
  }
  return out;
}

// A piece that is only whitespace is not worth returning on its own, but its
// bytes still belong to the document: dropping them outright would leave a hole
// between one chunk's end and the next one's start, and the chunks would no
// longer reconstruct the text. So a blank piece is absorbed into its neighbour
// — the previous chunk's end is extended over it, or the first real chunk's
// start is pulled back to cover a leading run.
//
// The one case that still yields nothing is a document that is entirely
// whitespace, which has no content to chunk.
function dropEmpty(text: string, list: AiChunk[]): AiChunk[] {
  let out: AiChunk[] = [];
  let carry: int = -1;
  let i: int = 0;
  while (i < list.length) {
    let c = list[i];
    if (c.text.trim() != "") {
      let from = c.start;
      if (carry >= 0) {
        from = carry;
        carry = -1;
      }
      out = [...out, chunkAt(text, from, c.end, c.forced)];
    } else {
      if (out.length > 0) {
        let prev = out[out.length - 1];
        out = [...out.slice(0, out.length - 1), chunkAt(text, prev.start, c.end, prev.forced)];
      } else {
        if (carry < 0) { carry = c.start; }
      }
    }
    i = i + 1;
  }
  return out;
}

// Split with an explicit separator list. `size` and `overlap` are byte counts;
// an overlap at or above the size would not advance, and is clamped rather than
// rejected so a caller cannot hang.
export function splitChunksWith(text: string, seps: string[], size: int, overlap: int): AiChunk[] {
  let out: AiChunk[] = [];
  if (text == "" || size <= 0) { return out; }
  // An overlap at or above the size would not advance, so it is clamped rather
  // than rejected: this returns a list of chunks and has no error channel to
  // report a rejection through, and hanging is the worse outcome.
  let over = overlap;
  if (over < 0) { over = 0; }
  if (over >= size) { over = size - 1; }
  out = splitRange(text, 0, text.length, seps, 0, size);
  return applyOverlap(text, dropEmpty(text, out), over);
}

// Split prose.
export function splitChunks(text: string, size: int, overlap: int): AiChunk[] {
  return splitChunksWith(text, SPLIT_SEPARATORS, size, overlap);
}

// Split markdown, breaking at headings before prose boundaries.
export function splitMarkdownChunks(text: string, size: int, overlap: int): AiChunk[] {
  return splitChunksWith(text, MARKDOWN_SEPARATORS, size, overlap);
}

// Split source code, breaking at declarations before blank lines.
export function splitCodeChunks(text: string, size: int, overlap: int): AiChunk[] {
  return splitChunksWith(text, CODE_SEPARATORS, size, overlap);
}

// --- documents --------------------------------------------------------------

function intText(n: int): string {
  return `${n}`;
}

// Split a document, carrying its metadata into every chunk and recording where
// each came from. A chunk that cannot say where it came from cannot be cited,
// which is most of what retrieval is for.
//
// Each chunk's metadata gains `chunk` (its index), `start` and `end` (its byte
// range in the parent), and `parent` (the parent's id). Keys already present on
// the parent are kept.
export function splitDocumentChunks(doc: AiDocument, seps: string[], size: int, overlap: int): AiDocument[] {
  let out: AiDocument[] = [];
  let parts = splitChunksWith(doc.text, seps, size, overlap);
  let i: int = 0;
  while (i < parts.length) {
    let c = parts[i];
    let child = makeDocument(doc.id + "#" + intText(i), c.text, doc.source, doc.metadata);
    child = withMetadata(child, "chunk", intText(i));
    child = withMetadata(child, "start", intText(c.start));
    child = withMetadata(child, "end", intText(c.end));
    child = withMetadata(child, "parent", doc.id);
    if (c.forced) { child = withMetadata(child, "forced", "1"); }
    out.push(child);
    i = i + 1;
  }
  return out;
}

export function splitDocumentProse(doc: AiDocument, size: int, overlap: int): AiDocument[] {
  return splitDocumentChunks(doc, SPLIT_SEPARATORS, size, overlap);
}

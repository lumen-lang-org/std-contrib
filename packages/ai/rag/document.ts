// Retrieval documents and text splitters.

type AiDocument = {
  id: string,
  text: string,
  source: string,
  metadata: string,
};

function isDocSpace(c: string): bool {
  return c == " " || c == "\t" || c == "\r" || c == "\n";
}

function trimDocEdges(s: string): string {
  let start: int = 0;
  let end: int = s.length;
  while (start < end && isDocSpace(s.charAt(start))) { start = start + 1; }
  while (end > start && isDocSpace(s.charAt(end - 1))) { end = end - 1; }
  return s.substring(start, end);
}

function docIntText(n: int): string {
  return `${n}`;
}

// Largest index i with `from <= i` and `i + pattern.length <= limit`, or -1.
function docLastIndexIn(src: string, pattern: string, from: int, limit: int): int {
  let found: int = -1;
  let i = from;
  while (i + pattern.length <= limit) {
    if (src.substring(i, i + pattern.length) == pattern) { found = i; }
    i = i + 1;
  }
  return found;
}

// Overlap is clamped into [0, size - 1] so the cursor always advances.
function docClampOverlap(size: int, overlap: int): int {
  if (overlap < 0) { return 0; }
  if (overlap >= size) { return size - 1; }
  return overlap;
}

// A UTF-8 continuation byte is 10xxxxxx, so it is never the first byte of a
// code point. Indices are byte offsets, which is what makes this necessary.
function isDocContinuationByte(text: string, at: int): bool {
  if (at <= 0 || at >= text.length) { return false; }
  let code = text.charCodeAt(at);
  return code >= 128 && code < 192;
}

// Largest index at or below `at` that starts a code point.
function docCharStart(text: string, at: int): int {
  let i = at;
  while (isDocContinuationByte(text, i)) { i = i - 1; }
  return i;
}

// Smallest index at or above `at` that starts a code point.
function docCharEnd(text: string, at: int): int {
  let i = at;
  while (isDocContinuationByte(text, i)) { i = i + 1; }
  return i;
}

// A cut at `end` that lands inside a code point is pulled back to the code
// point's first byte, or pushed forward when pulling back would not leave any
// text in the chunk.
function docSafeCut(text: string, start: int, end: int): int {
  let cut = docCharStart(text, end);
  if (cut <= start) { cut = docCharEnd(text, end); }
  return cut;
}

// CRLF and lone CR become LF, so a Windows or HTTP-fetched document splits on
// blank lines exactly like a Unix one.
function docNormalizeNewlines(text: string): string {
  if (text.indexOf("\r") < 0) { return text; }
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charAt(i);
    if (c == "\r") {
      out = out + "\n";
      if (i + 1 < text.length && text.charAt(i + 1) == "\n") { i = i + 1; }
    } else {
      out = out + c;
    }
    i = i + 1;
  }
  return out;
}

// Largest natural boundary inside (start, end]: paragraph, then line, then
// word, then a code point boundary as a last resort. The CRLF spellings are
// listed alongside the LF ones so a Windows document still breaks on
// paragraphs rather than silently falling through to word breaking.
function docBestBreak(text: string, start: int, end: int): int {
  const separators: string[] = ["\r\n\r\n", "\n\n", "\r\n", "\n", " "];
  for (const separator of separators) {
    let at = docLastIndexIn(text, separator, start + 1, end);
    if (at > start) { return at + separator.length; }
  }
  return docSafeCut(text, start, end);
}

export function makeDocument(id: string, text: string, source: string, metadata: string): AiDocument {
  return {
    id: id,
    text: text,
    source: source,
    metadata: metadata,
  };
}

// Metadata is a newline-delimited list of tab-delimited pairs, so a raw tab or
// newline inside a key or a value would forge an entry the reader then trusts.
// Both delimiters (and the escape character itself) are backslash-escaped on
// write and restored on read; text without them is stored verbatim.
function docEscapeField(s: string): string {
  let out = "";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "\\") {
      out = out + "\\\\";
    } else if (c == "\t") {
      out = out + "\\t";
    } else if (c == "\n") {
      out = out + "\\n";
    } else if (c == "\r") {
      out = out + "\\r";
    } else {
      out = out + c;
    }
    i = i + 1;
  }
  return out;
}

function docUnescapeField(s: string): string {
  if (s.indexOf("\\") < 0) { return s; }
  let out = "";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "\\" && i + 1 < s.length) {
      let next = s.charAt(i + 1);
      if (next == "\\" || next == "t" || next == "n" || next == "r") {
        if (next == "\\") { out = out + "\\"; }
        if (next == "t") { out = out + "\t"; }
        if (next == "n") { out = out + "\n"; }
        if (next == "r") { out = out + "\r"; }
        i = i + 2;
        continue;
      }
    }
    out = out + c;
    i = i + 1;
  }
  return out;
}

export function documentMetadata(doc: AiDocument, key: string): string {
  if (doc.metadata == "" || key == "") { return ""; }
  let wanted = docEscapeField(key);
  let lines = doc.metadata.split("\n");
  for (const line of lines) {
    let tab = line.indexOf("\t");
    if (tab >= 0 && line.substring(0, tab) == wanted) {
      return docUnescapeField(line.substring(tab + 1, line.length));
    }
  }
  return "";
}

export function withMetadata(doc: AiDocument, key: string, value: string): AiDocument {
  if (key == "") { return doc; }
  let name = docEscapeField(key);
  let entry = name + "\t" + docEscapeField(value);
  let out = "";
  let replaced: bool = false;
  if (doc.metadata != "") {
    let lines = doc.metadata.split("\n");
    for (const line of lines) {
      let tab = line.indexOf("\t");
      let existing = line;
      if (tab >= 0) { existing = line.substring(0, tab); }
      if (existing == name) {
        if (!replaced) {
          if (out != "") { out = out + "\n"; }
          out = out + entry;
          replaced = true;
        }
      } else if (line != "") {
        if (out != "") { out = out + "\n"; }
        out = out + line;
      }
    }
  }
  if (!replaced) {
    if (out != "") { out = out + "\n"; }
    out = out + entry;
  }
  return makeDocument(doc.id, doc.text, doc.source, out);
}

export function splitFixed(text: string, size: int, overlap: int): string[] {
  let out: string[] = [];
  if (text == "") { return out; }
  if (size <= 0) {
    out.push(text);
    return out;
  }
  let step = size - docClampOverlap(size, overlap);
  let start: int = 0;
  while (start < text.length) {
    let end = start + size;
    if (end >= text.length) {
      out.push(text.substring(start, text.length));
      return out;
    }
    // `size` is a byte budget, but a chunk is embedded, JSON-encoded and
    // rendered on its own, so it must still be valid UTF-8 on both edges.
    let cut = docSafeCut(text, start, end);
    if (cut >= text.length) {
      out.push(text.substring(start, text.length));
      return out;
    }
    out.push(text.substring(start, cut));
    let next = docCharStart(text, start + step);
    if (next <= start) { next = docCharEnd(text, start + step); }
    if (next <= start) { next = cut; }
    start = next;
  }
  return out;
}

export function splitRecursive(text: string, size: int, overlap: int): string[] {
  let out: string[] = [];
  if (text == "") { return out; }
  if (size <= 0) {
    out.push(text);
    return out;
  }
  let step = docClampOverlap(size, overlap);
  let start: int = 0;
  while (start < text.length) {
    let end = start + size;
    if (end >= text.length) {
      let tail = trimDocEdges(text.substring(start, text.length));
      if (tail != "") { out.push(tail); }
      return out;
    }
    let cut = docBestBreak(text, start, end);
    let chunk = trimDocEdges(text.substring(start, cut));
    if (chunk != "") { out.push(chunk); }
    let next = cut - step;
    if (next <= start) { next = start + 1; }
    // Backing off by the overlap can land inside a code point, so the next
    // chunk starts at the following code point boundary.
    next = docCharEnd(text, next);
    start = next;
  }
  return out;
}

export function splitParagraphs(text: string): string[] {
  let out: string[] = [];
  if (text == "") { return out; }
  let parts = docNormalizeNewlines(text).split("\n\n");
  for (const part of parts) {
    let paragraph = trimDocEdges(part);
    if (paragraph != "") { out.push(paragraph); }
  }
  return out;
}

export function splitToDocuments(text: string, source: string, size: int, overlap: int): AiDocument[] {
  let out: AiDocument[] = [];
  let chunks = splitRecursive(text, size, overlap);
  let i: int = 0;
  while (i < chunks.length) {
    out.push(makeDocument(source + "#" + docIntText(i), chunks[i], source, ""));
    i = i + 1;
  }
  return out;
}

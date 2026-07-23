// Retrieval documents and text splitters.

type LumenAiDocument = {
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

export function makeDocument(id: string, text: string, source: string, metadata: string): LumenAiDocument {
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

export function documentMetadata(doc: LumenAiDocument, key: string): string {
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

export function withMetadata(doc: LumenAiDocument, key: string, value: string): LumenAiDocument {
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

export function splitToDocuments(text: string, source: string, size: int, overlap: int): LumenAiDocument[] {
  let out: LumenAiDocument[] = [];
  let chunks = splitRecursive(text, size, overlap);
  let i: int = 0;
  while (i < chunks.length) {
    out.push(makeDocument(source + "#" + docIntText(i), chunks[i], source, ""));
    i = i + 1;
  }
  return out;
}

test("make document", () => {
  let doc = makeDocument("d1", "hello", "notes.txt", "");
  expect(doc.id == "d1");
  expect(doc.text == "hello");
  expect(doc.source == "notes.txt");
  expect(doc.metadata == "");
});

test("document metadata read and write", () => {
  let doc = makeDocument("d1", "hello", "notes.txt", "");
  expect(documentMetadata(doc, "page") == "");
  let tagged = withMetadata(doc, "page", "3");
  expect(tagged.metadata == "page\t3");
  expect(documentMetadata(tagged, "page") == "3");
  expect(doc.metadata == "");
  let more = withMetadata(tagged, "author", "Ada");
  expect(more.metadata == "page\t3\nauthor\tAda");
  expect(documentMetadata(more, "author") == "Ada");
  expect(documentMetadata(more, "page") == "3");
  expect(documentMetadata(more, "missing") == "");
  expect(documentMetadata(more, "") == "");
});

test("with metadata replaces in place", () => {
  let doc = makeDocument("d1", "hello", "notes.txt", "page\t3\nauthor\tAda");
  let updated = withMetadata(doc, "page", "7");
  expect(updated.metadata == "page\t7\nauthor\tAda");
  expect(documentMetadata(updated, "page") == "7");
  expect(documentMetadata(doc, "page") == "3");
  expect(withMetadata(doc, "", "x").metadata == "page\t3\nauthor\tAda");
});

test("split fixed", () => {
  let chunks = splitFixed("abcdefghij", 4, 0);
  expect(chunks.length == 3);
  expect(chunks[0] == "abcd");
  expect(chunks[1] == "efgh");
  expect(chunks[2] == "ij");
});

test("split fixed with overlap", () => {
  let chunks = splitFixed("abcdefgh", 4, 2);
  expect(chunks.length == 3);
  expect(chunks[0] == "abcd");
  expect(chunks[1] == "cdef");
  expect(chunks[2] == "efgh");
});

test("split fixed degenerate inputs", () => {
  expect(splitFixed("", 10, 0).length == 0);
  let whole = splitFixed("abcdef", 0, 0);
  expect(whole.length == 1);
  expect(whole[0] == "abcdef");
  let negative = splitFixed("abcdef", -3, 2);
  expect(negative.length == 1);
  let clamped = splitFixed("abcdef", 3, 9);
  expect(clamped.length == 4);
  expect(clamped[0] == "abc");
  expect(clamped[1] == "bcd");
  expect(clamped[3] == "def");
  let negativeOverlap = splitFixed("abcdef", 3, -4);
  expect(negativeOverlap.length == 2);
  expect(negativeOverlap[0] == "abc");
});

test("split recursive prefers paragraph then line then word", () => {
  let chunks = splitRecursive("alpha beta\n\ngamma delta\nepsilon zeta", 16, 0);
  expect(chunks.length == 3);
  expect(chunks[0] == "alpha beta");
  expect(chunks[1] == "gamma delta");
  expect(chunks[2] == "epsilon zeta");
});

test("split recursive breaks on words", () => {
  let chunks = splitRecursive("aa bb cc dd", 5, 0);
  expect(chunks.length == 3);
  expect(chunks[0] == "aa");
  expect(chunks[1] == "bb");
  expect(chunks[2] == "cc dd");
});

test("split recursive falls back to mid-word", () => {
  let chunks = splitRecursive("abcdefghij", 4, 0);
  expect(chunks.length == 3);
  expect(chunks[0] == "abcd");
  expect(chunks[1] == "efgh");
  expect(chunks[2] == "ij");
});

test("split recursive degenerate inputs", () => {
  expect(splitRecursive("", 10, 0).length == 0);
  let whole = splitRecursive("abc def", 0, 0);
  expect(whole.length == 1);
  expect(whole[0] == "abc def");
  let clamped = splitRecursive("abcdefgh", 4, 12);
  expect(clamped.length > 0);
  expect(clamped[0] == "abcd");
  let onlySpaces = splitRecursive("     ", 2, 0);
  expect(onlySpaces.length == 0);
});

test("split paragraphs", () => {
  let parts = splitParagraphs("first line\nstill first\n\n  second  \n\n\n\nthird");
  expect(parts.length == 3);
  expect(parts[0] == "first line\nstill first");
  expect(parts[1] == "second");
  expect(parts[2] == "third");
  expect(splitParagraphs("").length == 0);
  expect(splitParagraphs("\n\n\n\n").length == 0);
});

test("split to documents", () => {
  let docs = splitToDocuments("alpha beta\n\ngamma delta\nepsilon zeta", "notes.txt", 16, 0);
  expect(docs.length == 3);
  expect(docs[0].id == "notes.txt#0");
  expect(docs[1].id == "notes.txt#1");
  expect(docs[2].id == "notes.txt#2");
  expect(docs[0].text == "alpha beta");
  expect(docs[2].source == "notes.txt");
  expect(docs[0].metadata == "");
  expect(splitToDocuments("", "notes.txt", 16, 0).length == 0);
});

test("metadata values cannot forge another key", () => {
  let doc = makeDocument("d1", "t", "s", "");
  let tagged = withMetadata(doc, "lang", "en\nrole\tadmin");
  expect(tagged.metadata.indexOf("\n") < 0);
  expect(documentMetadata(tagged, "role") == "");
  expect(documentMetadata(tagged, "lang") == "en\nrole\tadmin");
  let note = withMetadata(doc, "note", "hello\nrole\tadmin");
  expect(documentMetadata(note, "role") == "");
  expect(documentMetadata(note, "note") == "hello\nrole\tadmin");
  let genuine = withMetadata(doc, "role", "admin");
  expect(documentMetadata(genuine, "role") == "admin");
});

test("metadata keys with delimiters stay distinct", () => {
  let doc = makeDocument("d1", "t", "s", "");
  let odd = withMetadata(doc, "a\tb", "v");
  expect(documentMetadata(odd, "a\tb") == "v");
  expect(documentMetadata(odd, "a") == "");
  let both = withMetadata(odd, "a", "other");
  expect(documentMetadata(both, "a\tb") == "v");
  expect(documentMetadata(both, "a") == "other");
  let backslash = withMetadata(doc, "path", "C:\\notes\\a.txt");
  expect(documentMetadata(backslash, "path") == "C:\\notes\\a.txt");
  let literal = withMetadata(doc, "raw", "not\\ta tab");
  expect(documentMetadata(literal, "raw") == "not\\ta tab");
});

// Every byte sequence in the chunk decodes as a complete code point: no lone
// lead byte at the end, no orphaned continuation byte at the start.
function docIsValidUtf8(s: string): bool {
  let i: int = 0;
  while (i < s.length) {
    let lead = s.charCodeAt(i);
    let extra: int = 0;
    if (lead < 128) {
      extra = 0;
    } else if (lead >= 240) {
      extra = 3;
    } else if (lead >= 224) {
      extra = 2;
    } else if (lead >= 192) {
      extra = 1;
    } else {
      return false;
    }
    if (i + extra >= s.length) { return false; }
    let j: int = 1;
    while (j <= extra) {
      let c = s.charCodeAt(i + j);
      if (c < 128 || c >= 192) { return false; }
      j = j + 1;
    }
    i = i + extra + 1;
  }
  return true;
}

test("split fixed never cuts inside a code point", () => {
  let chunks = splitFixed("résumé", 2, 0);
  let rejoined = "";
  for (const chunk of chunks) {
    expect(chunk.length > 0);
    expect(docIsValidUtf8(chunk));
    rejoined = rejoined + chunk;
  }
  expect(rejoined == "résumé");
  let wide = splitFixed("café naïve résumé señor", 5, 0);
  let back = "";
  for (const chunk of wide) {
    expect(docIsValidUtf8(chunk));
    back = back + chunk;
  }
  expect(back == "café naïve résumé señor");
  let narrow = splitFixed("é", 1, 0);
  expect(narrow.length == 1);
  expect(narrow[0] == "é");
  expect(docIsValidUtf8("ré") == true);
});

test("split recursive never cuts inside a code point", () => {
  let chunks = splitRecursive("résuméresuméresumé", 5, 2);
  expect(chunks.length > 1);
  for (const chunk of chunks) {
    expect(docIsValidUtf8(chunk));
  }
  let docs = splitToDocuments("café naïve résumé señor", "notes.txt", 6, 0);
  expect(docs.length > 1);
  for (const doc of docs) {
    expect(docIsValidUtf8(doc.text));
  }
});

test("split paragraphs handles CRLF documents", () => {
  let parts = splitParagraphs("one\r\n\r\ntwo\r\n\r\nthree");
  expect(parts.length == 3);
  expect(parts[0] == "one");
  expect(parts[1] == "two");
  expect(parts[2] == "three");
  let mixed = splitParagraphs("first\r\nstill first\r\n\r\nsecond");
  expect(mixed.length == 2);
  expect(mixed[0] == "first\nstill first");
  expect(mixed[1] == "second");
});

test("split recursive still prefers CRLF paragraph breaks", () => {
  let chunks = splitRecursive("alpha beta\r\n\r\ngamma delta\r\nepsilon zeta", 18, 0);
  expect(chunks.length == 3);
  expect(chunks[0] == "alpha beta");
  expect(chunks[1] == "gamma delta");
  expect(chunks[2] == "epsilon zeta");
});

test("split to documents carries metadata", () => {
  let docs = splitToDocuments("alpha beta\n\ngamma delta", "notes.txt", 16, 0);
  let tagged = withMetadata(docs[0], "source", "notes.txt");
  expect(documentMetadata(tagged, "source") == "notes.txt");
  expect(documentMetadata(docs[0], "source") == "");
});

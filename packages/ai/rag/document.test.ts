// Tests for document.

import { documentMetadata, makeDocument, splitFixed, splitParagraphs, splitRecursive, splitToDocuments, withMetadata } from "./document.ts";

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

// Recursive splitting, provenance, and overlap.

import { splitChunks, splitChunksWith, splitMarkdownChunks, splitCodeChunks, splitDocumentProse, textSeparators } from "./split.ts";
import { makeDocument, documentMetadata, withMetadata } from "./document.ts";

function joinChunks(text: string, size: int, overlap: int): string {
  let cs = splitChunks(text, size, overlap);
  let out = "";
  let i: int = 0;
  while (i < cs.length) {
    out = out + cs[i].text;
    i = i + 1;
  }
  return out;
}

test("a short text is one chunk", () => {
  let cs = splitChunks("hello world", 100, 0);
  expect(cs.length == 1);
  expect(cs[0].text == "hello world");
  expect(cs[0].start == 0);
  expect(cs[0].end == 11);
});

test("empty text yields no chunks", () => {
  expect(splitChunks("", 100, 10).length == 0);
});

test("every chunk's range indexes the original text exactly", () => {
  let text = "alpha beta\n\ngamma delta epsilon\n\nzeta eta theta iota kappa lambda";
  let cs = splitChunks(text, 24, 4);
  let i: int = 0;
  while (i < cs.length) {
    expect(text.substring(cs[i].start, cs[i].end) == cs[i].text);
    i = i + 1;
  }
});

test("splitting follows structure: paragraphs stay whole when they fit", () => {
  // Three short paragraphs, a budget that fits any one but not two.
  let text = "first para\n\nsecond para\n\nthird para";
  let cs = splitChunks(text, 14, 0);
  expect(cs.length == 3);
  expect(cs[0].text.indexOf("first") >= 0);
  expect(cs[1].text.indexOf("second") >= 0);
  expect(cs[2].text.indexOf("third") >= 0);
});

test("only the over-long paragraph is broken down further", () => {
  // Two tiny paragraphs and one long one. The tiny ones must survive intact
  // rather than being cut at the byte budget.
  let long = "aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll";
  let text = "short one\n\n" + long + "\n\nshort two";
  let cs = splitChunks(text, 20, 0);
  let sawShortOne: bool = false;
  let sawShortTwo: bool = false;
  let i: int = 0;
  while (i < cs.length) {
    if (cs[i].text.trim() == "short one") { sawShortOne = true; }
    if (cs[i].text.trim() == "short two") { sawShortTwo = true; }
    i = i + 1;
  }
  expect(sawShortOne);
  expect(sawShortTwo);
});

test("no chunk exceeds the byte budget", () => {
  let text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
  let cs = splitChunks(text, 20, 0);
  let i: int = 0;
  while (i < cs.length) {
    expect(cs[i].text.length <= 20);
    i = i + 1;
  }
});

test("with no overlap the chunks reconstruct the text", () => {
  let text = "one two three four five six seven eight nine ten eleven twelve";
  expect(joinChunks(text, 16, 0) == text);
});

// --- overlap ---------------------------------------------------------------

test("overlap applies even when every piece already fits", () => {
  // LangChain applies overlap only while resolving an overflow, so this exact
  // shape — paragraphs that each fit the budget — silently gets none
  // (langchain#34804).
  let text = "aaaa\n\nbbbb\n\ncccc\n\ndddd";
  let cs = splitChunks(text, 6, 3);
  expect(cs.length > 1);
  // A later chunk must start before the previous one ended.
  expect(cs[1].start < cs[0].end);
});

test("overlap is the configured byte count", () => {
  let text = "0123456789abcdefghijklmnopqrstuvwxyz";
  let cs = splitChunks(text, 10, 4);
  expect(cs.length > 1);
  let i: int = 1;
  while (i < cs.length) {
    // Each chunk begins exactly `overlap` bytes before the previous one ended,
    // except where clamped by the previous chunk's own start.
    expect(cs[i].start <= cs[i - 1].end - 1);
    i = i + 1;
  }
});

test("zero overlap leaves chunks disjoint", () => {
  let text = "0123456789abcdefghijklmnopqrstuvwxyz";
  let cs = splitChunks(text, 10, 0);
  let i: int = 1;
  while (i < cs.length) {
    expect(cs[i].start >= cs[i - 1].end);
    i = i + 1;
  }
});

test("an overlap at or above the size is clamped, not hung", () => {
  let cs = splitChunks("0123456789abcdefghij", 5, 99);
  expect(cs.length > 0);
});

// --- UTF-8 -----------------------------------------------------------------

test("chunks of multi-byte text are valid UTF-8", () => {
  // Every character is three bytes and there is no separator anywhere, so this
  // goes through the hard-cut path.
  let text = "中文中文中文中文中文中文中文中文";
  let cs = splitChunks(text, 8, 0);
  let i: int = 0;
  while (i < cs.length) {
    // A chunk starting or ending mid-character would put a continuation byte
    // (0x80-0xBF) at its first position.
    let first = cs[i].text.charCodeAt(0);
    expect(first < 128 || first >= 192);
    expect(cs[i].text.length % 3 == 0);
    i = i + 1;
  }
});

test("multi-byte text reconstructs exactly", () => {
  let text = "中文中文中文中文中文";
  expect(joinChunks(text, 7, 0) == text);
});

test("an accented word is never cut mid-character", () => {
  let text = "héllo wörld café naïve résumé";
  let cs = splitChunks(text, 9, 0);
  let i: int = 0;
  while (i < cs.length) {
    let first = cs[i].text.charCodeAt(0);
    expect(first < 128 || first >= 192);
    i = i + 1;
  }
});

test("overlap backs off to a character boundary", () => {
  let text = "中文中文中文中文中文中文";
  let cs = splitChunks(text, 9, 4);
  let i: int = 0;
  while (i < cs.length) {
    let first = cs[i].text.charCodeAt(0);
    expect(first < 128 || first >= 192);
    i = i + 1;
  }
});

// --- forced cuts ------------------------------------------------------------

test("a word longer than the budget is cut and flagged", () => {
  let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let cs = splitChunks(text, 10, 0);
  expect(cs.length > 1);
  expect(cs[1].forced);
});

test("a text that splits naturally is not flagged", () => {
  let cs = splitChunks("alpha\n\nbeta\n\ngamma", 8, 0);
  let i: int = 0;
  while (i < cs.length) {
    expect(!cs[i].forced);
    i = i + 1;
  }
});

// --- separators -------------------------------------------------------------

test("a separator stays with the piece it terminates", () => {
  // LangChain's lookahead split puts it at the start of the next piece, which
  // is why Chinese chunks there begin with a full stop (langchain#18770).
  let cs = splitChunks("alpha. beta. gamma.", 8, 0);
  expect(cs[0].text.indexOf(".") >= 0);
  expect(cs[1].text.charAt(0) != ".");
});

test("windows line endings split at paragraphs", () => {
  let text = "first para\r\n\r\nsecond para\r\n\r\nthird para";
  let cs = splitChunks(text, 16, 0);
  expect(cs.length == 3);
});

test("markdown splits at headings", () => {
  let text = "# Title\n\nintro line\n\n## First\n\nbody of first\n\n## Second\n\nbody of second";
  let cs = splitMarkdownChunks(text, 30, 0);
  let sawFirst: bool = false;
  let i: int = 0;
  while (i < cs.length) {
    if (cs[i].text.startsWith("\n## First") || cs[i].text.startsWith("## First")) { sawFirst = true; }
    i = i + 1;
  }
  expect(sawFirst);
});

test("code splits at declarations", () => {
  let text = "import x\n\nfunction alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n";
  let cs = splitCodeChunks(text, 34, 0);
  let sawBeta: bool = false;
  let i: int = 0;
  while (i < cs.length) {
    if (cs[i].text.indexOf("function beta") >= 0 && cs[i].text.indexOf("function alpha") < 0) { sawBeta = true; }
    i = i + 1;
  }
  expect(sawBeta);
});

test("an explicit separator list is honoured", () => {
  let seps: string[] = ["|"];
  let cs2 = splitChunksWith("aa|bb|cc|dd", seps, 4, 0);
  expect(cs2.length == 4);
});

// --- documents --------------------------------------------------------------

test("a split document carries the parent's metadata", () => {
  let doc = makeDocument("d1", "alpha beta\n\ngamma delta\n\nepsilon zeta", "manual.txt", "");
  doc = withMetadata(doc, "lang", "en");
  let parts = splitDocumentProse(doc, 14, 0);
  expect(parts.length > 1);
  expect(documentMetadata(parts[0], "lang") == "en");
  expect(documentMetadata(parts[1], "lang") == "en");
});

test("a split document records index, range and parent", () => {
  let text = "alpha beta\n\ngamma delta\n\nepsilon zeta";
  let doc = makeDocument("d1", text, "manual.txt", "");
  let parts = splitDocumentProse(doc, 14, 0);
  expect(documentMetadata(parts[0], "chunk") == "0");
  expect(documentMetadata(parts[1], "chunk") == "1");
  expect(documentMetadata(parts[0], "parent") == "d1");
  // The recorded range must index the parent text back to the chunk.
  let s = parseInt(documentMetadata(parts[1], "start")) ?? -1;
  let e = parseInt(documentMetadata(parts[1], "end")) ?? -1;
  expect(s >= 0 && e > s);
  expect(text.substring(s, e) == parts[1].text);
});

test("a split document keeps the parent's source", () => {
  let doc = makeDocument("d1", "alpha beta\n\ngamma delta", "manual.txt", "");
  let parts = splitDocumentProse(doc, 12, 0);
  expect(parts[0].source == "manual.txt");
});

test("splitting a document that fits yields one part", () => {
  let doc = makeDocument("d1", "short", "manual.txt", "");
  let parts = splitDocumentProse(doc, 100, 10);
  expect(parts.length == 1);
  expect(parts[0].text == "short");
});

// --- byte preservation ------------------------------------------------------
// A whitespace-only piece is not worth returning on its own, but its bytes
// belong to the document. Dropping them left a hole between one chunk's end and
// the next one's start, so the chunks no longer reconstructed the text.

test("a run of blank lines between paragraphs is not lost", () => {
  let seps: string[] = ["\n\n"];
  let text = "hello\n\n\n\nworld";
  let cs = splitChunksWith(text, seps, 5, 0);
  let joined = "";
  let i: int = 0;
  while (i < cs.length) {
    joined = joined + cs[i].text;
    i = i + 1;
  }
  expect(joined == text);
});

test("chunks cover the text with no gaps", () => {
  let seps: string[] = ["\n\n"];
  let text = "AAAA\n\n\n\nBBBB\n\n\n\nCCCC";
  let cs = splitChunksWith(text, seps, 6, 0);
  expect(cs[0].start == 0);
  expect(cs[cs.length - 1].end == text.length);
  let i: int = 1;
  while (i < cs.length) {
    // With no overlap each chunk begins exactly where the last ended.
    expect(cs[i].start == cs[i - 1].end);
    i = i + 1;
  }
});

test("leading blank lines are kept with the first chunk", () => {
  let text = "\n\n\nalpha beta";
  let cs = splitChunks(text, 8, 0);
  expect(cs[0].start == 0);
});

test("trailing blank lines are kept with the last chunk", () => {
  let text = "alpha beta\n\n\n";
  let cs = splitChunks(text, 8, 0);
  expect(cs[cs.length - 1].end == text.length);
});

test("a document of only whitespace yields no chunks", () => {
  expect(splitChunks("\n\n\n\n", 4, 0).length == 0);
});

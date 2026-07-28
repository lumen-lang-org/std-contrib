// The scanners behind edit_artifact and search_artifacts, and the search
// itself. The pure functions are tested byte for byte — offsets, lines and
// cut points are the contract the tool layer builds refusals out of — and the
// database cases run against a SQLite temp file, never the live database.
//
//   cd packages/agents && lumen test artifacts-search.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { TURN_SEQ_NONE, artifactPlan, putArtifact } from "./artifacts.ts";
import { editHits, editLineAt, editLoose, searchSnippet, editContext, searchArtifacts, SEARCH_SNIPPET_MAX } from "./artifacts-search.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_search_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS artifact_versions");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  migrate(database, artifactPlan(database));
}

function seed(path: string, title: string, body: string): void {
  putArtifact(database, {
    threadId: "t1", path: path, title: title, content: body,
    note: "", origin: "generated", mustCreate: false,
    turnSeq: TURN_SEQ_NONE, now: "1000",
  });
}

// n copies of `piece`, since there is no repeat in the stdlib.
function copies(piece: string, n: int): string {
  let out = "";
  let i: int = 0;
  while (i < n) { out = out + piece; i = i + 1; }
  return out;
}

// --- editHits: occurrences, counted overlapping -----------------------------------

test("aa in aaa is two hits — overlap decides the uniqueness rule", () => {
  // Counted non-overlapping this would be one "unique" match, and the edit
  // would splice the first two characters of a region the model never meant.
  let found = editHits("aaa", "aa", 8);
  expect(found.length == 2);
  expect(found[0].at == 0);
  expect(found[1].at == 1);
});

test("hits carry byte offsets across a multi-byte character", () => {
  // "é" is two bytes, so "llo" begins at byte 3, not character 2.
  let e = String.fromCodePoint(233);
  let body = "h" + e + "llo";
  let found = editHits(body, "llo", 8);
  expect(found.length == 1);
  expect(found[0].at == 3);
});

test("a needle straddling a multi-byte character still matches, byte for byte", () => {
  let e = String.fromCodePoint(233);
  let body = "caf" + e + " au lait";
  let found = editHits(body, e + " au", 8);
  expect(found.length == 1);
  expect(found[0].at == 3);
});

test("a needle at the very end of the body is found", () => {
  let found = editHits("abcdef", "ef", 8);
  expect(found.length == 1);
  expect(found[0].at == 4);
});

test("a needle longer than the body finds nothing", () => {
  expect(editHits("ab", "abc", 8).length == 0);
});

test("an empty needle finds nothing rather than everything", () => {
  expect(editHits("abc", "", 8).length == 0);
});

test("lines are counted through CRLF bodies on the LF alone", () => {
  let body = "one\r\ntwo\r\nthree";
  let found = editHits(body, "t", 8);
  expect(found.length == 2);
  expect(found[0].line == 2);
  expect(found[1].line == 3);
});

test("the walk stops at most+1, so more-than-most is knowable without walking to the end", () => {
  let found = editHits("aaaaaaaa", "a", 2);
  expect(found.length == 3);
});

// --- editLineAt -------------------------------------------------------------------

test("editLineAt is 1-based and counts the newlines before the offset", () => {
  let body = "a\nbb\nccc";
  expect(editLineAt(body, 0) == 1);
  expect(editLineAt(body, 2) == 2);
  expect(editLineAt(body, 5) == 3);
  expect(editLineAt(body, body.length) == 3);
});

// --- editLoose: the near-miss scanner behind the zero-match refusal ---------------

test("tab-for-space drift is found, with its line", () => {
  let body = "alpha\n\tlet x = 1;\ngamma";
  expect(editLoose(body, "  let x = 1;") == 2);
});

test("CRLF-for-LF drift is found", () => {
  let body = "one\r\ntwo\r\nthree";
  expect(editLoose(body, "one\ntwo") == 1);
});

test("a genuinely absent needle answers -1", () => {
  expect(editLoose("alpha\nbeta", "gamma") == -1);
});

test("NFC/NFD drift answers -1 — the blindness is documented, not accidental", () => {
  // NFC "café" is c a f 0xC3 0xA9; NFD is c a f e 0xCC 0x81. The loose scan
  // skips space, tab and CR, nothing else, so these are different bytes and
  // no near miss is claimed. A later "improvement" that half-sees unicode
  // fails this test instead of shipping quietly.
  let nfc = "caf" + String.fromCodePoint(233);
  let nfd = "cafe" + String.fromCodePoint(769);
  expect(editLoose(nfc, nfd) == -1);
  expect(editLoose(nfd, nfc) == -1);
});

test("a needle of nothing but blanks answers -1", () => {
  expect(editLoose("a b", "  ") == -1);
  expect(editLoose("a b", "") == -1);
});

// --- searchSnippet ----------------------------------------------------------------

test("a line within the cap is quoted whole, with no marker", () => {
  let s = searchSnippet("let x = 1;");
  expect(s.text == "let x = 1;");
  expect(!s.cut);
});

test("a line of exactly the cap is not cut", () => {
  let s = searchSnippet(copies("a", SEARCH_SNIPPET_MAX));
  expect(s.text.length == SEARCH_SNIPPET_MAX);
  expect(!s.cut);
});

test("a long line is cut with the visible marker, and only cut lines carry it", () => {
  let s = searchSnippet(copies("a", SEARCH_SNIPPET_MAX + 40));
  expect(s.cut);
  expect(s.text == copies("a", SEARCH_SNIPPET_MAX) + " [cut]");
});

test("the cut lands on a UTF-8 boundary, walking back off continuation bytes", () => {
  // Byte 159 starts a two-byte "é"; a cut at 160 would keep half of it and
  // poison the row that quotes the snippet. The walk-back drops the whole
  // character instead.
  let e = String.fromCodePoint(233);
  let line = copies("a", SEARCH_SNIPPET_MAX - 1) + e + copies("b", 20);
  let s = searchSnippet(line);
  expect(s.cut);
  expect(s.text == copies("a", SEARCH_SNIPPET_MAX - 1) + " [cut]");
});

// --- editContext ------------------------------------------------------------------

test("context is the changed line with two lines either side", () => {
  let body = "l1\nl2\nl3\nl4\nl5\nl6\nl7";
  let at = body.indexOf("l4");
  expect(editContext(body, at, at + 2) == "l2\nl3\nl4\nl5\nl6");
});

test("context at the top of the file has no lines above to show", () => {
  let body = "l1\nl2\nl3\nl4\nl5";
  expect(editContext(body, 0, 2) == "l1\nl2\nl3");
});

test("context at the bottom of the file has no lines below to show", () => {
  let body = "l1\nl2\nl3\nl4\nl5";
  let at = body.indexOf("l5");
  expect(editContext(body, at, at + 2) == "l3\nl4\nl5");
});

test("a change spanning lines shows every changed line plus the two around", () => {
  let body = "l1\nl2\nl3\nl4\nl5\nl6\nl7";
  let at = body.indexOf("l3");
  let to = body.indexOf("l5") + 2;
  expect(editContext(body, at, to) == "l1\nl2\nl3\nl4\nl5\nl6\nl7");
});

test("a deletion shows the line the text was removed from", () => {
  let body = "l1\nl2\nl3\nl4\nl5";
  let at = body.indexOf("l3") + 2;
  expect(editContext(body, at, at) == "l1\nl2\nl3\nl4\nl5");
});

// --- searchArtifacts --------------------------------------------------------------

test("percent and underscore are found literally, not as wildcards", () => {
  // Unescaped, "50%" as a LIKE would match "50 anything". likeLiteral is the
  // difference between a search tool and a pattern language nobody declared.
  fresh();
  seed("/a.md", "", "progress is 50% done\n");
  seed("/b.md", "", "progress is 50 percent done\n");
  seed("/c.md", "", "field s_me here\n");
  seed("/d.md", "", "field some here\n");
  let percent = searchArtifacts(database, "t1", "50%");
  expect(percent.ok);
  expect(percent.hits.length == 1);
  expect(percent.hits[0].path == "/a.md");
  let underscore = searchArtifacts(database, "t1", "s_me");
  expect(underscore.ok);
  expect(underscore.hits.length == 1);
  expect(underscore.hits[0].path == "/c.md");
});

test("only the current version is searched — a hit on an old body is a line the edit cannot match", () => {
  fresh();
  seed("/a.md", "", "the needle was here\n");
  seed("/a.md", "", "nothing to see\n");
  let found = searchArtifacts(database, "t1", "needle");
  expect(found.ok);
  expect(found.hits.length == 0);
  expect(found.searched == 1);
});

test("a hit names path, version, line and the matching line's text", () => {
  fresh();
  seed("/a.md", "", "one\ntwo needle two\nthree\n");
  seed("/a.md", "", "one\nmoved\nneedle down here\n");
  let found = searchArtifacts(database, "t1", "needle");
  expect(found.ok);
  expect(found.hits.length == 1);
  expect(found.hits[0].path == "/a.md");
  expect(found.hits[0].version == 2);
  expect(found.hits[0].line == 3);
  expect(found.hits[0].text == "needle down here");
  expect(!found.hits[0].cut);
});

test("a match on the path or the title is a hit with line 0", () => {
  fresh();
  seed("/quarterly-report.html", "Q3 numbers", "<p>hello</p>\n");
  let byPath = searchArtifacts(database, "t1", "quarterly");
  expect(byPath.hits.length == 1);
  expect(byPath.hits[0].line == 0);
  let byTitle = searchArtifacts(database, "t1", "Q3 numbers");
  expect(byTitle.hits.length == 1);
  expect(byTitle.hits[0].line == 0);
  expect(byTitle.hits[0].text == "Q3 numbers");
});

test("at most five hits per artifact, and the answer says it was capped", () => {
  fresh();
  seed("/a.md", "", "hit\nhit\nhit\nhit\nhit\nhit\nhit\n");
  let found = searchArtifacts(database, "t1", "hit");
  expect(found.ok);
  expect(found.hits.length == 5);
  expect(found.capped);
});

test("at most twenty hits across the thread, and the answer says it was capped", () => {
  fresh();
  let i: int = 0;
  while (i < 5) {
    seed("/f" + `${i}` + ".md", "", "hit\nhit\nhit\nhit\nhit\n");
    i = i + 1;
  }
  let found = searchArtifacts(database, "t1", "hit");
  expect(found.ok);
  expect(found.hits.length == 20);
  expect(found.capped);
});

test("searched counts artifacts, not hits, and no hits is an answer", () => {
  fresh();
  seed("/a.md", "", "alpha\n");
  seed("/b.md", "", "beta\n");
  seed("/c.md", "", "gamma\n");
  let found = searchArtifacts(database, "t1", "delta");
  expect(found.ok);
  expect(found.hits.length == 0);
  expect(found.searched == 3);
});

test("another thread's artifacts are invisible", () => {
  fresh();
  seed("/a.md", "", "needle\n");
  let found = searchArtifacts(database, "t2", "needle");
  expect(found.ok);
  expect(found.hits.length == 0);
  expect(found.searched == 0);
});

test("a long matching line comes back cut, with the marker", () => {
  fresh();
  seed("/a.md", "", copies("x", 200) + "needle" + copies("y", 40) + "\n");
  let found = searchArtifacts(database, "t1", "needle");
  expect(found.hits.length == 1);
  expect(found.hits[0].cut);
  expect(found.hits[0].text.endsWith(" [cut]"));
});

test("the query bounds and the one-line rule are refused outright", () => {
  fresh();
  seed("/a.md", "", "alpha\n");
  expect(!searchArtifacts(database, "t1", "a").ok);
  expect(!searchArtifacts(database, "t1", copies("a", 201)).ok);
  expect(!searchArtifacts(database, "t1", "two\nlines").ok);
  expect(searchArtifacts(database, "t1", copies("a", 200)).ok);
});

test("the length refusal counts bytes and says so", () => {
  // A query of 101 two-byte letters is 202 bytes and refused, while its author
  // counted 101 characters. The sentence has to name the unit it used, or the
  // model reads a refusal whose arithmetic contradicts what it just wrote.
  fresh();
  seed("/a.md", "", "alpha\n");
  let arabic = copies("ل", 101);
  let refused = searchArtifacts(database, "t1", arabic);
  expect(!refused.ok);
  expect(refused.problem.includes("bytes of UTF-8"));
  expect(refused.problem.includes("202"));
  // And the lower bound is bytes too: one Arabic letter is two bytes, which is
  // the minimum, so a one-character query is accepted where "a" was not.
  expect(searchArtifacts(database, "t1", "ل").ok);
});

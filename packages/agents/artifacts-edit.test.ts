import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, executeWith, placeholderAt } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ARTIFACT_MAX, THREAD_BYTES_MAX, TURN_SEQ_NONE, artifactPlan, putArtifact, getArtifact, getVersion, excerptOf } from "./artifacts.ts";
import { ArtifactEdit, editArtifact } from "./artifacts-edit.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_edit_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS artifact_versions");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  migrate(database, artifactPlan(database));
}

function seeded(body: string): void {
  fresh();
  putArtifact(database, {
    threadId: "t1", path: "/notes.md", title: "Notes", content: body,
    note: "first", origin: "generated", mustCreate: false,
    turnSeq: 3, now: "1000",
  });
}

function edit(oldText: string, newText: string): ArtifactEdit {
  let out: ArtifactEdit = {
    threadId: "t1", path: "/notes.md",
    oldText: oldText, newText: newText,
    note: "", turnSeq: 4, now: "2000",
  };
  return out;
}

function outOfBand(artifactId: string, version: int, body: string): void {
  executeWith(database,
    "INSERT INTO artifact_versions (id, artifact_id, version, body, bytes, origin, turn_seq, note, created_at) VALUES ("
    + placeholderAt(database, 1) + ", " + placeholderAt(database, 2) + ", " + placeholderAt(database, 3) + ", "
    + placeholderAt(database, 4) + ", " + placeholderAt(database, 5) + ", " + placeholderAt(database, 6) + ", "
    + placeholderAt(database, 7) + ", " + placeholderAt(database, 8) + ", " + placeholderAt(database, 9) + ")",
    [artifactId + ":" + `${version}`, artifactId, `${version}`, body, `${body.length}`,
     "generated", "9", "out of band", "1500"]);
}

function fill(piece: string, n: int): string {
  let out = "";
  let i: int = 0;
  while (i < n) {
    out = out + piece;
    i = i + 1;
  }
  return out;
}

test("an edit appends the next version and moves only the pointer's version and date", () => {
  seeded("alpha\nbeta\ngamma\n");
  let before = getArtifact(database, "t1", "/notes.md");
  let done = editArtifact(database, edit("beta", "delta"));
  expect(done.ok);
  expect(done.slot == before.slot);
  expect(done.version == 2);
  expect(done.line == 2);

  expect(getVersion(database, before.id, 2).body == "alpha\ndelta\ngamma\n");
  expect(getVersion(database, before.id, 1).body == "alpha\nbeta\ngamma\n");

  let after = getArtifact(database, "t1", "/notes.md");
  expect(after.currentVersion == 2);
  expect(after.updatedAt == "2000");
  expect(after.slot == before.slot);
  expect(after.title == before.title);
  expect(after.kind == before.kind);
  expect(after.mime == before.mime);
  expect(after.previewToken == before.previewToken);
  expect(after.createdAt == before.createdAt);
});

test("the success reply echoes the changed lines with two either side", () => {
  seeded("l1\nl2\nl3\nold\nl5\nl6\nl7\n");
  let done = editArtifact(database, edit("old", "new-text"));
  expect(done.ok);
  expect(done.context == "l2\nl3\nnew-text\nl5\nl6");
});

test("an empty note is synthesized so the human log never shows a blank reason", () => {
  seeded("alpha\nbeta\n");
  let done = editArtifact(database, edit("beta", "delta"));
  expect(done.ok);
  let row = getArtifact(database, "t1", "/notes.md");
  expect(getVersion(database, row.id, 2).note == "edit at line 2");
});

test("a note the model did send is stored as sent", () => {
  seeded("alpha\nbeta\n");
  let e: ArtifactEdit = {
    threadId: "t1", path: "/notes.md", oldText: "beta", newText: "delta",
    note: "fixed the figure", turnSeq: 4, now: "2000",
  };
  let done = editArtifact(database, e);
  expect(done.ok);
  let row = getArtifact(database, "t1", "/notes.md");
  expect(getVersion(database, row.id, 2).note == "fixed the figure");
});

test("zero matches refuses, with no version written", () => {
  seeded("alpha\nbeta\n");
  let done = editArtifact(database, edit("zeta", "eta"));
  expect(!done.ok);
  expect(done.fault.indexOf("matches nothing") >= 0);
  expect(done.fault.indexOf("/notes.md") >= 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
});

test("the zero-match refusal names a whitespace near miss when one exists", () => {
  seeded("alpha\n\tlet x = 1;\ngamma\n");
  let done = editArtifact(database, edit("  let x = 1;", "  let x = 2;"));
  expect(!done.ok);
  expect(done.fault.indexOf("whitespace-insensitive") >= 0);
  expect(done.fault.indexOf("line 2") >= 0);
});

test("a miss that is only backslash escaping is named as exactly that, in both directions", () => {
  seeded("{\n  \"UserConfigId\": \"D:\\\\Fo2pdf\\\\config\\\\USERCONFIG.XML\"\n}\n");
  let unescaped = editArtifact(database, edit("\"D:\\Fo2pdf\\config\\USERCONFIG.XML\"", "\"c:/fop/userconfig.xml\""));
  expect(!unescaped.ok);
  expect(unescaped.fault.indexOf("backslash escaping") >= 0);
  expect(unescaped.fault.indexOf("MORE backslashes") >= 0);
  expect(unescaped.fault.indexOf("line 2") >= 0);

  let overescaped = editArtifact(database, edit("\"D:\\\\\\\\Fo2pdf\\\\\\\\config\\\\\\\\USERCONFIG.XML\"", "\"c:/fop/userconfig.xml\""));
  expect(!overescaped.ok);
  expect(overescaped.fault.indexOf("FEWER backslashes") >= 0);

  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);

  let right = editArtifact(database, edit("\"D:\\\\Fo2pdf\\\\config\\\\USERCONFIG.XML\"", "\"c:/fop/userconfig.xml\""));
  expect(right.ok);
});

test("the zero-match refusal says when there is no near miss either", () => {
  seeded("alpha\nbeta\n");
  let done = editArtifact(database, edit("zeta", "eta"));
  expect(!done.ok);
  expect(done.fault.indexOf("whitespace-insensitive") < 0);
  expect(done.fault.indexOf("search_artifacts") >= 0);
});

test("more than one match refuses with numbered hits, lines and snippets", () => {
  seeded("value\nother\nvalue\n");
  let done = editArtifact(database, edit("value", "changed"));
  expect(!done.ok);
  expect(done.hits.length == 2);
  expect(done.hits[0].line == 1);
  expect(done.hits[1].line == 3);
  expect(done.fault.indexOf("1. line 1: value") >= 0);
  expect(done.fault.indexOf("2. line 3: value") >= 0);
  expect(done.fault.indexOf("more surrounding text") >= 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
});

test("overlapping occurrences are ambiguous, not unique", () => {
  seeded("aaa\n");
  let done = editArtifact(database, edit("aa", "b"));
  expect(!done.ok);
  expect(done.hits.length == 2);
});

test("past eight matches the refusal says more-than rather than listing a body's worth", () => {
  seeded("x\nx\nx\nx\nx\nx\nx\nx\nx\nx\n");
  let done = editArtifact(database, edit("x", "y"));
  expect(!done.ok);
  expect(done.fault.indexOf("more than 8") >= 0);
});

test("an empty old refuses before any lookup", () => {
  seeded("alpha\n");
  let done = editArtifact(database, edit("", "beta"));
  expect(!done.ok);
  expect(done.fault.indexOf("empty") >= 0);
});

test("old identical to new refuses — a no-op version would lie that something changed", () => {
  seeded("alpha\n");
  let done = editArtifact(database, edit("alpha", "alpha"));
  expect(!done.ok);
  expect(done.fault.indexOf("identical") >= 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
});

test("a path with no artifact refuses in read_artifact's sentence, and never creates", () => {
  fresh();
  let e: ArtifactEdit = {
    threadId: "t1", path: "/nope.md", oldText: "a", newText: "b",
    note: "", turnSeq: 4, now: "2000",
  };
  let done = editArtifact(database, e);
  expect(!done.ok);
  expect(done.fault.indexOf("no artifact at /nope.md") >= 0);
  expect(getArtifact(database, "t1", "/nope.md").id == "");
});

test("a pointer naming a version the log lacks refuses rather than editing an empty body", () => {
  seeded("alpha\n");
  execute(database, "UPDATE artifacts SET current_version = 9");
  let done = editArtifact(database, edit("alpha", "beta"));
  expect(!done.ok);
  expect(done.fault.indexOf("version 9") >= 0);
  expect(done.fault.indexOf("not in its history") >= 0);
});

test("a splice past the artifact byte cap refuses in putArtifact's words", () => {
  seeded("alpha\nbeta\n");
  let done = editArtifact(database, edit("beta", fill("b", ARTIFACT_MAX + 1)));
  expect(!done.ok);
  expect(done.fault.indexOf("at most " + `${ARTIFACT_MAX}` + " bytes") >= 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
});

test("a splice past the thread byte cap refuses, naming the cap", () => {
  seeded("alpha\nbeta\n");
  let put = putArtifact(database, {
    threadId: "t1", path: "/big.md", title: "", content: "tiny",
    note: "", origin: "generated", mustCreate: false,
    turnSeq: TURN_SEQ_NONE, now: "1100",
  });
  expect(put.ok);
  executeWith(database, "UPDATE artifact_versions SET bytes = " + placeholderAt(database, 1)
    + " WHERE artifact_id = " + placeholderAt(database, 2),
    [`${THREAD_BYTES_MAX}`, "t1:/big.md"]);
  let done = editArtifact(database, edit("beta", "delta"));
  expect(!done.ok);
  expect(done.fault.indexOf("a thread's artifacts hold at most") >= 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
});

test("a concurrent append elsewhere in the file merges cleanly on top", () => {
  seeded("alpha\nbeta\ngamma\n");
  outOfBand("t1:/notes.md", 2, "ALPHA\nbeta\ngamma\n");
  let done = editArtifact(database, edit("beta", "delta"));
  expect(done.ok);
  expect(done.version == 3);
  let row = getArtifact(database, "t1", "/notes.md");
  expect(row.currentVersion == 3);
  expect(getVersion(database, row.id, 3).body == "ALPHA\ndelta\ngamma\n");
  expect(getVersion(database, row.id, 2).body == "ALPHA\nbeta\ngamma\n");
});

test("a concurrent change inside the edited region refuses as changed-underneath", () => {
  seeded("alpha\nbeta\ngamma\n");
  outOfBand("t1:/notes.md", 2, "alpha\nbrave\ngamma\n");
  let done = editArtifact(database, edit("beta", "delta"));
  expect(!done.ok);
  expect(done.fault.indexOf("changed while you were editing") >= 0);
  let row = getArtifact(database, "t1", "/notes.md");
  expect(getVersion(database, row.id, 3).id == "");
});

test("an excerpt never cuts a character in half - the cut backs off to a utf-8 boundary", () => {
  // 398 ascii bytes, then a three-byte arrow spanning bytes 398..400: a cut
  // at 400 would land inside it, which is exactly the prod card that reached
  // a browser as a byte array instead of a string.
  let head = "";
  let i: int = 0;
  while (i < 398) {
    head = head + "a";
    i = i + 1;
  }
  let body = head + "→ and the rest of the sentence";
  let cut = excerptOf(body, 400);
  expect(cut.length == 398);
  expect(cut == head);
  // A cut that lands on a boundary is untouched.
  expect(excerptOf(body, 398) == head);
  // Short bodies come back whole.
  expect(excerptOf("short", 400) == "short");
});

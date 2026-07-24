// Loading documents from text and from the filesystem.

import { loadText, loadFile, loadDirectory, fileExtension } from "./loader.ts";
import { documentMetadata } from "./document.ts";

const LOAD_DIR = "/tmp/lumen-ai-loader-test";

function seed(): void {
  fs.mkdirSync(LOAD_DIR);
  fs.mkdirSync(LOAD_DIR + "/sub");
  fs.writeFileSync(LOAD_DIR + "/a.txt", "alpha text");
  fs.writeFileSync(LOAD_DIR + "/b.md", "# beta");
  fs.writeFileSync(LOAD_DIR + "/sub/c.txt", "gamma text");
}

test("an extension is read from a path", () => {
  expect(fileExtension("/a/b/c.txt") == ".txt");
  expect(fileExtension("c.md") == ".md");
  expect(fileExtension("/a/b/noext") == "");
  // A dotfile is a name, not an extension.
  expect(fileExtension("/a/.gitignore") == "");
  expect(fileExtension("/a.b/c") == "");
});

test("text in hand becomes a document", () => {
  let d = loadText("some words", "manual");
  expect(d.text == "some words");
  expect(d.source == "manual");
});

test("a missing file is reported, not empty", () => {
  let r = loadFile("/tmp/definitely-not-here-9f8a7b6c.txt");
  expect(!r.ok);
  expect(r.error.indexOf("no such file") >= 0);
  expect(r.docs.length == 0);
});

test("a file loads with its path and name", () => {
  seed();
  let r = loadFile(LOAD_DIR + "/a.txt");
  expect(r.ok);
  expect(r.docs.length == 1);
  expect(r.docs[0].text == "alpha text");
  expect(r.docs[0].source == LOAD_DIR + "/a.txt");
  expect(documentMetadata(r.docs[0], "name") == "a.txt");
  expect(documentMetadata(r.docs[0], "ext") == ".txt");
});

test("a directory loads one document per file", () => {
  seed();
  let r = loadDirectory(LOAD_DIR, [], false);
  expect(r.ok);
  // a.txt and b.md, not the subdirectory's file.
  expect(r.docs.length == 2);
});

test("recursion reaches a subdirectory", () => {
  seed();
  let r = loadDirectory(LOAD_DIR, [], true);
  expect(r.ok);
  expect(r.docs.length == 3);
});

test("an extension filter selects files", () => {
  seed();
  let exts: string[] = [".txt"];
  let r = loadDirectory(LOAD_DIR, exts, true);
  expect(r.ok);
  expect(r.docs.length == 2);
  let i: int = 0;
  while (i < r.docs.length) {
    expect(documentMetadata(r.docs[i], "ext") == ".txt");
    i = i + 1;
  }
});

test("a missing directory is reported", () => {
  let r = loadDirectory("/tmp/definitely-not-here-9f8a7b6c", [], false);
  expect(!r.ok);
  expect(r.error.indexOf("no such directory") >= 0);
});

test("a file given where a directory is expected is reported", () => {
  seed();
  let r = loadDirectory(LOAD_DIR + "/a.txt", [], false);
  expect(!r.ok);
  expect(r.error.indexOf("not a directory") >= 0);
});

test("an empty directory loads nothing without failing", () => {
  let empty = LOAD_DIR + "/empty";
  fs.mkdirSync(LOAD_DIR);
  fs.mkdirSync(empty);
  let r = loadDirectory(empty, [], true);
  expect(r.ok);
  expect(r.docs.length == 0);
});

test("an extension filter matching nothing loads nothing", () => {
  seed();
  let exts: string[] = [".pdf"];
  let r = loadDirectory(LOAD_DIR, exts, true);
  expect(r.ok);
  expect(r.docs.length == 0);
});

// --- failures are reported, never raised ------------------------------------
// Reading throws for a directory and for a file the process may not read. An
// uncaught throw would end a whole ingestion run over one bad file, so both
// come back as a failed result.

test("a directory given where a file belongs is reported", () => {
  seed();
  let r = loadFile(LOAD_DIR);
  expect(!r.ok);
  expect(r.error.indexOf("is a directory") >= 0);
  expect(r.docs.length == 0);
});

test("an unreadable file is reported, not raised", () => {
  seed();
  let locked = LOAD_DIR + "/locked.txt";
  fs.writeFileSync(locked, "secret");
  fs.chmodSync(locked, 0);
  let r = loadFile(locked);
  // Restore first, so a failure here does not leave the file unreadable.
  fs.chmodSync(locked, 420);
  expect(!r.ok);
  expect(r.error.indexOf("cannot read") >= 0);
});

test("the loader survives a bad file and keeps going", () => {
  seed();
  let locked = LOAD_DIR + "/locked2.txt";
  fs.writeFileSync(locked, "secret");
  fs.chmodSync(locked, 0);
  let bad = loadFile(locked);
  fs.chmodSync(locked, 420);
  expect(!bad.ok);
  // The process is still alive to run this, which is the point.
  let good = loadFile(LOAD_DIR + "/a.txt");
  expect(good.ok);
  expect(good.docs[0].text == "alpha text");
});

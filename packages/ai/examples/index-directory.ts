// Index a directory of notes and answer a question from them.
//
// Loads every .md and .txt under a directory, splits each file into chunks that
// remember where they came from, indexes them, and prints the best matches with
// their source and byte range — the provenance that lets an answer be checked
// against the file it came from.
//
// Run:
//   lumen compile packages/ai/examples/index-directory.ts
//   ./index-directory <directory> "<question>"

import { loadDirectory, splitDocument, keywordRetrieve, docMetadata } from "../ai.ts";

// process.argv is [program, ...arguments] — there is no script slot, so the
// first argument is at index 1, not 2 as in Node.
let args = process.argv;
if (args.length < 3) {
  console.error("usage: index-directory <directory> \"<question>\"");
  process.exit(1);
}
let dir = args[1];
let question = args[2];

let exts: string[] = [".md", ".txt"];
let loaded = loadDirectory(dir, exts, true);
if (!loaded.ok) {
  console.error(loaded.error);
  process.exit(1);
}
if (loaded.docs.length == 0) {
  console.error("no .md or .txt files under " + dir);
  process.exit(1);
}

// Split every file. A chunk keeps its parent's metadata, so the source path
// survives into the index.
let chunked: AiDocument[] = [];
let i: int = 0;
while (i < loaded.docs.length) {
  chunked = [...chunked, ...splitDocument(loaded.docs[i], 600, 100)];
  i = i + 1;
}

console.log(`${loaded.docs.length} files, ${chunked.length} chunks`);

// Keyword retrieval rather than the hashing embedder: it drops documents that
// share no term with the query, so "no match" means no match. The vector path
// always returns some collision noise at these dimension counts. Swap in
// `retrieve(addDocs(vectorStore(), chunked, DIMS), chunked, question, DIMS, 3)`
// to compare.
let hits = keywordRetrieve(chunked, question, 3);
if (hits.length == 0) {
  console.log("nothing in those files matches that question");
  process.exit(0);
}

console.log("");
let h: int = 0;
while (h < hits.length) {
  let doc = hits[h].doc;
  let start = docMetadata(doc, "start");
  let end = docMetadata(doc, "end");
  console.log(`[${h + 1}] ${doc.source} bytes ${start}..${end}`);
  console.log(doc.text.trim());
  console.log("");
  h = h + 1;
}

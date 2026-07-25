// RAG over a PDF, with every stage real:
//
//   pdftotext (Poppler, linked) -> split -> mistral-embed -> PostgreSQL
//        -> embed the question -> pgvector search -> grounded prompt
//        -> mistral-large, streamed
//
// The document is a PDF on disk rather than a string in the source, which is
// what makes this the whole path: text extraction is the stage that decides
// what everything downstream is even working with.
//
// Poppler is linked rather than spawned, so there is no process per document.
//
// Both shims must sit in the working directory, because `// @link` paths
// resolve against it rather than against the source file:
//   sh packages/pdf/build.sh && sh packages/pgvector/build.sh
//   cp packages/pdf/poppler_shim.o packages/pgvector/
//
// Setup:
//   createdb lumenvec && psql lumenvec -c 'CREATE EXTENSION vector'
//   export MISTRAL_API_KEY="..."
//   cd packages/pgvector && lumen compile examples/rag-pdf.ts
//   ./rag-pdf handbook.pdf "what is the refund window?"

import { pgConnect, pgCreateStore, pgUpsert, pgSearch, pgHas, pgCount, pgClose } from "../pgvector.ts";
import { extractLayout, readInfo } from "../../pdf/pdf_ffi.ts";
import { modelConfig, withTemperature, embedBatchWithConfig, splitDocument, loadText, streamChat, system, user } from "../../ai/ai.ts";

const DIMS = 1024;
const TABLE = "lumen_pdf_rag";

let apiKey = process.env("MISTRAL_API_KEY") ?? "";
if (apiKey == "") {
  console.error("set MISTRAL_API_KEY");
  process.exit(1);
}
if (process.argv.length < 3) {
  console.error("usage: rag-pdf <file.pdf> \"<question>\"");
  process.exit(1);
}
let pdfPath = process.argv[1];
let question = process.argv[2];

// --- extract -----------------------------------------------------------------
// Layout mode, not the default: a PDF with columns runs them together
// otherwise, and chunks of interleaved columns retrieve poorly.
let info = readInfo(pdfPath);
if (!info.ok) {
  console.error(info.error);
  process.exit(1);
}
let extracted = extractLayout(pdfPath);
if (!extracted.ok) {
  console.error(extracted.error);
  process.exit(1);
}
console.log(`${pdfPath}: ${info.pages} pages, ${extracted.text.length} bytes of text`);

// --- index -------------------------------------------------------------------
let conninfo = process.env("PGVECTOR_CONNINFO") ?? "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec";
let c = pgConnect(conninfo);
if (!c.ok) {
  console.error(c.error);
  process.exit(1);
}
let created = pgCreateStore(TABLE, DIMS);
if (!created.ok) {
  console.error(created.error);
  process.exit(1);
}

// The chunk id derives from the source path and the chunk index, so re-running
// over an unchanged file re-uses what is stored rather than paying to embed it
// again.
let doc = loadText(extracted.text, pdfPath);
let parts = splitDocument(doc, 700, 100);

let embedCfg = modelConfig("mistral", "mistral-embed", apiKey);

let pendingText: string[] = [];
let pendingAt: int[] = [];
let i: int = 0;
while (i < parts.length) {
  if (!pgHas(TABLE, parts[i].id)) {
    pendingText = [...pendingText, parts[i].text];
    pendingAt = [...pendingAt, i];
  }
  i = i + 1;
}

if (pendingText.length > 0) {
  console.log(`embedding ${pendingText.length} of ${parts.length} chunks`);
  let vectors = embedBatchWithConfig(embedCfg, pendingText);
  if (vectors.length != pendingText.length) {
    console.error("embedding failed — nothing stored");
    process.exit(1);
  }
  let v: int = 0;
  while (v < pendingAt.length) {
    let at = pendingAt[v];
    let stored = pgUpsert(TABLE, parts[at].id, parts[at].text, pdfPath, "", vectors[v]);
    if (!stored.ok) {
      console.error(stored.error);
      process.exit(1);
    }
    v = v + 1;
  }
} else {
  console.log(`all ${parts.length} chunks already indexed`);
}
console.log(`${pgCount(TABLE)} chunks in the table`);

// --- retrieve ------------------------------------------------------------------
let queryBatch: string[] = [question];
let queryRows = embedBatchWithConfig(embedCfg, queryBatch);
if (queryRows.length == 0) {
  console.error("the question could not be embedded");
  process.exit(1);
}
let hits = pgSearch(TABLE, queryRows[0], 3);

console.log("");
console.log(`question: ${question}`);
console.log("");
console.log("retrieved:");
let context = "";
let h: int = 0;
while (h < hits.length) {
  console.log(`  [${h + 1}] ${hits[h].score}  ${hits[h].text.trim().slice(0, 60)}`);
  context = context + "[" + `${h + 1}` + "] " + hits[h].text + "\n\n";
  h = h + 1;
}

// --- answer ---------------------------------------------------------------------
let grounding = "Answer only from the context below, and cite the bracket number"
  + " of each claim. If the context does not answer the question, reply exactly:"
  + " The context does not contain the answer.\n\nContext:\n" + context;

let chatCfg = withTemperature(modelConfig("mistral", "mistral-large-latest", apiKey), 0.2);

console.log("");
console.log("answer:");
let start = time.monotonic();
let stats = new Map<string, i64>();
stats.set("deltas", 0);
stats.set("firstAt", -1);

let onEvent: StreamHandler = (event: StreamEvent): void => {
  if (event.kind == "delta") {
    stats.set("deltas", (stats.get("deltas") ?? 0) + 1);
    if ((stats.get("firstAt") ?? -1) < 0) { stats.set("firstAt", time.monotonic() - start); }
    console.log(`  +${time.monotonic() - start}ms ${event.delta}`);
  }
  if (event.kind == "error") {
    console.error(`stream error: ${event.raw}`);
  }
};

let result = streamChat(chatCfg, [system(grounding), user(question)], onEvent);

console.log("");
console.log(`first token after ${stats.get("firstAt") ?? -1}ms, ${stats.get("deltas") ?? 0} deltas`);
console.log("");
console.log(result.content);

pgClose();

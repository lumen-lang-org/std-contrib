// The whole retrieval-augmented path, end to end, with nothing faked:
//
//   split -> embed with mistral-embed -> store vectors in PostgreSQL
//          -> embed the question -> search pgvector
//          -> ground a prompt in what came back
//          -> stream the answer from mistral-large as it is generated
//
// Every part is real: a real embedding model, a real database doing the
// ranking, and a real streamed completion. Nothing is held in memory between
// runs, so a second run re-uses the stored vectors and only pays for the query.
//
// Setup:
//   sh packages/pgvector/build.sh
//   createdb lumenvec && psql lumenvec -c 'CREATE EXTENSION vector'
//   export MISTRAL_API_KEY="..."
//   cd packages/pgvector && lumen compile examples/rag-stream.ts
//   ./rag-stream "does a compiled binary need a runtime?"

import { pgConnect, pgCreateStore, pgUpsert, pgSearch, pgHas, pgCount, pgClose } from "../pgvector.ts";
import { modelConfig, withTemperature, embedBatchWithConfig, splitDocument, loadText, streamChat, system, user } from "../../ai/ai.ts";

const DIMS = 1024;
const TABLE = "lumen_rag";

let apiKey = process.env("MISTRAL_API_KEY") ?? "";
if (apiKey == "") {
  console.error("set MISTRAL_API_KEY");
  process.exit(1);
}

let question = "does a compiled binary need a runtime?";
if (process.argv.length >= 2) { question = process.argv[1]; }

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

let notes = "Lumen compiles TypeScript syntax to a native binary. There is no virtual machine and no interpreter, so a program begins running the moment it is executed.\n\n"
  + "Sourdough needs a starter, flour, water and salt. The starter is wild yeast kept alive by regular feeding, and it takes about a week to establish.\n\n"
  + "An interpreted runtime must load and parse its libraries on every launch. That work happens before the first line of user code runs, which is why cold starts dominate short-lived processes.\n\n"
  + "The pgvector extension stores embeddings in PostgreSQL and ranks them with distance operators, so a search runs in the database rather than in the calling program.";

let doc = loadText(notes, "notes.txt");
let parts = splitDocument(doc, 260, 40);

let embedCfg = modelConfig("mistral", "mistral-embed", apiKey);

// Only embed chunks the table does not already hold.
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
    let stored = pgUpsert(TABLE, parts[at].id, parts[at].text, parts[at].source, "", vectors[v]);
    if (!stored.ok) {
      console.error(stored.error);
      process.exit(1);
    }
    v = v + 1;
  }
} else {
  console.log(`all ${parts.length} chunks already stored`);
}
console.log(`${pgCount(TABLE)} chunks indexed`);

// Retrieve.
let queryBatch: string[] = [question];
let queryRows = embedBatchWithConfig(embedCfg, queryBatch);
if (queryRows.length == 0) {
  console.error("the question could not be embedded");
  process.exit(1);
}
let hits = pgSearch(TABLE, queryRows[0], 2);

console.log("");
console.log(`question: ${question}`);
console.log("");
console.log("retrieved:");
let h: int = 0;
let context = "";
while (h < hits.length) {
  console.log(`  [${h + 1}] ${hits[h].score}  ${hits[h].text.slice(0, 62)}`);
  context = context + "[" + `${h + 1}` + "] " + hits[h].text + "\n\n";
  h = h + 1;
}

// Ground the prompt in what was retrieved, and say what to do when it does not
// answer — an ungrounded model will otherwise fill the gap from memory.
let grounding = "Answer only from the context below. Cite the bracket number of"
  + " each claim. If the context does not answer the question, reply exactly:"
  + " The context does not contain the answer.\n\nContext:\n" + context;

let chatCfg = withTemperature(modelConfig("mistral", "mistral-large-latest", apiKey), 0.2);

console.log("answer:");
let start = time.monotonic();
let stats = new Map<string, i64>();
stats.set("deltas", 0);
stats.set("firstAt", -1);

let onEvent: AiStreamHandler = (event: AiStreamEvent): void => {
  if (event.kind == "delta") {
    let n = stats.get("deltas") ?? 0;
    stats.set("deltas", n + 1);
    if ((stats.get("firstAt") ?? -1) < 0) { stats.set("firstAt", time.monotonic() - start); }
    console.log(`  +${time.monotonic() - start}ms ${event.delta}`);
  }
  if (event.kind == "error") {
    console.error(`stream error: ${event.raw}`);
  }
};

let result = streamChat(chatCfg, [
  system(grounding),
  user(question),
], onEvent);

console.log("");
console.log(`first token after ${stats.get("firstAt") ?? -1}ms, ${stats.get("deltas") ?? 0} deltas over ${time.monotonic() - start}ms`);
console.log("");
console.log("assembled:");
console.log(result.content);

pgClose();

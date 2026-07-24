// Index text with real embeddings, store the vectors in PostgreSQL, and search
// them — the whole path, with nothing held in memory between runs.
//
// Run it twice: the second run finds the chunks already stored and skips the
// embedding calls, which is the point of persisting them. An in-memory store
// pays a provider again for text that has not changed.
//
// Setup:
//   sh packages/pgvector/build.sh
//   createdb lumenvec && psql lumenvec -c 'CREATE EXTENSION vector'
//   export MISTRAL_API_KEY="..."
//   cd packages/pgvector && lumen compile examples/index-and-search.ts
//   ./index-and-search "what starts instantly?"

// `search` and `count` are aliased: the ai barrel exports names of its own, and
// every module is inlined into one namespace.
import { pgConnect, pgCreateStore, pgUpsert, pgSearch as pgSearch, pgCount as pgCount, pgHas as pgHas, pgClose as pgClose } from "../pgvector.ts";
import { modelConfig, embedBatchWithConfig, splitDocument, loadText, docMetadata } from "../../ai/ai.ts";

// mistral-embed returns 1024 dimensions; the column is fixed at that width, so
// a table built for one model cannot hold another's vectors.
const DIMS = 1024;
const TABLE = "lumen_docs";

let apiKey = process.env("MISTRAL_API_KEY") ?? "";
if (apiKey == "") {
  console.error("set MISTRAL_API_KEY");
  process.exit(1);
}

let question = "what starts instantly?";
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

let notes = "A compiled binary begins running the moment it is executed, with no virtual machine to warm up first.\n\n"
  + "Sourdough needs a starter, flour, water and salt. The starter is wild yeast kept alive by regular feeding.\n\n"
  + "Interpreted runtimes must load and parse their libraries on every launch before the first line of user code runs.";

let doc = loadText(notes, "notes.txt");
let parts = splitDocument(doc, 200, 0);

// Only embed what is missing. The chunk id is derived from the source and the
// chunk index, so unchanged text keeps the same id across runs.
let pending: string[] = [];
let pendingIds: string[] = [];
let i: int = 0;
while (i < parts.length) {
  if (!pgHas(TABLE, parts[i].id)) {
    pending = [...pending, parts[i].text];
    pendingIds = [...pendingIds, parts[i].id];
  }
  i = i + 1;
}

let embedCfg = modelConfig("mistral", "mistral-embed", apiKey);

if (pending.length == 0) {
  console.log(`all ${parts.length} chunks already stored — no embedding calls`);
} else {
  console.log(`embedding ${pending.length} of ${parts.length} chunks`);
  let vectors = embedBatchWithConfig(embedCfg, pending);
  if (vectors.length != pending.length) {
    console.error("embedding failed — nothing stored");
    process.exit(1);
  }
  let j: int = 0;
  while (j < parts.length) {
    let at = -1;
    let k: int = 0;
    while (k < pendingIds.length) {
      if (pendingIds[k] == parts[j].id) { at = k; }
      k = k + 1;
    }
    if (at >= 0) {
      let stored = pgUpsert(TABLE, parts[j].id, parts[j].text, parts[j].source,
        "chunk=" + docMetadata(parts[j], "chunk"), vectors[at]);
      if (!stored.ok) {
        console.error(stored.error);
        process.exit(1);
      }
    }
    j = j + 1;
  }
}

console.log(`${pgCount(TABLE)} chunks in the table`);

// The query is embedded by the same model — a query and a document embedded by
// different models are not comparable, however similar the numbers look.
let queryBatch: string[] = [question];
let queryRows = embedBatchWithConfig(embedCfg, queryBatch);
if (queryRows.length == 0) {
  console.error("the query could not be embedded");
  process.exit(1);
}

console.log("");
console.log(`question: ${question}`);
console.log("");

// The database does the ranking, and returns only what was asked for.
let hits = pgSearch(TABLE, queryRows[0], 3);
let h: int = 0;
while (h < hits.length) {
  console.log(`${hits[h].score}  ${hits[h].source}  ${hits[h].text.slice(0, 60)}`);
  h = h + 1;
}

pgClose();

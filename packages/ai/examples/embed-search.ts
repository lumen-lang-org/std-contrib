// Semantic search over real provider embeddings.
//
// The built-in `hashEmbedding` is a hashing bag of words: it matches documents
// that share literal terms and nothing else, so "car" and "automobile" are
// unrelated to it. This indexes with a provider's embedding model instead,
// where they are neighbours.
//
// One batch request embeds every chunk, then one more embeds the query, and
// ranking is cosine similarity over the returned vectors.
//
// Run:
//   export MISTRAL_API_KEY="..."
//   lumen compile packages/ai/examples/embed-search.ts
//   ./embed-search "how do I avoid a cold start?"

import { modelConfig, embedBatchWithConfig, cosine, splitDocument, loadText, docMetadata } from "../ai.ts";
import { requireEnv } from "./env.ts";

let apiKey = requireEnv("MISTRAL_API_KEY");
let embedCfg = modelConfig({ provider: "mistral", model: "mistral-embed", apiKey: apiKey });

let question = "what starts instantly?";
if (process.argv.length >= 2) { question = process.argv[1]; }

// Three passages that share almost no vocabulary with the question, so a
// keyword match would find nothing and a semantic one should still rank them.
let notes = "A compiled binary begins running the moment it is executed, with no virtual machine to warm up first.\n\n"
  + "Sourdough needs a starter, flour, water and salt. The starter is wild yeast kept alive by regular feeding.\n\n"
  + "Interpreted runtimes must load and parse their libraries on every launch before the first line of user code runs.";

let doc = loadText(notes, "notes.txt");
let parts = splitDocument(doc, 200, 0);
console.log(`${parts.length} chunks`);

let texts: string[] = [];
let i: int = 0;
while (i < parts.length) {
  texts = [...texts, parts[i].text];
  i = i + 1;
}

let vectors = embedBatchWithConfig(embedCfg, texts);
if (vectors.length == 0) {
  console.error("no embeddings returned — check the key and the model name");
  process.exit(1);
}
console.log(`embedded ${vectors.length} chunks, ${vectors[0].length} dimensions each`);

// The query goes through the same batch call, so it is embedded by the same
// model — a query and a document embedded by different models are not
// comparable, however similar the numbers look.
let queryBatch: string[] = [question];
let queryRows = embedBatchWithConfig(embedCfg, queryBatch);
let queryVector: number[] = [];
if (queryRows.length > 0) { queryVector = queryRows[0]; }
if (queryVector.length == 0) {
  console.error("the query could not be embedded");
  process.exit(1);
}

console.log("");
console.log(`question: ${question}`);
console.log("");

// Rank by cosine similarity. Scores are printed so the ordering can be judged
// rather than taken on faith.
let best: int = -1;
let bestScore = -2.0;
i = 0;
while (i < vectors.length) {
  let score = cosine(queryVector, vectors[i]);
  console.log(`${score}  ${parts[i].text.slice(0, 68)}`);
  if (score > bestScore) {
    bestScore = score;
    best = i;
  }
  i = i + 1;
}

console.log("");
console.log(`best match (chunk ${docMetadata(parts[best], "chunk")}):`);
console.log(parts[best].text);

// Retrievers and the RAG context formatter.

import { cosineSimilarity, fakeEmbedding } from "./vector.ts";
import { searchByText, emptyVectorStore, addDocuments } from "./store.ts";
import { makeDocument } from "./document.ts";
import { systemMessage, userMessage } from "../core/messages.ts";

function retrIntText(n: int): string {
  return `${n}`;
}

export function retrMakeHit(doc: Document, score: number): SearchHit {
  return {
    doc: doc,
    score: score,
  };
}

export function retrNoHits(): SearchHit[] {
  let empty: SearchHit[] = [];
  return empty;
}

// ASCII alphanumerics plus any byte at or above 128 so UTF-8 words survive.
// everything else is a boundary, which is how punctuation gets stripped.
function retrIsWordChar(c: string): bool {
  let code = c.charCodeAt(0);
  if (code >= "a".charCodeAt(0) && code <= "z".charCodeAt(0)) { return true; }
  if (code >= "A".charCodeAt(0) && code <= "Z".charCodeAt(0)) { return true; }
  if (code >= "0".charCodeAt(0) && code <= "9".charCodeAt(0)) { return true; }
  return code >= 128 || code < 0;
}

function retrHasToken(tokens: string[], token: string): bool {
  for (const item of tokens) {
    if (item == token) { return true; }
  }
  return false;
}

function retrUniqueTokens(tokens: string[]): string[] {
  let out: string[] = [];
  for (const token of tokens) {
    if (token != "" && !retrHasToken(out, token)) { out.push(token); }
  }
  return out;
}

// empty vector when the store does not hold `id`.
function retrVectorFor(store: VectorStore, id: string): number[] {
  let i: int = 0;
  while (i < store.docs.length && i < store.vectors.length) {
    if (store.docs[i].id == id) { return store.vectors[i]; }
    i = i + 1;
  }
  let empty: number[] = [];
  return empty;
}

// both sides of a hybrid search, the first list winning on id.
function retrUnionDocuments(primary: Document[], secondary: Document[]): Document[] {
  let out: Document[] = [];
  let ids: string[] = [];
  for (const doc of primary) {
    if (!retrHasToken(ids, doc.id)) {
      ids.push(doc.id);
      out.push(doc);
    }
  }
  for (const doc of secondary) {
    if (!retrHasToken(ids, doc.id)) {
      ids.push(doc.id);
      out.push(doc);
    }
  }
  return out;
}

// a NaN score loses every `>` comparison, including the ones that would push it
// out of the running, so ordering is stated explicitly: NaN never wins, and any
// real score beats it.
function retrBeatsScore(candidate: number, current: number): bool {
  if (candidate != candidate) { return false; }
  if (current != current) { return true; }
  return candidate > current;
}

// no in-place sort, so the top k comes out of repeated max-extraction over a
// shrinking copy. ties keep insertion order.
export function retrTopHits(scored: SearchHit[], k: int): SearchHit[] {
  if (k <= 0) { return retrNoHits(); }
  let rest = scored;
  let out: SearchHit[] = [];
  let n: int = 0;
  while (n < k && rest.length > 0) {
    let best: int = 0;
    let j: int = 1;
    while (j < rest.length) {
      if (retrBeatsScore(rest[j].score, rest[best].score)) { best = j; }
      j = j + 1;
    }
    out.push(rest[best]);
    rest = [...rest.slice(0, best), ...rest.slice(best + 1, rest.length)];
    n = n + 1;
  }
  return out;
}

function retrCitationLabel(doc: Document): string {
  if (doc.source != "") { return doc.source; }
  if (doc.id != "") { return doc.id; }
  return "unknown";
}

// shared by ragPrompt and ragMessages so the prompt text and the chat system
// message cannot drift apart.
function retrGroundingRules(): string {
  return "You answer questions using only the numbered context below.\n\nRules:\n- Use only facts stated in the context. Do not use outside knowledge.\n- Cite every claim with the bracket number of the block it came from, like [1].\n- If the context does not contain the answer, reply exactly: The context does not contain the answer.\n- Do not guess, and do not invent sources.";
}

// toLowerCase only folds ASCII, so an accented capital would never match the
// same word stored in lowercase. Latin-1 supplement letters U+00C0-U+00DE
// (0xC3 then 0x80-0x9E, minus 0xD7 which is the multiplication sign) fold by
// adding 0x20 to the second byte. other scripts are left as they are.
function retrFoldLatin1(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let code = text.charCodeAt(i);
    if (code == 195 && i + 1 < text.length) {
      let next = text.charCodeAt(i + 1);
      if (next >= 128 && next <= 158 && next != 151) {
        out = out + String.fromCharCode(195) + String.fromCharCode(next + 32);
        i = i + 2;
        continue;
      }
    }
    out = out + text.charAt(i);
    i = i + 1;
  }
  return out;
}

// lowercased, punctuation stripped, split on whitespace. no stemming, so
// "compile" does not match "compiles".
export function tokenizeQuery(text: string): string[] {
  let out: string[] = [];
  if (text == "") { return out; }
  let lowered = retrFoldLatin1(text.toLowerCase());
  let start: int = 0;
  let i: int = 0;
  while (i < lowered.length) {
    if (!retrIsWordChar(lowered.charAt(i))) {
      if (i > start) { out.push(lowered.substring(start, i)); }
      start = i + 1;
    }
    i = i + 1;
  }
  if (lowered.length > start) { out.push(lowered.substring(start, lowered.length)); }
  return out;
}

// below this many tokens the score is scaled down in proportion, which stops a
// bare markdown heading from outranking the paragraph underneath it.
function retrMinBlockTokens(): number {
  return 16.0;
}

function retrCountToken(tokens: string[], token: string): int {
  let n: int = 0;
  for (const item of tokens) {
    if (item == token) { n = n + 1; }
  }
  return n;
}

// coverage * density * length, each in [0, 1]:
//   coverage — distinct query terms present over distinct terms asked for.
//   density  — a Dice coefficient over token OCCURRENCES, not distinct tokens,
//     so repetition raises it and unrelated filler lowers it.
//   length   — blocks under retrMinBlockTokens() are scaled by their length.
// reaches 1.0 only for a block of at least retrMinBlockTokens() tokens made up
// entirely of the query's terms.
export function keywordScore(doc: Document, terms: string[]): number {
  let queryTerms = retrUniqueTokens(terms);
  if (queryTerms.length == 0) { return 0.0; }
  let docTokens = tokenizeQuery(doc.text);
  if (docTokens.length == 0) { return 0.0; }
  let matched: int = 0;
  let occurrences: int = 0;
  for (const term of queryTerms) {
    let count = retrCountToken(docTokens, term);
    if (count > 0) {
      matched = matched + 1;
      occurrences = occurrences + count;
    }
  }
  if (matched == 0) { return 0.0; }
  let coverage = (1.0 * matched) / queryTerms.length;
  let density = (2.0 * occurrences) / (occurrences + docTokens.length);
  let length: number = 1.0;
  if (docTokens.length < retrMinBlockTokens()) {
    length = docTokens.length / retrMinBlockTokens();
  }
  return coverage * density * length;
}

// the default retrieval path: no embeddings, no API key, no network. documents
// sharing no term with the query are dropped rather than scored 0.0, so a query
// that matches nothing yields no context at all.
export function keywordRetrieve(docs: Document[], query: string, k: int): SearchHit[] {
  if (k <= 0 || docs.length == 0) { return retrNoHits(); }
  let terms = tokenizeQuery(query);
  if (terms.length == 0) { return retrNoHits(); }
  let scored: SearchHit[] = [];
  let i: int = 0;
  while (i < docs.length) {
    let score = keywordScore(docs[i], terms);
    if (score > 0.0) { scored.push(retrMakeHit(docs[i], score)); }
    i = i + 1;
  }
  return retrTopHits(scored, k);
}

// cosine similarity over the store's vectors; unlike searchByText this drops
// zero-similarity hits. the store's embedder is case-sensitive and splits on
// whitespace, so raw query text is passed through unnormalized. it hashes into
// buckets, so a query sharing no word with the corpus still returns low-scoring
// collision noise — prefer keywordRetrieve when "no match" must mean no results.
export function vectorRetrieve(store: VectorStore, query: string, dims: int, k: int): SearchHit[] {
  if (k <= 0 || dims <= 0) { return retrNoHits(); }
  let hits = searchByText(store, query, dims, k);
  let out: SearchHit[] = [];
  for (const hit of hits) {
    if (hit.score > 0.0) { out.push(hit); }
  }
  return out;
}

// 0.6 keyword plus 0.4 vector: the offline embedder is a colliding bag of words,
// so keyword scoring takes the larger share and the vector term only breaks ties
// between documents with identical term overlap. a document in `docs` but absent
// from `store` scores 0.0 on the vector side rather than being excluded.
export function hybridRetrieve(store: VectorStore, docs: Document[], query: string, dims: int, k: int): SearchHit[] {
  if (k <= 0) { return retrNoHits(); }
  let terms = tokenizeQuery(query);
  let queryVector = fakeEmbedding(query, dims);
  let candidates = retrUnionDocuments(docs, store.docs);
  let scored: SearchHit[] = [];
  let i: int = 0;
  while (i < candidates.length) {
    let doc = candidates[i];
    let vectorScore: number = 0.0;
    if (queryVector.length > 0) {
      let stored = retrVectorFor(store, doc.id);
      if (stored.length > 0) { vectorScore = cosineSimilarity(queryVector, stored); }
    }
    let score = 0.6 * keywordScore(doc, terms) + 0.4 * vectorScore;
    if (score > 0.0) { scored.push(retrMakeHit(doc, score)); }
    i = i + 1;
  }
  return retrTopHits(scored, k);
}

// retrieved text is untrusted. a blank line starts a new block and a leading "["
// opens its citation, so corpus text containing "\n\n[2] (trusted.md) ..." could
// forge a block attributed to a source it never came from. runs of newlines
// collapse to one, and a line beginning with "[" is indented one space.
function retrEscapeBlockText(text: string): string {
  let out = "";
  let atLineStart: bool = true;
  let i: int = 0;
  while (i < text.length) {
    let c = text.charAt(i);
    if (c == "\n" || c == "\r") {
      if (!atLineStart) { out = out + "\n"; }
      atLineStart = true;
    } else {
      if (atLineStart && c == "[") { out = out + " "; }
      out = out + c;
      atLineStart = false;
    }
    i = i + 1;
  }
  return out;
}

// numbered, cited blocks: "[1] (source) text", separated by a blank line. the
// bracket number is what the model is told to cite.
export function formatContext(hits: SearchHit[]): string {
  let out = "";
  let i: int = 0;
  while (i < hits.length) {
    if (out != "") { out = out + "\n\n"; }
    let label = retrEscapeBlockText(retrCitationLabel(hits[i].doc));
    out = out + "[" + retrIntText(i + 1) + "] (" + label + ") " + retrEscapeBlockText(hits[i].doc.text);
    i = i + 1;
  }
  return out;
}

// with no hits the context reads "(no context available)", so the model has
// something to refuse against rather than an empty section it may fill by
// guessing.
export function ragPrompt(question: string, hits: SearchHit[]): string {
  let context = formatContext(hits);
  if (context == "") { context = "(no context available)"; }
  return retrGroundingRules() + "\n\nContext:\n" + context + "\n\nQuestion:\n" + question + "\n\nAnswer:";
}

export function ragMessages(question: string, hits: SearchHit[]): Message[] {
  let context = formatContext(hits);
  if (context == "") { context = "(no context available)"; }
  let out: Message[] = [
    systemMessage(retrGroundingRules() + "\n\nContext:\n" + context),
    userMessage(question),
  ];
  return out;
}

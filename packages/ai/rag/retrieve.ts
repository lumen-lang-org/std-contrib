// Retrievers and the RAG context formatter.

import { cosineSimilarity, fakeEmbedding } from "./vector.ts";
import { searchByText, emptyVectorStore, addDocuments } from "./store.ts";
import { makeDocument } from "./document.ts";
import { systemMessage, userMessage } from "../core/messages.ts";

function retrIntText(n: int): string {
  return `${n}`;
}

export function retrMakeHit(doc: AiDocument, score: number): AiSearchHit {
  return {
    doc: doc,
    score: score,
  };
}

export function retrNoHits(): AiSearchHit[] {
  let empty: AiSearchHit[] = [];
  return empty;
}

// A token character is an ASCII letter or digit, or any byte at or above 128 so
// UTF-8 words survive. Everything else — whitespace and ASCII punctuation — is a
// boundary, which is how punctuation gets stripped.
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

// Vector belonging to `id`, or an empty vector when the store does not hold it.
function retrVectorFor(store: AiVectorStore, id: string): number[] {
  let i: int = 0;
  while (i < store.docs.length && i < store.vectors.length) {
    if (store.docs[i].id == id) { return store.vectors[i]; }
    i = i + 1;
  }
  let empty: number[] = [];
  return empty;
}

// Documents from both sides of a hybrid search, first list winning on id.
function retrUnionDocuments(primary: AiDocument[], secondary: AiDocument[]): AiDocument[] {
  let out: AiDocument[] = [];
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

// A NaN score loses every `>` comparison, including the ones that would push it
// out of the running, so seeding the search at index 0 would leave a NaN hit
// sitting at the top of the results ahead of a perfect match. Ordering is
// stated explicitly instead: NaN never wins, and any real score beats it.
function retrBeatsScore(candidate: number, current: number): bool {
  if (candidate != candidate) { return false; }
  if (current != current) { return true; }
  return candidate > current;
}

// Sorting in place is impossible, so the top k comes out of repeated
// max-extraction over a shrinking copy. Ties keep insertion order.
export function retrTopHits(scored: AiSearchHit[], k: int): AiSearchHit[] {
  if (k <= 0) { return retrNoHits(); }
  let rest = scored;
  let out: AiSearchHit[] = [];
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

// The citation label prefers the source path, falls back to the document id,
// and never renders an empty bracket pair.
function retrCitationLabel(doc: AiDocument): string {
  if (doc.source != "") { return doc.source; }
  if (doc.id != "") { return doc.id; }
  return "unknown";
}

// One instruction body shared by ragPrompt and ragMessages so the prompt text
// and the chat system message never drift apart.
function retrGroundingRules(): string {
  return "You answer questions using only the numbered context below.\n\nRules:\n- Use only facts stated in the context. Do not use outside knowledge.\n- Cite every claim with the bracket number of the block it came from, like [1].\n- If the context does not contain the answer, reply exactly: The context does not contain the answer.\n- Do not guess, and do not invent sources.";
}

// toLowerCase only folds ASCII, and retrIsWordChar keeps every byte at or above
// 128, so an accented capital would survive uppercase and never match the same
// word stored in lowercase — "CAFÉ" would tokenize to "cafÉ". The Latin-1
// supplement letters U+00C0-U+00DE (encoded as 0xC3 followed by 0x80-0x9E, with
// 0xD7 being the multiplication sign rather than a letter) fold by adding 0x20
// to the second byte. Other scripts are left as they are.
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

// Lowercased, punctuation stripped, split on whitespace. There is no stemming,
// so "compile" does not match "compiles".
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

// A retrieved block is context for a model to answer from, so a block too short
// to say anything is not a useful result however well its words match. Below
// this many tokens the score is scaled down in proportion, which is what stops
// a bare markdown heading from outranking the paragraph underneath it.
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

// Three factors, each in [0, 1], multiplied together:
//
//   coverage — distinct query terms the block mentions, over the distinct terms
//     asked for. How much of the question this block speaks to.
//   density  — a Dice coefficient over token OCCURRENCES rather than distinct
//     tokens: 2 * matching occurrences / (matching occurrences + total tokens).
//     Repeating a query term raises it, and unrelated filler lowers it, so a
//     block that is genuinely about the query beats one that mentions it once
//     in passing.
//   length   — blocks shorter than retrMinBlockTokens() are scaled by their
//     length, so a one-token fragment cannot reach the top on a perfect but
//     meaningless match.
//
// The result is in [0, 1], and reaches 1.0 only for a block of at least
// retrMinBlockTokens() tokens made up entirely of the query's terms.
export function keywordScore(doc: AiDocument, terms: string[]): number {
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

// The default retrieval path: no embeddings, no API key, no network. Documents
// that share no term with the query are dropped rather than returned with a
// zero score, so a query that matches nothing yields no context at all.
export function keywordRetrieve(docs: AiDocument[], query: string, k: int): AiSearchHit[] {
  if (k <= 0 || docs.length == 0) { return retrNoHits(); }
  let terms = tokenizeQuery(query);
  if (terms.length == 0) { return retrNoHits(); }
  let scored: AiSearchHit[] = [];
  let i: int = 0;
  while (i < docs.length) {
    let score = keywordScore(docs[i], terms);
    if (score > 0.0) { scored.push(retrMakeHit(docs[i], score)); }
    i = i + 1;
  }
  return retrTopHits(scored, k);
}

// Cosine similarity over the store's vectors. Unlike searchByText this drops
// zero-similarity hits, because a zero-scoring block is noise once it is stuffed
// into a prompt. The store's embedder tokenizes on whitespace and is
// case-sensitive, so raw query text matches stored text better than a
// normalized one does. It is also a hashing embedder, so a query sharing no
// word with the corpus still returns low-scoring collision noise rather than
// nothing — prefer keywordRetrieve when "no match" must mean no results.
export function vectorRetrieve(store: AiVectorStore, query: string, dims: int, k: int): AiSearchHit[] {
  if (k <= 0 || dims <= 0) { return retrNoHits(); }
  let hits = searchByText(store, query, dims, k);
  let out: AiSearchHit[] = [];
  for (const hit of hits) {
    if (hit.score > 0.0) { out.push(hit); }
  }
  return out;
}

// Weighting: 0.6 keyword plus 0.4 vector. Keyword scoring is the more
// trustworthy signal here because the offline embedder is a hashing bag of
// words whose buckets collide, so it is given the larger share; the vector term
// still breaks ties between documents with identical term overlap. Both scores
// are in [0, 1] for a sane corpus, so the combined score is too. A document
// present in `docs` but absent from `store` simply scores 0.0 on the vector
// side rather than being excluded.
export function hybridRetrieve(store: AiVectorStore, docs: AiDocument[], query: string, dims: int, k: int): AiSearchHit[] {
  if (k <= 0) { return retrNoHits(); }
  let terms = tokenizeQuery(query);
  let queryVector = fakeEmbedding(query, dims);
  let candidates = retrUnionDocuments(docs, store.docs);
  let scored: AiSearchHit[] = [];
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

// Retrieved text is untrusted: it is whatever was in the corpus. A blank line
// starts a new block and a leading "[" opens its citation, so a document whose
// text contains "\n\n[2] (trusted.md) ..." would otherwise hand the model a
// block attributed to a source it never came from. Runs of newlines collapse to
// one so a block cannot be split, and a line beginning with "[" is indented one
// space so it cannot be read as a citation header.
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

// Numbered, cited blocks: "[1] (source) text", separated by a blank line. The
// bracket number is what the model is told to cite, and the label is what a
// human follows back to the original file. Empty hits produce an empty string.
export function formatContext(hits: AiSearchHit[]): string {
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

// The full grounded-answer instruction. With no hits the context block reads
// "(no context available)" so the model still has something to refuse against
// rather than an empty section it might treat as an invitation to guess.
export function ragPrompt(question: string, hits: AiSearchHit[]): string {
  let context = formatContext(hits);
  if (context == "") { context = "(no context available)"; }
  return retrGroundingRules() + "\n\nContext:\n" + context + "\n\nQuestion:\n" + question + "\n\nAnswer:";
}

// A system message carrying the rules and the context, plus the user question,
// ready to hand to chatOpenAI or chatMistral.
export function ragMessages(question: string, hits: AiSearchHit[]): AiMessage[] {
  let context = formatContext(hits);
  if (context == "") { context = "(no context available)"; }
  let out: AiMessage[] = [
    systemMessage(retrGroundingRules() + "\n\nContext:\n" + context),
    userMessage(question),
  ];
  return out;
}

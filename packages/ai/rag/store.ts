// In-memory vector store with top-k similarity search.

import { cosineSimilarity, fakeEmbedding } from "./vector.ts";
import { makeDocument, withMetadata, documentMetadata } from "./document.ts";

type AiVectorStore = {
  docs: AiDocument[],
  vectors: number[][],
};

type AiSearchHit = {
  doc: AiDocument,
  score: number,
};

export function makeSearchHit(doc: AiDocument, score: number): AiSearchHit {
  return {
    doc: doc,
    score: score,
  };
}

function makeVectorStore(docs: AiDocument[], vectors: number[][]): AiVectorStore {
  return {
    docs: docs,
    vectors: vectors,
  };
}

function noSearchHits(): AiSearchHit[] {
  let empty: AiSearchHit[] = [];
  return empty;
}

// docs and vectors are parallel lists: a vector is only usable when the doc at
// the same index exists.
function storeVectorAt(store: AiVectorStore, index: int): number[] {
  if (index < 0 || index >= store.vectors.length) {
    let empty: number[] = [];
    return empty;
  }
  return store.vectors[index];
}

export function emptyVectorStore(): AiVectorStore {
  let docs: AiDocument[] = [];
  let vectors: number[][] = [];
  return makeVectorStore(docs, vectors);
}

export function storeSize(store: AiVectorStore): int {
  return store.docs.length;
}

// values are immutable, so every write returns a fresh store.
export function addVector(store: AiVectorStore, doc: AiDocument, vector: number[]): AiVectorStore {
  return makeVectorStore([...store.docs, doc], [...store.vectors, vector]);
}

export function addDocuments(store: AiVectorStore, docs: AiDocument[], dims: int): AiVectorStore {
  let out = store;
  let i: int = 0;
  while (i < docs.length) {
    out = addVector(out, docs[i], fakeEmbedding(docs[i].text, dims));
    i = i + 1;
  }
  return out;
}

export function deleteById(store: AiVectorStore, id: string): AiVectorStore {
  let docs: AiDocument[] = [];
  let vectors: number[][] = [];
  let i: int = 0;
  while (i < store.docs.length) {
    if (store.docs[i].id != id) {
      docs.push(store.docs[i]);
      vectors.push(storeVectorAt(store, i));
    }
    i = i + 1;
  }
  return makeVectorStore(docs, vectors);
}

export function filterByMetadata(store: AiVectorStore, key: string, value: string): AiVectorStore {
  let docs: AiDocument[] = [];
  let vectors: number[][] = [];
  let i: int = 0;
  while (i < store.docs.length) {
    if (documentMetadata(store.docs[i], key) == value) {
      docs.push(store.docs[i]);
      vectors.push(storeVectorAt(store, i));
    }
    i = i + 1;
  }
  return makeVectorStore(docs, vectors);
}

// a NaN score loses every `>` comparison, including the ones that would push it
// out of the running, so ordering is stated explicitly: NaN never wins, and any
// real score beats it.
function storeBeatsScore(candidate: number, current: number): bool {
  if (candidate != candidate) { return false; }
  if (current != current) { return true; }
  return candidate > current;
}

// no in-place sort, so the top k comes out of repeated max-extraction over a
// shrinking copy. ties keep insertion order.
export function storeTopHits(scored: AiSearchHit[], k: int): AiSearchHit[] {
  let rest = scored;
  let out: AiSearchHit[] = [];
  let n: int = 0;
  while (n < k && rest.length > 0) {
    let best: int = 0;
    let j: int = 1;
    while (j < rest.length) {
      if (storeBeatsScore(rest[j].score, rest[best].score)) { best = j; }
      j = j + 1;
    }
    out.push(rest[best]);
    rest = [...rest.slice(0, best), ...rest.slice(best + 1, rest.length)];
    n = n + 1;
  }
  return out;
}

export function searchByVector(store: AiVectorStore, query: number[], k: int): AiSearchHit[] {
  if (k <= 0 || store.docs.length == 0 || query.length == 0) { return noSearchHits(); }
  let scored: AiSearchHit[] = [];
  let i: int = 0;
  while (i < store.docs.length && i < store.vectors.length) {
    scored.push(makeSearchHit(store.docs[i], cosineSimilarity(query, store.vectors[i])));
    i = i + 1;
  }
  return storeTopHits(scored, k);
}

export function searchByText(store: AiVectorStore, query: string, dims: int, k: int): AiSearchHit[] {
  if (k <= 0 || dims <= 0) { return noSearchHits(); }
  return searchByVector(store, fakeEmbedding(query, dims), k);
}

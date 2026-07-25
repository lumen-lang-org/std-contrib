// In-memory vector store with top-k similarity search.

import { cosineSimilarity, fakeEmbedding } from "./vector.ts";
import { makeDocument, withMetadata, documentMetadata } from "./document.ts";

type VectorStore = {
  docs: Document[],
  vectors: number[][],
};

type SearchHit = {
  doc: Document,
  score: number,
};

export function makeSearchHit(doc: Document, score: number): SearchHit {
  return {
    doc: doc,
    score: score,
  };
}

function makeVectorStore(docs: Document[], vectors: number[][]): VectorStore {
  return {
    docs: docs,
    vectors: vectors,
  };
}

function noSearchHits(): SearchHit[] {
  let empty: SearchHit[] = [];
  return empty;
}

// docs and vectors are parallel lists: a vector is only usable when the doc at
// the same index exists.
function storeVectorAt(store: VectorStore, index: int): number[] {
  if (index < 0 || index >= store.vectors.length) {
    let empty: number[] = [];
    return empty;
  }
  return store.vectors[index];
}

export function emptyVectorStore(): VectorStore {
  let docs: Document[] = [];
  let vectors: number[][] = [];
  return makeVectorStore(docs, vectors);
}

export function storeSize(store: VectorStore): int {
  return store.docs.length;
}

// values are immutable, so every write returns a fresh store.
export function addVector(store: VectorStore, doc: Document, vector: number[]): VectorStore {
  return makeVectorStore([...store.docs, doc], [...store.vectors, vector]);
}

export function addDocuments(store: VectorStore, docs: Document[], dims: int): VectorStore {
  let out = store;
  let i: int = 0;
  while (i < docs.length) {
    out = addVector(out, docs[i], fakeEmbedding(docs[i].text, dims));
    i = i + 1;
  }
  return out;
}

export function deleteById(store: VectorStore, id: string): VectorStore {
  let docs: Document[] = [];
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

export function filterByMetadata(store: VectorStore, key: string, value: string): VectorStore {
  let docs: Document[] = [];
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
export function storeTopHits(scored: SearchHit[], k: int): SearchHit[] {
  let rest = scored;
  let out: SearchHit[] = [];
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

export function searchByVector(store: VectorStore, query: number[], k: int): SearchHit[] {
  if (k <= 0 || store.docs.length == 0 || query.length == 0) { return noSearchHits(); }
  let scored: SearchHit[] = [];
  let i: int = 0;
  while (i < store.docs.length && i < store.vectors.length) {
    scored.push(makeSearchHit(store.docs[i], cosineSimilarity(query, store.vectors[i])));
    i = i + 1;
  }
  return storeTopHits(scored, k);
}

export function searchByText(store: VectorStore, query: string, dims: int, k: int): SearchHit[] {
  if (k <= 0 || dims <= 0) { return noSearchHits(); }
  return searchByVector(store, fakeEmbedding(query, dims), k);
}

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

function makeSearchHit(doc: AiDocument, score: number): AiSearchHit {
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

// The store keeps docs and vectors as parallel lists, so a vector is only
// usable when the doc at the same index exists.
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

// Values are immutable, so every write returns a fresh store.
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

// A NaN score loses every `>` comparison, including the ones that would push it
// out of the running, so seeding the search at index 0 would leave a NaN hit
// sitting at the top of the results ahead of a perfect match. Ordering is
// stated explicitly instead: NaN never wins, and any real score beats it.
function storeBeatsScore(candidate: number, current: number): bool {
  if (candidate != candidate) { return false; }
  if (current != current) { return true; }
  return candidate > current;
}

// Sorting in place is impossible, so the top k comes out of repeated
// max-extraction over a shrinking copy. Ties keep insertion order.
function storeTopHits(scored: AiSearchHit[], k: int): AiSearchHit[] {
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

test("empty vector store", () => {
  let store = emptyVectorStore();
  expect(storeSize(store) == 0);
  expect(store.docs.length == 0);
  expect(store.vectors.length == 0);
});

test("add vector returns a new store", () => {
  let store = emptyVectorStore();
  let doc = makeDocument("d1", "hello", "notes.txt", "");
  let v: number[] = [1.0, 0.0];
  let next = addVector(store, doc, v);
  expect(storeSize(next) == 1);
  expect(storeSize(store) == 0);
  expect(next.docs[0].id == "d1");
  expect(next.vectors[0][0] == 1.0);
  expect(next.vectors[0].length == 2);
});

test("add documents embeds each document", () => {
  let store = emptyVectorStore();
  let docs: AiDocument[] = [
    makeDocument("d1", "alpha beta gamma", "notes.txt", ""),
    makeDocument("d2", "delta epsilon zeta", "notes.txt", ""),
  ];
  let filled = addDocuments(store, docs, 64);
  expect(storeSize(filled) == 2);
  expect(filled.vectors.length == 2);
  expect(filled.vectors[0].length == 64);
  expect(filled.vectors[1].length == 64);
  expect(filled.docs[1].id == "d2");
  expect(storeSize(store) == 0);
  let none: AiDocument[] = [];
  expect(storeSize(addDocuments(filled, none, 64)) == 2);
});

test("delete by id", () => {
  let store = emptyVectorStore();
  let docs: AiDocument[] = [
    makeDocument("d1", "alpha", "notes.txt", ""),
    makeDocument("d2", "beta", "notes.txt", ""),
    makeDocument("d3", "gamma", "notes.txt", ""),
  ];
  let filled = addDocuments(store, docs, 16);
  let pruned = deleteById(filled, "d2");
  expect(storeSize(pruned) == 2);
  expect(pruned.vectors.length == 2);
  expect(pruned.docs[0].id == "d1");
  expect(pruned.docs[1].id == "d3");
  expect(storeSize(filled) == 3);
  expect(storeSize(deleteById(filled, "missing")) == 3);
  expect(storeSize(deleteById(emptyVectorStore(), "d1")) == 0);
});

test("search by vector ranks descending", () => {
  let store = emptyVectorStore();
  let exact: number[] = [1.0, 0.0];
  let angled: number[] = [1.0, 1.0];
  let orthogonal: number[] = [0.0, 1.0];
  store = addVector(store, makeDocument("far", "far", "s", ""), orthogonal);
  store = addVector(store, makeDocument("near", "near", "s", ""), angled);
  store = addVector(store, makeDocument("exact", "exact", "s", ""), exact);
  let query: number[] = [1.0, 0.0];
  let hits = searchByVector(store, query, 3);
  expect(hits.length == 3);
  expect(hits[0].doc.id == "exact");
  expect(hits[1].doc.id == "near");
  expect(hits[2].doc.id == "far");
  expect(hits[0].score >= hits[1].score);
  expect(hits[1].score >= hits[2].score);
  expect(hits[0].score > 0.999999);
  expect(hits[2].score == 0.0);
});

test("search by vector honours k", () => {
  let store = emptyVectorStore();
  let a: number[] = [1.0, 0.0];
  let b: number[] = [1.0, 1.0];
  let c: number[] = [0.0, 1.0];
  store = addVector(store, makeDocument("a", "a", "s", ""), a);
  store = addVector(store, makeDocument("b", "b", "s", ""), b);
  store = addVector(store, makeDocument("c", "c", "s", ""), c);
  let query: number[] = [1.0, 0.0];
  let top = searchByVector(store, query, 1);
  expect(top.length == 1);
  expect(top[0].doc.id == "a");
  let all = searchByVector(store, query, 99);
  expect(all.length == 3);
  expect(all[0].doc.id == "a");
  expect(all[2].doc.id == "c");
  expect(searchByVector(store, query, 0).length == 0);
  expect(searchByVector(store, query, -4).length == 0);
});

test("search an empty store is safe", () => {
  let store = emptyVectorStore();
  let query: number[] = [1.0, 0.0];
  expect(searchByVector(store, query, 5).length == 0);
  expect(searchByText(store, "anything", 32, 5).length == 0);
  let noQuery: number[] = [];
  expect(searchByVector(store, noQuery, 5).length == 0);
});

test("search by text retrieves the closest document", () => {
  let store = emptyVectorStore();
  let docs: AiDocument[] = [
    makeDocument("cat", "the cat sat on the warm mat", "s", ""),
    makeDocument("physics", "quantum chromodynamics describes gluon interactions", "s", ""),
    makeDocument("lumen", "lumen compiles to a native binary", "s", ""),
  ];
  let filled = addDocuments(store, docs, 128);
  let hits = searchByText(filled, "the cat sat on the cold mat", 128, 2);
  expect(hits.length == 2);
  expect(hits[0].doc.id == "cat");
  expect(hits[0].score > hits[1].score);
  expect(hits[0].score > 0.5);
  expect(searchByText(filled, "the cat sat on the cold mat", 128, 0).length == 0);
  expect(searchByText(filled, "the cat sat on the cold mat", 0, 2).length == 0);
});

test("search by text over unembeddable query scores zero", () => {
  let store = emptyVectorStore();
  let docs: AiDocument[] = [
    makeDocument("d1", "alpha beta", "s", ""),
  ];
  let filled = addDocuments(store, docs, 32);
  let hits = searchByText(filled, "   ", 32, 1);
  expect(hits.length == 1);
  expect(hits[0].score == 0.0);
});

test("a NaN score never takes the top rank in the store", () => {
  let notANumber = 0.0 / 0.0;
  let scored: AiSearchHit[] = [
    makeSearchHit(makeDocument("poisoned", "poisoned", "s", ""), notANumber),
    makeSearchHit(makeDocument("perfect", "perfect", "s", ""), 1.0),
    makeSearchHit(makeDocument("okay", "okay", "s", ""), 0.707),
  ];
  let ranked = storeTopHits(scored, 3);
  expect(ranked.length == 3);
  expect(ranked[0].doc.id == "perfect");
  expect(ranked[1].doc.id == "okay");
  expect(ranked[2].doc.id == "poisoned");
  let allBroken: AiSearchHit[] = [
    makeSearchHit(makeDocument("a", "a", "s", ""), notANumber),
    makeSearchHit(makeDocument("b", "b", "s", ""), notANumber),
  ];
  expect(storeTopHits(allBroken, 2).length == 2);
});

test("a non-finite stored vector cannot take over the results", () => {
  let store = emptyVectorStore();
  let infinite = 1e308 * 10.0;
  let poisoned: number[] = [infinite, 0.0];
  let perfect: number[] = [1.0, 0.0];
  let okay: number[] = [1.0, 1.0];
  store = addVector(store, makeDocument("poisoned", "poisoned", "s", ""), poisoned);
  store = addVector(store, makeDocument("perfect", "perfect", "s", ""), perfect);
  store = addVector(store, makeDocument("okay", "okay", "s", ""), okay);
  let query: number[] = [1.0, 0.0];
  let hits = searchByVector(store, query, 3);
  expect(hits.length == 3);
  expect(hits[0].doc.id == "perfect");
  expect(hits[1].doc.id == "okay");
  expect(hits[2].doc.id == "poisoned");
  for (const hit of hits) {
    expect(hit.score == hit.score);
    expect(hit.score <= 1.0);
  }
});

test("metadata filtering cannot be bypassed by a forged value", () => {
  let store = emptyVectorStore();
  let docs: AiDocument[] = [
    withMetadata(makeDocument("public", "public secret", "s", ""), "note", "hello\nrole\tadmin"),
    withMetadata(makeDocument("private", "private secret", "s", ""), "role", "admin"),
  ];
  let filled = addDocuments(store, docs, 16);
  let admins = filterByMetadata(filled, "role", "admin");
  expect(storeSize(admins) == 1);
  expect(admins.docs[0].id == "private");
  expect(documentMetadata(filled.docs[0], "role") == "");
  expect(documentMetadata(filled.docs[0], "note") == "hello\nrole\tadmin");
});

test("filter by metadata", () => {
  let store = emptyVectorStore();
  let docs: AiDocument[] = [
    withMetadata(makeDocument("d1", "alpha", "notes.txt", ""), "lang", "en"),
    withMetadata(makeDocument("d2", "beta", "notes.txt", ""), "lang", "fr"),
    withMetadata(makeDocument("d3", "gamma", "notes.txt", ""), "lang", "en"),
  ];
  let filled = addDocuments(store, docs, 16);
  let english = filterByMetadata(filled, "lang", "en");
  expect(storeSize(english) == 2);
  expect(english.vectors.length == 2);
  expect(english.docs[0].id == "d1");
  expect(english.docs[1].id == "d3");
  expect(documentMetadata(english.docs[1], "lang") == "en");
  expect(storeSize(filled) == 3);
  expect(storeSize(filterByMetadata(filled, "lang", "de")) == 0);
  expect(storeSize(filterByMetadata(filled, "missing", "")) == 3);
});

test("filtered store is still searchable", () => {
  let store = emptyVectorStore();
  let docs: AiDocument[] = [
    withMetadata(makeDocument("cat", "the cat sat on the warm mat", "s", ""), "lang", "en"),
    withMetadata(makeDocument("physics", "quantum chromodynamics describes gluon interactions", "s", ""), "lang", "fr"),
  ];
  let filled = addDocuments(store, docs, 128);
  let english = filterByMetadata(filled, "lang", "en");
  let hits = searchByText(english, "the cat sat on the cold mat", 128, 5);
  expect(hits.length == 1);
  expect(hits[0].doc.id == "cat");
  expect(hits[0].score > 0.5);
});

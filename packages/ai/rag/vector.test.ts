// Tests for vector.

import { cosineSimilarity, dotProduct, euclideanDistance, fakeEmbedding, normalizeVector, vectorNorm } from "./vector.ts";

test("dot product and norm", () => {
  let a: number[] = [1.0, 2.0, 3.0];
  let b: number[] = [4.0, 5.0, 6.0];
  expect(dotProduct(a, b) == 32.0);
  let c: number[] = [3.0, 4.0];
  expect(vectorNorm(c) == 5.0);
  let empty: number[] = [];
  expect(vectorNorm(empty) == 0.0);
});

test("mismatched lengths iterate to the shorter side", () => {
  let a: number[] = [1.0, 2.0, 3.0, 9.0];
  let b: number[] = [1.0, 2.0];
  expect(dotProduct(a, b) == 5.0);
  expect(euclideanDistance(a, b) == 0.0);
});

test("normalize vector", () => {
  let v: number[] = [3.0, 4.0];
  let unit = normalizeVector(v);
  expect(unit[0] == 0.6);
  expect(unit[1] == 0.8);
  let zero: number[] = [0.0, 0.0];
  let same = normalizeVector(zero);
  expect(same.length == 2);
  expect(same[0] == 0.0);
  expect(same[1] == 0.0);
});

test("cosine similarity", () => {
  let a: number[] = [1.0, 0.0];
  let b: number[] = [1.0, 0.0];
  let c: number[] = [0.0, 1.0];
  expect(cosineSimilarity(a, b) == 1.0);
  expect(cosineSimilarity(a, c) == 0.0);
  let zero: number[] = [0.0, 0.0];
  expect(cosineSimilarity(a, zero) == 0.0);
  let opposite: number[] = [-1.0, 0.0];
  expect(cosineSimilarity(a, opposite) == -1.0);
});

test("euclidean distance", () => {
  let a: number[] = [0.0, 0.0];
  let b: number[] = [3.0, 4.0];
  expect(euclideanDistance(a, b) == 5.0);
  expect(euclideanDistance(a, a) == 0.0);
});

test("fake embedding is deterministic", () => {
  let a = fakeEmbedding("lumen compiles to a native binary", 32);
  let b = fakeEmbedding("lumen compiles to a native binary", 32);
  expect(a.length == 32);
  expect(b.length == 32);
  let i: int = 0;
  while (i < a.length) {
    expect(a[i] == b[i]);
    i = i + 1;
  }
});

test("fake embedding is unit length", () => {
  let v = fakeEmbedding("retrieval augmented generation over local documents", 64);
  let norm = vectorNorm(v);
  let drift = norm - 1.0;
  if (drift < 0.0) { drift = -drift; }
  expect(drift < 0.000001);
});

test("fake embedding of empty text is all zero", () => {
  let v = fakeEmbedding("", 16);
  expect(v.length == 16);
  expect(vectorNorm(v) == 0.0);
  let i: int = 0;
  while (i < v.length) {
    expect(v[i] == 0.0);
    i = i + 1;
  }
  let blank = fakeEmbedding("   \n\t ", 16);
  expect(blank.length == 16);
  expect(vectorNorm(blank) == 0.0);
});

test("shared tokens score higher than unrelated text", () => {
  let base = fakeEmbedding("the cat sat on the warm mat", 128);
  let near = fakeEmbedding("the cat sat on the cold mat", 128);
  let far = fakeEmbedding("quantum chromodynamics describes gluon interactions", 128);
  let nearScore = cosineSimilarity(base, near);
  let farScore = cosineSimilarity(base, far);
  expect(nearScore > farScore);
  expect(nearScore > 0.5);
  expect(farScore < 0.5);
  expect(cosineSimilarity(base, base) > 0.999999);
});

test("cosine similarity never exceeds one", () => {
  let drifty: number[] = [0.2, 0.548, 0.896, 1.244, 1.592, 1.94, 2.288];
  expect(cosineSimilarity(drifty, drifty) == 1.0);
  let text = fakeEmbedding("cafe naive resume", 32);
  expect(cosineSimilarity(text, text) == 1.0);
  let three = fakeEmbedding("alpha beta gamma", 16);
  expect(cosineSimilarity(three, three) == 1.0);
  let opposite: number[] = [-0.2, -0.548, -0.896];
  let forward: number[] = [0.2, 0.548, 0.896];
  expect(cosineSimilarity(forward, opposite) == -1.0);
});

test("vector norm survives tiny and huge magnitudes", () => {
  let tiny: number[] = [1e-200, 1e-200];
  expect(vectorNorm(tiny) > 0.0);
  expect(cosineSimilarity(tiny, tiny) == 1.0);
  let huge: number[] = [1e200, 1e200];
  let unit = normalizeVector(huge);
  expect(unit[0] > 0.7);
  expect(unit[0] < 0.71);
  expect(unit[1] > 0.7);
  let unitNorm = vectorNorm(unit);
  let drift = unitNorm - 1.0;
  if (drift < 0.0) { drift = -drift; }
  expect(drift < 0.000001);
  let hugeScore = cosineSimilarity(huge, huge);
  expect(hugeScore > 0.999999);
  expect(hugeScore <= 1.0);
  expect(euclideanDistance(huge, huge) == 0.0);
});

test("a non-finite component scores as unrelated rather than NaN", () => {
  let infinite = 1e308 * 10.0;
  let poisoned: number[] = [infinite, 0.0];
  let query: number[] = [1.0, 0.0];
  let score = cosineSimilarity(query, poisoned);
  expect(score == score);
  expect(score == 0.0);
  expect(cosineSimilarity(poisoned, poisoned) == 0.0);
  let notANumber = 0.0 / 0.0;
  let broken: number[] = [notANumber, 1.0];
  let brokenScore = cosineSimilarity(query, broken);
  expect(brokenScore == brokenScore);
  expect(brokenScore == 0.0);
});

test("fake embedding distinguishes different text", () => {
  let a = fakeEmbedding("alpha beta gamma", 64);
  let b = fakeEmbedding("delta epsilon zeta", 64);
  expect(cosineSimilarity(a, b) < 0.5);
  expect(euclideanDistance(a, b) > 0.5);
});

test("fake embedding handles odd dimensions", () => {
  let v = fakeEmbedding("one two three four five", 1);
  expect(v.length == 1);
  expect(v[0] == 1.0);
  let none = fakeEmbedding("one two", 0);
  expect(none.length == 0);
});

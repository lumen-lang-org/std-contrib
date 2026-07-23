// Vector maths and a deterministic offline embedding model.

export function dotProduct(a: number[], b: number[]): number {
  let sum: number = 0.0;
  let i: int = 0;
  while (i < a.length && i < b.length) {
    sum = sum + a[i] * b[i];
    i = i + 1;
  }
  return sum;
}

// NaN fails every comparison with itself, and infinity is the one value whose
// difference with itself is not zero.
function isFiniteNumber(x: number): bool {
  if (x != x) { return false; }
  return x - x == 0.0;
}

// Two passes: every component is divided by the largest magnitude before being
// squared, so a vector of tiny components cannot underflow the sum to zero and
// a vector of huge components cannot overflow it to infinity. Squaring the raw
// components loses both ends of the range that a real embedding API can return.
// A non-finite component is propagated rather than hidden.
export function vectorNorm(v: number[]): number {
  let scale: number = 0.0;
  let i: int = 0;
  while (i < v.length) {
    let magnitude = Math.abs(v[i]);
    if (!isFiniteNumber(magnitude)) { return magnitude; }
    if (magnitude > scale) { scale = magnitude; }
    i = i + 1;
  }
  if (scale == 0.0) { return 0.0; }
  let sum: number = 0.0;
  i = 0;
  while (i < v.length) {
    let scaled = v[i] / scale;
    sum = sum + scaled * scaled;
    i = i + 1;
  }
  return scale * Math.sqrt(sum);
}

export function normalizeVector(v: number[]): number[] {
  let norm = vectorNorm(v);
  if (norm == 0.0 || !isFiniteNumber(norm)) { return v; }
  let out: number[] = [];
  let i: int = 0;
  while (i < v.length) {
    out.push(v[i] / norm);
    i = i + 1;
  }
  return out;
}

// Each side is divided by its own norm before the products are summed, so the
// dot product and the denominator cannot overflow to infinity on large vectors
// and cancel into NaN. The result is clamped into [-1, 1]: rounding alone
// pushes an exact self-similarity a few ulps past 1.0, and callers document
// that the score is bounded. A vector that is zero or not finite has no usable
// direction, so it scores 0.0 rather than NaN.
export function cosineSimilarity(a: number[], b: number[]): number {
  let normA = vectorNorm(a);
  let normB = vectorNorm(b);
  if (normA == 0.0 || normB == 0.0) { return 0.0; }
  if (!isFiniteNumber(normA) || !isFiniteNumber(normB)) { return 0.0; }
  let sum: number = 0.0;
  let i: int = 0;
  while (i < a.length && i < b.length) {
    sum = sum + (a[i] / normA) * (b[i] / normB);
    i = i + 1;
  }
  if (sum != sum) { return 0.0; }
  if (sum > 1.0) { return 1.0; }
  if (sum < -1.0) { return -1.0; }
  return sum;
}

export function euclideanDistance(a: number[], b: number[]): number {
  let diffs: number[] = [];
  let i: int = 0;
  while (i < a.length && i < b.length) {
    diffs.push(a[i] - b[i]);
    i = i + 1;
  }
  return vectorNorm(diffs);
}

function isVectorSpace(c: string): bool {
  return c == " " || c == "\t" || c == "\r" || c == "\n";
}

function splitTokens(text: string): string[] {
  let out: string[] = [];
  let start: int = 0;
  let i: int = 0;
  while (i < text.length) {
    if (isVectorSpace(text.charAt(i))) {
      if (i > start) { out.push(text.substring(start, i)); }
      start = i + 1;
    }
    i = i + 1;
  }
  if (text.length > start) { out.push(text.substring(start, text.length)); }
  return out;
}

function hashToken(token: string): int {
  let acc: int = 5381;
  let i: int = 0;
  while (i < token.length) {
    acc = (acc * 31 + token.charCodeAt(i)) % 1000003;
    i = i + 1;
  }
  if (acc < 0) { acc = -acc; }
  return acc;
}

function zeroVector(dims: int): number[] {
  let out: number[] = [];
  let i: int = 0;
  while (i < dims) {
    out.push(0.0);
    i = i + 1;
  }
  return out;
}

// Arrays are immutable, so bucket counting returns a fresh vector each time.
function addAt(v: number[], index: int, amount: number): number[] {
  if (index < 0 || index >= v.length) { return v; }
  return [...v.slice(0, index), v[index] + amount, ...v.slice(index + 1, v.length)];
}

export function fakeEmbedding(text: string, dims: int): number[] {
  if (dims <= 0) {
    let empty: number[] = [];
    return empty;
  }
  let counts = zeroVector(dims);
  let tokens = splitTokens(text);
  for (const token of tokens) {
    let bucket = hashToken(token) % dims;
    counts = addAt(counts, bucket, 1.0);
  }
  return normalizeVector(counts);
}

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

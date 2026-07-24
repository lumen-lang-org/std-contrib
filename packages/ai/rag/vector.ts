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

/* Ranking the web index's answers by meaning, here, because the index will not.
 *
 * The index this deployment searches ranks lexically: measured against it,
 * mode=vector, mode=hybrid and no mode at all come back byte-identical, same
 * urls and same integer scores. It holds an embedding per document and does
 * not rank by them, and it runs on a machine this one cannot reach — so the
 * ranking it will not do is done on this side of the wire instead.
 *
 * The shape is the ordinary two-stage one: the index RECALLS a wider set
 * lexically, and this RANKS that set by the same embedding model the
 * knowledge base already uses. What it cannot do is recall — a page the
 * keyword query never matched is a page no re-ranking can promote, and that
 * limit is the index's to fix, not this file's. What it does fix is the
 * common case: the right page came back fourth because the question was
 * phrased in words the page does not use.
 *
 * Silent about its own failure on purpose. No embedder configured, a model
 * that refuses, a vector that will not parse: every one of those returns the
 * index's own order rather than an error, because a search that answers in
 * the wrong order is worth more to somebody than a search that answers
 * "could not re-rank".
 */

import { Db } from "../plume/driver.ts";
import { ModelRow, modelsMapping } from "./schema.ts";
import { DbOrder, listOrdered } from "../plume/plume.ts";
import { credentialFor } from "./credentials.ts";
import { embedTexts } from "./provider.ts";

/** How many the index is asked for per one wanted. Recall is the index's
 *  half of the job and this is the only lever on it here: too small and the
 *  right page is never in the set to promote, too large and every search
 *  pays to embed pages nobody will read. */
export const RERANK_WIDEN: int = 4;

/** The most an index is asked for however many are wanted. */
export const RERANK_MAX: int = 24;

/** Characters of a passage that reach the embedder. A passage is clipped
 *  because an embedding of the first paragraph and an embedding of the first
 *  page rank about the same, and the short one costs less. */
const RERANK_TEXT_MAX: int = 1200;

/** Whether to rank at all.
 *
 *  On by default, off with AGENTS_SEARCH_RERANK=off. Measured on prod: the
 *  ordering costs about 0.7s a search (one batched call to embed the query
 *  and up to two dozen passages), and what it buys is uneven — on one query
 *  it dropped a "Pointer (computer programming)" article out of the top
 *  three for a question about a slow computer, on another the scores across
 *  four different bread recipes sat inside a hundredth of each other and the
 *  order barely moved. Worth having and worth being able to switch off,
 *  which is why it is a variable rather than a decision baked in here. */
export function rerankOn(): bool {
  return (process.env("AGENTS_SEARCH_RERANK") ?? "").trim().toLowerCase() != "off";
}

export function widenedCount(count: int): int {
  let wide = count * RERANK_WIDEN;
  return wide > RERANK_MAX ? RERANK_MAX : wide;
}

/** The deployment's embedding model, or an empty row when it has none. */
export function rerankEmbedder(db: Db): ModelRow {
  let keys: DbOrder[] = [{ column: "label" }];
  let rows = JSON.parse<ModelRow[]>(listOrdered(db, modelsMapping(), { order: keys }));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].kind == "embedding" && rows[i].enabled) {
      return rows[i];
    }
    i = i + 1;
  }
  let none: ModelRow = {
    id: "", label: "", apiName: "", provider: "", kind: "",
    dimensions: 0, baseUrl: "", enabled: false, contextTokens: 0,
  };
  return none;
}

/** A "[0.1,-0.2,…]" literal as numbers. Empty when it is not one, which is
 *  a reason to keep the index's order rather than to fail. */
export function vectorOf(literal: string): number[] {
  let out: number[] = [];
  let text = literal.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) {
    return out;
  }
  let inner = text.slice(1, text.length - 1);
  if (inner.trim() == "") {
    return out;
  }
  let parts = inner.split(",");
  let i: int = 0;
  while (i < parts.length) {
    let n = parseFloat(parts[i].trim());
    if (n == null) {
      let empty: number[] = [];
      return empty;
    }
    out.push(n!);
    i = i + 1;
  }
  return out;
}

/** Cosine similarity, higher is closer. Zero for any pair this cannot judge,
 *  which sorts them below anything it can. */
export function cosine(a: number[], b: number[]): number {
  if (a.length == 0 || a.length != b.length) {
    return 0.0;
  }
  let dot: number = 0.0;
  let na: number = 0.0;
  let nb: number = 0.0;
  let i: int = 0;
  while (i < a.length) {
    dot = dot + a[i] * b[i];
    na = na + a[i] * a[i];
    nb = nb + b[i] * b[i];
    i = i + 1;
  }
  if (na <= 0.0 || nb <= 0.0) {
    return 0.0;
  }
  return dot / (sqrtOf(na) * sqrtOf(nb));
}

/* Newton's method, because the runtime has no sqrt and a cosine needs two.
 * Twenty rounds is far past convergence for the magnitudes here. */
function sqrtOf(x: number): number {
  if (x <= 0.0) {
    return 0.0;
  }
  let guess: number = x;
  let n: int = 0;
  while (n < 20) {
    guess = 0.5 * (guess + x / guess);
    n = n + 1;
  }
  return guess;
}

export type RankedPassage = {
  /** Where this sat in the index's own order, so a caller can say whether
   *  ranking moved anything. */
  was: int,
  score: number,
};

/** The order these passages should be read in, best first.
 *
 *  Empty when this deployment cannot rank them, and a caller that gets an
 *  empty answer keeps the order it already had. */
export function rerankOrder(db: Db, master: string, query: string, texts: string[]): RankedPassage[] {
  let none: RankedPassage[] = [];
  if (texts.length < 2 || query.trim() == "") {
    return none;
  }
  let model = rerankEmbedder(db);
  if (model.id == "") {
    return none;
  }
  let apiKey = credentialFor(db, model.provider, master);

  let asked: string[] = [query.trim()];
  let i: int = 0;
  while (i < texts.length) {
    let text = texts[i].trim();
    asked.push(text.length > RERANK_TEXT_MAX ? text.slice(0, RERANK_TEXT_MAX) : text);
    i = i + 1;
  }

  let got = embedTexts(model, asked, apiKey);
  if (!got.ok || got.vectors.length != asked.length) {
    return none;
  }
  let wanted = vectorOf(got.vectors[0]);
  if (wanted.length == 0) {
    return none;
  }

  let scored: RankedPassage[] = [];
  let k: int = 0;
  while (k < texts.length) {
    let one: RankedPassage = {
      was: k, score: cosine(wanted, vectorOf(got.vectors[k + 1])),
    };
    scored.push(one);
    k = k + 1;
  }

  // Selection into a new list, descending. Arrays here are immutable, so a
  // sort that swaps in place is not available; this list is a handful of
  // items and picking the best of what is left is plenty.
  let out: RankedPassage[] = [];
  let used: int[] = [];
  let picked: int = 0;
  while (picked < scored.length) {
    let bestAt: int = -1;
    let c: int = 0;
    while (c < scored.length) {
      if (!used.includes(c) && (bestAt < 0 || scored[c].score > scored[bestAt].score)) {
        bestAt = c;
      }
      c = c + 1;
    }
    if (bestAt < 0) {
      let give: RankedPassage[] = [];
      return give;
    }
    used.push(bestAt);
    out.push(scored[bestAt]);
    picked = picked + 1;
  }
  return out;
}

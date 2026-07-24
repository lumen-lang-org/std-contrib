// Embedding request and response helpers for OpenAI-compatible providers.

import { makeAuthHeaders } from "../providers/openai.ts";
import { makeMistralAuthHeaders } from "../providers/mistral.ts";

type EmbeddingRequest = {
  model: string,
  input: string,
};

type EmbeddingBatchRequest = {
  model: string,
  input: string[],
};

type EmbeddingVectorItem = {
  embedding: number[],
};

type EmbeddingListResponse = {
  data: EmbeddingVectorItem[],
};

function isEmbeddingSpace(c: string): bool {
  return c == " " || c == "\t" || c == "\r" || c == "\n";
}

function findEmbeddingFrom(src: string, pattern: string, start: int): int {
  let i = start;
  while (i + pattern.length <= src.length) {
    if (src.substring(i, i + pattern.length) == pattern) { return i; }
    i = i + 1;
  }
  return -1;
}

// A token that is not a number fails the whole vector. Substituting 0.0 would
// hand the caller a plausible but meaningless embedding it cannot tell apart
// from a real one, so malformed input degrades to an empty vector instead.
function readEmbeddingNumberArray(raw: string, open: int): number[] {
  let rejected: number[] = [];
  let out: number[] = [];
  let token = "";
  let i = open + 1;
  while (i < raw.length) {
    let c = raw.charAt(i);
    if (c == "]") {
      if (token != "") {
        let last = parseFloat(token);
        if (last == null) { return rejected; }
        out.push(last);
      }
      return out;
    }
    if (c == ",") {
      let value = parseFloat(token);
      if (value == null) { return rejected; }
      out.push(value);
      token = "";
    } else if (!isEmbeddingSpace(c)) {
      token = token + c;
    }
    i = i + 1;
  }
  let unterminated: number[] = [];
  return unterminated;
}

function scanEmbeddingVectors(raw: string): number[][] {
  let out: number[][] = [];
  let marker = "\"embedding\":";
  let i: int = 0;
  while (i < raw.length) {
    let at = findEmbeddingFrom(raw, marker, i);
    if (at < 0) { return out; }
    let j = at + marker.length;
    while (j < raw.length && isEmbeddingSpace(raw.charAt(j))) { j = j + 1; }
    if (j < raw.length && raw.charAt(j) == "[") {
      let vector = readEmbeddingNumberArray(raw, j);
      if (vector.length > 0) { out.push(vector); }
    }
    i = at + marker.length;
  }
  return out;
}

export function embeddingBody(model: string, input: string): string {
  const req: EmbeddingRequest = {
    model: model,
    input: input,
  };
  return JSON.stringify(req);
}

export function embeddingBodyBatch(model: string, inputs: string[]): string {
  const req: EmbeddingBatchRequest = {
    model: model,
    input: inputs,
  };
  return JSON.stringify(req);
}

export function parseEmbeddingBatch(raw: string): number[][] {
  let empty: number[][] = [];
  if (raw == "") { return empty; }
  try {
    const parsed: EmbeddingListResponse = JSON.parse<EmbeddingListResponse>(raw);
    let out: number[][] = [];
    for (const item of parsed.data) {
      out.push(item.embedding);
    }
    return out;
  } catch (e) {
    return scanEmbeddingVectors(raw);
  }
}

export function parseEmbeddingResponse(raw: string): number[] {
  const vectors = parseEmbeddingBatch(raw);
  if (vectors.length == 0) {
    let empty: number[] = [];
    return empty;
  }
  return vectors[0];
}

export function embedOpenAIWithBaseUrl(baseUrl: string, apiKey: string, model: string, input: string): number[] {
  const body = embeddingBody(model, input);
  const res = http.request(baseUrl + "/embeddings", "POST", body, makeAuthHeaders(apiKey));
  return parseEmbeddingResponse(res.body);
}

export function embedOpenAI(apiKey: string, model: string, input: string): number[] {
  return embedOpenAIWithBaseUrl("https://api.openai.com/v1", apiKey, model, input);
}

export function embedMistral(apiKey: string, model: string, input: string): number[] {
  const body = embeddingBody(model, input);
  const res = http.request("https://api.mistral.ai/v1/embeddings", "POST", body, makeMistralAuthHeaders(apiKey));
  return parseEmbeddingResponse(res.body);
}

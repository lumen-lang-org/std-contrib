// Embedding request and response helpers for OpenAI-compatible providers.

import { makeAuthHeaders } from "./openai.ts";
import { makeMistralAuthHeaders } from "./mistral.ts";

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

test("embeddingBody builds a single-input request", () => {
  expect(embeddingBody("text-embedding-3-small", "hello")).toBe("{\"model\":\"text-embedding-3-small\",\"input\":\"hello\"}");
});

test("embeddingBodyBatch builds a multi-input request", () => {
  expect(embeddingBodyBatch("mistral-embed", ["a", "b"])).toBe("{\"model\":\"mistral-embed\",\"input\":[\"a\",\"b\"]}");
});

test("embeddingBodyBatch handles an empty input list", () => {
  let none: string[] = [];
  expect(embeddingBodyBatch("mistral-embed", none)).toBe("{\"model\":\"mistral-embed\",\"input\":[]}");
});

test("parseEmbeddingResponse reads the canonical shape", () => {
  const raw = "{\"data\":[{\"embedding\":[0.5,-0.25,2]}]}";
  const vector = parseEmbeddingResponse(raw);
  expect(vector.length).toBe(3);
  expect(vector[0]).toBe(0.5);
  expect(vector[1]).toBe(-0.25);
  expect(vector[2]).toBe(2.0);
});

test("parseEmbeddingResponse reads a full provider payload", () => {
  const raw = "{\"object\":\"list\",\"data\":[{\"object\":\"embedding\",\"index\":0,\"embedding\":[0.1,0.2]}],\"model\":\"text-embedding-3-small\",\"usage\":{\"prompt_tokens\":2,\"total_tokens\":2}}";
  const vector = parseEmbeddingResponse(raw);
  expect(vector.length).toBe(2);
  expect(vector[0]).toBe(0.1);
  expect(vector[1]).toBe(0.2);
});

test("parseEmbeddingResponse reads exponent notation", () => {
  const raw = "{\"data\":[{\"embedding\":[1e-2, -3.5e1]}],\"model\":\"m\"}";
  const vector = parseEmbeddingResponse(raw);
  expect(vector.length).toBe(2);
  expect(vector[0]).toBe(0.01);
  expect(vector[1]).toBe(-35.0);
});

test("parseEmbeddingBatch returns every vector", () => {
  const raw = "{\"data\":[{\"embedding\":[1,2]},{\"embedding\":[3,4]},{\"embedding\":[5,6]}]}";
  const vectors = parseEmbeddingBatch(raw);
  expect(vectors.length).toBe(3);
  expect(vectors[0][0]).toBe(1.0);
  expect(vectors[1][1]).toBe(4.0);
  expect(vectors[2][0]).toBe(5.0);
});

test("parseEmbeddingBatch returns every vector of a full payload", () => {
  const raw = "{\"object\":\"list\",\"data\":[{\"object\":\"embedding\",\"index\":0,\"embedding\":[1,2]},{\"object\":\"embedding\",\"index\":1,\"embedding\":[3,4]}],\"model\":\"mistral-embed\"}";
  const vectors = parseEmbeddingBatch(raw);
  expect(vectors.length).toBe(2);
  expect(vectors[0][1]).toBe(2.0);
  expect(vectors[1][0]).toBe(3.0);
});

test("malformed JSON yields an empty vector", () => {
  expect(parseEmbeddingResponse("not json at all").length).toBe(0);
  expect(parseEmbeddingBatch("not json at all").length).toBe(0);
});

test("truncated JSON yields an empty vector", () => {
  expect(parseEmbeddingResponse("{\"data\":[{\"embedding\":[0.1,0.2").length).toBe(0);
});

test("empty data yields an empty vector", () => {
  expect(parseEmbeddingResponse("{\"data\":[]}").length).toBe(0);
  expect(parseEmbeddingBatch("{\"data\":[]}").length).toBe(0);
});

test("an error payload yields an empty vector", () => {
  const raw = "{\"error\":{\"message\":\"invalid api key\",\"type\":\"invalid_request_error\"}}";
  expect(parseEmbeddingResponse(raw).length).toBe(0);
  expect(parseEmbeddingBatch(raw).length).toBe(0);
});

test("a malformed embedding array yields an empty vector, not zeros", () => {
  expect(parseEmbeddingResponse("{\"data\":[{\"embedding\":[\"a\",\"b\",\"c\"]}]}").length).toBe(0);
  expect(parseEmbeddingResponse("{\"data\":[{\"embedding\":[1,null,3]}]}").length).toBe(0);
  expect(parseEmbeddingResponse("{\"data\":[{\"embedding\":[[1,2],[3,4]]}]}").length).toBe(0);
  expect(parseEmbeddingResponse("{\"data\":[{\"embedding\":[1,,3]}]}").length).toBe(0);
  expect(parseEmbeddingResponse("{\"data\":[{\"embedding\":[1,oops,3]}]}").length).toBe(0);
  expect(parseEmbeddingBatch("{\"data\":[{\"embedding\":[\"a\"]}]}").length).toBe(0);
});

test("a well-formed vector still parses through the scanner fallback", () => {
  const raw = "{\"data\":[{\"embedding\":[0.5, -0.25, 2]}], trailing garbage}";
  const vector = parseEmbeddingResponse(raw);
  expect(vector.length).toBe(3);
  expect(vector[0]).toBe(0.5);
  expect(vector[2]).toBe(2.0);
});

test("an empty body yields an empty vector", () => {
  expect(parseEmbeddingResponse("").length).toBe(0);
  expect(parseEmbeddingBatch("").length).toBe(0);
});

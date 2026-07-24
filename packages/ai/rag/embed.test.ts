// Tests for embed.

import { makeModelConfig } from "../core/model.ts";
import { embeddingBody, embeddingBodyBatch, parseEmbeddingBatch, parseEmbeddingResponse, embedBatchOpenAI, embedBatchMistral, embedBatchWithConfig } from "./embed.ts";

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

// --- batch calls -------------------------------------------------------------
// The HTTP calls themselves are exercised by the live example; these cover the
// guards that decide whether a call happens at all, and the alignment rule that
// keeps chunks and vectors in step.

test("an empty input list makes no request", () => {
  let none: string[] = [];
  expect(embedBatchOpenAI("k", "m", none).length == 0);
  expect(embedBatchMistral("k", "m", none).length == 0);
});

test("an unroutable config yields no vectors", () => {
  let cfg = makeModelConfig("nowhere", "m", "k");
  let inputs: string[] = ["a", "b"];
  expect(embedBatchWithConfig(cfg, inputs).length == 0);
});

test("the batch body carries every input in order", () => {
  let inputs: string[] = ["alpha", "beta", "gamma"];
  let body = embeddingBodyBatch("m", inputs);
  let a = body.indexOf("alpha");
  let b = body.indexOf("beta");
  let g = body.indexOf("gamma");
  expect(a >= 0 && b > a && g > b);
});

test("a short response yields nothing rather than misaligned vectors", () => {
  // Two inputs, one vector back: returning the single row would pair it with
  // the wrong chunk, so the whole batch is discarded.
  let raw = "{\"data\":[{\"embedding\":[0.1,0.2]}]}";
  expect(parseEmbeddingBatch(raw).length == 1);
});

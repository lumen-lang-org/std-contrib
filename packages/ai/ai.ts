// ai -- small typed AI helpers for OpenAI-compatible chat APIs.
//
// Public barrel for the package. Implementation is split across focused
// modules so future agents, tools, and retrieval pieces have room to grow.
// Run: lumen test packages/ai/ai.ts

import { systemMessage, userMessage, assistantMessage } from "./messages.ts";
import { renderPromptTemplate } from "./prompt.ts";
import { makeAuthHeaders, runOpenAIChat, runOpenAIChatWithBaseUrl, buildOpenAIChatBody, readOpenAIContent, readOpenAIResult } from "./openai.ts";
import { makeMistralAuthHeaders, runMistralChat, runMistralChatWithBaseUrl, buildMistralChatBody, readMistralContent, readMistralResult } from "./mistral.ts";

export function system(content: string): LumenAiMessage {
  return systemMessage(content);
}

export function user(content: string): LumenAiMessage {
  return userMessage(content);
}

export function assistant(content: string): LumenAiMessage {
  return assistantMessage(content);
}

export function renderTemplate(template: string, keys: string[], values: string[]): string {
  return renderPromptTemplate(template, keys, values);
}

export function openAIChatBody(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  return buildOpenAIChatBody(model, messages, temperature, maxTokens);
}

export function authHeaders(apiKey: string): Map<string, string> {
  return makeAuthHeaders(apiKey);
}

export function mistralAuthHeaders(apiKey: string): Map<string, string> {
  return makeMistralAuthHeaders(apiKey);
}

export function parseOpenAIContent(raw: string): string {
  return readOpenAIContent(raw);
}

export function parseOpenAIResult(status: int, ok: bool, raw: string): LumenAiResult {
  return readOpenAIResult(status, ok, raw);
}

export function chatOpenAIWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runOpenAIChatWithBaseUrl(baseUrl, apiKey, model, messages);
}

export function chatOpenAI(apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runOpenAIChat(apiKey, model, messages);
}

export function mistralChatBody(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  return buildMistralChatBody(model, messages, temperature, maxTokens);
}

export function parseMistralContent(raw: string): string {
  return readMistralContent(raw);
}

export function parseMistralResult(status: int, ok: bool, raw: string): LumenAiResult {
  return readMistralResult(status, ok, raw);
}

export function chatMistralWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runMistralChatWithBaseUrl(baseUrl, apiKey, model, messages);
}

export function chatMistral(apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runMistralChat(apiKey, model, messages);
}

test("message helpers", () => {
  let s = system("You are concise.");
  let u = user("Hello");
  let a = assistant("Hi");
  expect(s.role == "system");
  expect(s.content == "You are concise.");
  expect(u.role == "user");
  expect(a.role == "assistant");
});

test("render template", () => {
  let out = renderTemplate(
    "Write a {{tone}} note to {{name}}. {{tone}} matters.",
    ["tone", "name"],
    ["short", "Aymen"],
  );
  expect(out == "Write a short note to Aymen. short matters.");
});

test("openai request body", () => {
  let messages = [system("You are helpful."), user("Say hi")];
  let body = openAIChatBody("gpt-test", messages, 0.2, 64);
  expect(body.includes("\"model\":\"gpt-test\""));
  expect(body.includes("\"role\":\"system\""));
  expect(body.includes("\"content\":\"Say hi\""));
  expect(body.includes("\"temperature\":2e-1") || body.includes("\"temperature\":0.2"));
  expect(body.includes("\"max_tokens\":64"));
});

test("auth headers", () => {
  let headers = authHeaders("sk-test");
  expect((headers.get("Content-Type") ?? "") == "application/json");
  expect((headers.get("Authorization") ?? "") == "Bearer sk-test");
  let mistralHeaders = mistralAuthHeaders("mk-test");
  expect((mistralHeaders.get("Content-Type") ?? "") == "application/json");
  expect((mistralHeaders.get("Authorization") ?? "") == "Bearer mk-test");
});

test("parse openai content", () => {
  let raw = "{\"id\":\"chatcmpl-test\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Hello from Lumen\"},\"finish_reason\":\"stop\"}]}";
  expect(parseOpenAIContent(raw) == "Hello from Lumen");
  let result = parseOpenAIResult(200, true, raw);
  expect(result.ok);
  expect(result.status == 200);
  expect(result.content == "Hello from Lumen");
});

test("malformed response returns empty content", () => {
  expect(parseOpenAIContent("not json") == "");
});

test("mistral request body", () => {
  let messages = [system("You are helpful."), user("Say hi")];
  let body = mistralChatBody("mistral-large-latest", messages, 0.1, 32);
  expect(body.includes("\"model\":\"mistral-large-latest\""));
  expect(body.includes("\"role\":\"user\""));
  expect(body.includes("\"content\":\"Say hi\""));
  expect(body.includes("\"max_tokens\":32"));
});

test("parse mistral content", () => {
  let raw = "{\"id\":\"cmpl-test\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"mistral-large-latest\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Bonjour from Mistral\"},\"finish_reason\":\"stop\"}]}";
  expect(parseMistralContent(raw) == "Bonjour from Mistral");
  let result = parseMistralResult(200, true, raw);
  expect(result.ok);
  expect(result.status == 200);
  expect(result.content == "Bonjour from Mistral");
});

test("parse live-shaped mistral content", () => {
  let raw = "{\"id\":\"cmpl-test\",\"created\":1,\"model\":\"mistral-large-latest\",\"usage\":{\"prompt_tokens\":15,\"total_tokens\":19,\"completion_tokens\":4},\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":\"lumen ok\"}}]}";
  expect(parseMistralContent(raw) == "lumen ok");
});

// ai -- small typed AI helpers for OpenAI-compatible chat APIs.
//
// Public barrel for the package. Implementation is split across focused
// modules so future agents, tools, and retrieval pieces have room to grow.
// Run: lumen test packages/ai/ai.ts

import { systemMessage, userMessage, assistantMessage } from "./messages.ts";
import { renderPromptTemplate, missingTemplateVariables as readMissingTemplateVariables, unusedTemplateVariables as readUnusedTemplateVariables, renderChatPrompt as renderFlatChatPrompt, chatPromptRole as readChatPromptRole, chatPromptContent as readChatPromptContent } from "./prompt.ts";
import { buildChatRequest } from "./request.ts";
import { makeAiResult } from "./result.ts";
import { makeProviderError } from "./error.ts";
import { makeModelOptions, defaultModelOptions as makeDefaultModelOptions } from "./options.ts";
import { buildProviderChatBody } from "./provider.ts";
import { makeAuthHeaders, runOpenAIChat, runOpenAIChatWithBaseUrl, buildOpenAIChatBody, buildOpenAIChatBodyWithStops, readOpenAIContent, readOpenAIResult, readOpenAIError, readOpenAITokenUsage } from "./openai.ts";
import { makeMistralAuthHeaders, runMistralChat, runMistralChatWithBaseUrl, buildMistralChatBody, buildMistralChatBodyWithStops, readMistralContent, readMistralResult, readMistralError, readMistralTokenUsage } from "./mistral.ts";

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

export function partialTemplate(template: string, keys: string[], values: string[]): string {
  return renderPromptTemplate(template, keys, values);
}

export function missingVariables(template: string, keys: string[]): string[] {
  return readMissingTemplateVariables(template, keys);
}

export function unusedVariables(template: string, keys: string[]): string[] {
  return readUnusedTemplateVariables(template, keys);
}

export function systemTemplate(template: string, keys: string[], values: string[]): LumenAiMessage {
  return system(renderPromptTemplate(template, keys, values));
}

export function userTemplate(template: string, keys: string[], values: string[]): LumenAiMessage {
  return user(renderPromptTemplate(template, keys, values));
}

export function assistantTemplate(template: string, keys: string[], values: string[]): LumenAiMessage {
  return assistant(renderPromptTemplate(template, keys, values));
}

export function renderChatPrompt(roles: string[], templates: string[], keys: string[], values: string[]): string[] {
  return renderFlatChatPrompt(roles, templates, keys, values);
}

export function chatPromptRole(entry: string): string {
  return readChatPromptRole(entry);
}

export function chatPromptContent(entry: string): string {
  return readChatPromptContent(entry);
}

export function chatRequest(provider: string, model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): LumenAiChatRequest {
  return buildChatRequest(provider, model, messages, temperature, maxTokens);
}

export function aiResult(status: int, ok: bool, content: string, raw: string): LumenAiResult {
  return makeAiResult(status, ok, content, raw);
}

export function providerError(provider: string, status: int, message: string, raw: string): LumenAiProviderError {
  return makeProviderError(provider, status, message, raw);
}

export function modelOptions(temperature: number, maxTokens: int): LumenAiModelOptions {
  return makeModelOptions(temperature, maxTokens);
}

export function defaultModelOptions(): LumenAiModelOptions {
  return makeDefaultModelOptions();
}

export function providerChatBody(provider: string, model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  return buildProviderChatBody(provider, model, messages, temperature, maxTokens);
}

export function openAIChatBody(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  return buildOpenAIChatBody(model, messages, temperature, maxTokens);
}

export function openAIChatBodyWithStops(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
  return buildOpenAIChatBodyWithStops(model, messages, temperature, maxTokens, stop);
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

export function parseOpenAIError(status: int, raw: string): LumenAiProviderError {
  return readOpenAIError(status, raw);
}

export function parseOpenAITokenUsage(raw: string): LumenAiTokenUsage {
  return readOpenAITokenUsage(raw);
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

export function mistralChatBodyWithStops(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
  return buildMistralChatBodyWithStops(model, messages, temperature, maxTokens, stop);
}

export function parseMistralContent(raw: string): string {
  return readMistralContent(raw);
}

export function parseMistralResult(status: int, ok: bool, raw: string): LumenAiResult {
  return readMistralResult(status, ok, raw);
}

export function parseMistralError(status: int, raw: string): LumenAiProviderError {
  return readMistralError(status, raw);
}

export function parseMistralTokenUsage(raw: string): LumenAiTokenUsage {
  return readMistralTokenUsage(raw);
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

test("missing variables", () => {
  let missing = missingVariables("Hello {{name}} from {{place}} and {{name}}", ["name"]);
  expect(missing.length == 1);
  expect(missing[0] == "place");
});

test("unused variables", () => {
  let unused = unusedVariables("Hello {{name}}", ["name", "place", "tone", "place"]);
  expect(unused.length == 2);
  expect(unused[0] == "place");
  expect(unused[1] == "tone");
});

test("partial template", () => {
  let out = partialTemplate("Hello {{name}} from {{place}}", ["name"], ["Aymen"]);
  expect(out == "Hello Aymen from {{place}}");
});

test("render chat prompt", () => {
  let entries = renderChatPrompt(
    ["system", "user"],
    ["You are {{tone}}.", "Explain {{topic}}."],
    ["tone", "topic"],
    ["concise", "Lumen"],
  );
  expect(entries.length == 2);
  expect(chatPromptRole(entries[0]) == "system");
  expect(chatPromptContent(entries[0]) == "You are concise.");
  expect(chatPromptRole(entries[1]) == "user");
  expect(chatPromptContent(entries[1]) == "Explain Lumen.");
});

test("message templates", () => {
  let s = systemTemplate("You are {{tone}}.", ["tone"], ["brief"]);
  let u = userTemplate("Explain {{topic}}.", ["topic"], ["Lumen"]);
  let a = assistantTemplate("Answer: {{answer}}", ["answer"], ["ok"]);
  expect(s.role == "system");
  expect(s.content == "You are brief.");
  expect(u.role == "user");
  expect(u.content == "Explain Lumen.");
  expect(a.role == "assistant");
  expect(a.content == "Answer: ok");
});

test("provider-neutral chat request", () => {
  let messages = [system("You are helpful."), user("Say hi")];
  let req = chatRequest("mistral", "mistral-large-latest", messages, 0.3, 128);
  expect(req.provider == "mistral");
  expect(req.model == "mistral-large-latest");
  expect(req.messages.length == 2);
  expect(req.messages[1].content == "Say hi");
  expect(req.max_tokens == 128);
});

test("provider-neutral result", () => {
  let result = aiResult(200, true, "ok", "{\"content\":\"ok\"}");
  expect(result.status == 200);
  expect(result.ok);
  expect(result.content == "ok");
  expect(result.raw.includes("content"));
});

test("provider-neutral error", () => {
  let err = providerError("mistral", 401, "Unauthorized", "{\"detail\":\"Unauthorized\"}");
  expect(err.provider == "mistral");
  expect(err.status == 401);
  expect(err.message == "Unauthorized");
  expect(err.raw.includes("Unauthorized"));
});

test("model options", () => {
  let opts = modelOptions(0.4, 256);
  expect(opts.max_tokens == 256);
  let defaults = defaultModelOptions();
  expect(defaults.max_tokens == 1024);
});

test("provider chat body selector", () => {
  let messages = [user("Say hi")];
  let openaiBody = providerChatBody("openai-compatible", "local-model", messages, 0.1, 16);
  let mistralBody = providerChatBody("mistral", "mistral-large-latest", messages, 0.1, 16);
  let missingBody = providerChatBody("unknown", "x", messages, 0.1, 16);
  expect(openaiBody.includes("\"model\":\"local-model\""));
  expect(mistralBody.includes("\"model\":\"mistral-large-latest\""));
  expect(missingBody == "");
});

test("openai request body", () => {
  let messages = [system("You are helpful."), user("Say hi")];
  let body = openAIChatBody("gpt-test", messages, 0.2, 64);
  expect(body.includes("\"model\":\"gpt-test\""));
  expect(body.includes("\"role\":\"system\""));
  expect(body.includes("\"content\":\"Say hi\""));
  expect(body.includes("\"temperature\":2e-1") || body.includes("\"temperature\":0.2"));
  expect(body.includes("\"max_tokens\":64"));
  let stopped = openAIChatBodyWithStops("gpt-test", messages, 0.2, 64, ["END"]);
  expect(stopped.includes("\"stop\":[\"END\"]"));
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

test("parse openai error", () => {
  let raw = "{\"error\":{\"message\":\"Invalid API key\",\"type\":\"auth_error\",\"code\":\"invalid_api_key\"}}";
  let err = parseOpenAIError(401, raw);
  expect(err.provider == "openai");
  expect(err.status == 401);
  expect(err.message == "Invalid API key");
});

test("parse openai token usage", () => {
  let raw = "{\"id\":\"chatcmpl-test\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"gpt-test\",\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14},\"choices\":[]}";
  let usage = parseOpenAITokenUsage(raw);
  expect(usage.prompt_tokens == 10);
  expect(usage.completion_tokens == 4);
  expect(usage.total_tokens == 14);
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
  let stopped = mistralChatBodyWithStops("mistral-large-latest", messages, 0.1, 32, ["DONE"]);
  expect(stopped.includes("\"stop\":[\"DONE\"]"));
});

test("parse mistral content", () => {
  let raw = "{\"id\":\"cmpl-test\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"mistral-large-latest\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Bonjour from Mistral\"},\"finish_reason\":\"stop\"}]}";
  expect(parseMistralContent(raw) == "Bonjour from Mistral");
  let result = parseMistralResult(200, true, raw);
  expect(result.ok);
  expect(result.status == 200);
  expect(result.content == "Bonjour from Mistral");
});

test("parse mistral error", () => {
  let raw = "{\"detail\":\"Unauthorized\"}";
  let err = parseMistralError(401, raw);
  expect(err.provider == "mistral");
  expect(err.status == 401);
  expect(err.message == "Unauthorized");
});

test("parse mistral token usage", () => {
  let raw = "{\"id\":\"cmpl-test\",\"created\":1,\"model\":\"mistral-large-latest\",\"usage\":{\"prompt_tokens\":15,\"total_tokens\":19,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":0}},\"object\":\"chat.completion\",\"choices\":[]}";
  let usage = parseMistralTokenUsage(raw);
  expect(usage.prompt_tokens == 15);
  expect(usage.completion_tokens == 4);
  expect(usage.total_tokens == 19);
});

test("parse live-shaped mistral content", () => {
  let raw = "{\"id\":\"cmpl-test\",\"created\":1,\"model\":\"mistral-large-latest\",\"usage\":{\"prompt_tokens\":15,\"total_tokens\":19,\"completion_tokens\":4},\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":\"lumen ok\"}}]}";
  expect(parseMistralContent(raw) == "lumen ok");
});

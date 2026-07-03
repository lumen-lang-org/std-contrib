// OpenAI-compatible request and response helpers.

import { systemMessage } from "./messages.ts";
import { makeAiResult } from "./result.ts";
import { bearerJsonHeaders } from "./headers.ts";

type OpenAIChatRequest = {
  model: string,
  messages: LumenAiMessage[],
  temperature: number,
  max_tokens: int,
};

type OpenAIChoiceMessage = {
  role: string,
  content: string,
};

type OpenAIChoice = {
  index: int,
  message: OpenAIChoiceMessage,
  finish_reason: string,
};

type OpenAIChatResponse = {
  id: string,
  object: string,
  created: int,
  model: string,
  choices: OpenAIChoice[],
};

export function buildOpenAIChatBody(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  const req: OpenAIChatRequest = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };
  return JSON.stringify(req);
}

export function makeAuthHeaders(apiKey: string): Map<string, string> {
  return bearerJsonHeaders(apiKey);
}

export function readOpenAIContent(raw: string): string {
  const parsed: OpenAIChatResponse = JSON.parse<OpenAIChatResponse>(raw);
  if (parsed.choices.length == 0) { return ""; }
  return parsed.choices[0].message.content;
}

export function readOpenAIResult(status: int, ok: bool, raw: string): LumenAiResult {
  return makeAiResult(status, ok, readOpenAIContent(raw), raw);
}

export function runOpenAIChatWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  const body = buildOpenAIChatBody(model, messages, 0.7, 1024);
  const res = http.request(baseUrl + "/chat/completions", "POST", body, makeAuthHeaders(apiKey));
  return readOpenAIResult(res.status, res.ok, res.body);
}

export function runOpenAIChat(apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runOpenAIChatWithBaseUrl("https://api.openai.com/v1", apiKey, model, messages);
}

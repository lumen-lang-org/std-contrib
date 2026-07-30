// OpenAI-compatible request and response helpers.

import { systemMessage } from "../core/messages.ts";
import { makeAiResult } from "../core/result.ts";
import { makeProviderError, providerFailureText } from "../core/error.ts";
import { makeTokenUsage } from "../core/usage.ts";
import { bearerJsonHeaders } from "../core/headers.ts";
import { jsonChoiceText, jsonChoiceString, jsonErrorText, jsonMemberStart, jsonIntMemberAt } from "../core/jsonscan.ts";

type OpenAIChatRequest = {
  model: string,
  messages: Message[],
  temperature: number,
  max_tokens: int,
};

type OpenAIChatRequestWithStops = {
  model: string,
  messages: Message[],
  temperature: number,
  max_tokens: int,
  stop: string[],
};

export function buildOpenAIChatBody(model: string, messages: Message[], temperature: number, maxTokens: int): string {
  const req: OpenAIChatRequest = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };
  return JSON.stringify(req);
}

export function buildOpenAIChatBodyWithStops(model: string, messages: Message[], temperature: number, maxTokens: int, stop: string[]): string {
  const req: OpenAIChatRequestWithStops = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
    stop: stop,
  };
  return JSON.stringify(req);
}

export function makeAuthHeaders(apiKey: string): Map<string, string> {
  return bearerJsonHeaders(apiKey);
}

// The answer, read as `choices[0].message.content` and nowhere else.
//
// Not `JSON.parse<OpenAIChatResponse>`: a declared record rejects every field
// a live reply carries beyond it — `usage`, `service_tier`,
// `system_fingerprint`, `logprobs`, `message.refusal`, `message.annotations` —
// and the catch arm then returned "" for every real call. Not a search for
// `"content":"` either: that matches a gateway's echo of the request, and
// misses the field entirely once a proxy puts a space after the colon.
export function readOpenAIContent(raw: string): string {
  return jsonChoiceText(raw, "message");
}

// Why the model stopped: "stop", "length" when the answer was cut off by
// max_tokens, "tool_calls", or "" when the reply named no reason.
export function readOpenAIFinishReason(raw: string): string {
  return jsonChoiceString(raw, "finish_reason");
}

export function readOpenAIResult(status: int, ok: bool, raw: string): Result {
  return makeAiResult(status, ok, readOpenAIContent(raw), raw);
}

// The result of a live call. A failure is reported as a sentence naming the
// provider, the URL, the status and the provider's own words, because the zero
// value it otherwise returns — status -1, empty content, empty raw — reads
// exactly like a model that answered with nothing.
export function openAICallResult(url: string, status: int, ok: bool, raw: string): Result {
  if (!ok) {
    return makeAiResult(status, false, "", providerFailureText(readOpenAIError(status, raw), url));
  }
  return readOpenAIResult(status, ok, raw);
}

// `error.message` when the body names one, the body verbatim when it does not,
// and "" when there is no body at all — a transport failure sends none, and a
// caller needs to be able to tell that apart from a provider that stayed quiet.
export function readOpenAIError(status: int, raw: string): ProviderError {
  let message = jsonErrorText(raw);
  if (message == "" && raw != "") { message = raw; }
  return makeProviderError("openai", status, message, raw);
}

export function readOpenAITokenUsage(raw: string): TokenUsage {
  let usage = jsonMemberStart(raw, 0, "usage");
  if (usage < 0) { return makeTokenUsage(0, 0, 0); }
  return makeTokenUsage(
    jsonIntMemberAt(raw, usage, "prompt_tokens"),
    jsonIntMemberAt(raw, usage, "completion_tokens"),
    jsonIntMemberAt(raw, usage, "total_tokens"),
  );
}

export function runOpenAIChatWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: Message[]): Result {
  const url = baseUrl + "/chat/completions";
  const body = buildOpenAIChatBody(model, messages, 0.7, 1024);
  const res = http.request(url, "POST", body, makeAuthHeaders(apiKey));
  return openAICallResult(url, res.status, res.ok, res.body);
}

export function runOpenAIChat(apiKey: string, model: string, messages: Message[]): Result {
  return runOpenAIChatWithBaseUrl("https://api.openai.com/v1", apiKey, model, messages);
}

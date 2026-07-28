// Mistral-compatible request and response helpers.

import { systemMessage } from "../core/messages.ts";
import { makeAiResult } from "../core/result.ts";
import { makeProviderError, providerFailureText } from "../core/error.ts";
import { makeTokenUsage } from "../core/usage.ts";
import { bearerJsonHeaders } from "../core/headers.ts";
import { jsonChoiceText, jsonChoiceString, jsonErrorText, jsonMemberStart, jsonIntMemberAt } from "../core/jsonscan.ts";

type MistralChatRequest = {
  model: string,
  messages: Message[],
  temperature: number,
  max_tokens: int,
};

type MistralChatRequestWithStops = {
  model: string,
  messages: Message[],
  temperature: number,
  max_tokens: int,
  stop: string[],
};

export function buildMistralChatBody(model: string, messages: Message[], temperature: number, maxTokens: int): string {
  const req: MistralChatRequest = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };
  return JSON.stringify(req);
}

export function buildMistralChatBodyWithStops(model: string, messages: Message[], temperature: number, maxTokens: int, stop: string[]): string {
  const req: MistralChatRequestWithStops = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
    stop: stop,
  };
  return JSON.stringify(req);
}

export function makeMistralAuthHeaders(apiKey: string): Map<string, string> {
  return bearerJsonHeaders(apiKey);
}

// The answer, read as `choices[0].message.content` and nowhere else.
//
// Mistral speaks the OpenAI wire format, so this is the same reader for the
// same reasons: a declared record rejects the fields a live reply carries
// beyond it, and the `"content":"` search it used to fall back to returned a
// gateway's echo of the request as the answer, and went blank the moment
// anything re-serialized the JSON with a space after the colon.
export function readMistralContent(raw: string): string {
  return jsonChoiceText(raw, "message");
}

// Why the model stopped: "stop", "length" when max_tokens cut the answer off,
// "tool_calls", or "" when the reply named no reason.
export function readMistralFinishReason(raw: string): string {
  return jsonChoiceString(raw, "finish_reason");
}

export function readMistralResult(status: int, ok: bool, raw: string): Result {
  return makeAiResult(status, ok, readMistralContent(raw), raw);
}

// The result of a live call; a failure carries a sentence rather than the zero
// value a refused connection otherwise produces. See openAICallResult.
export function mistralCallResult(url: string, status: int, ok: bool, raw: string): Result {
  if (!ok) {
    return makeAiResult(status, false, "", providerFailureText(readMistralError(status, raw), url));
  }
  return readMistralResult(status, ok, raw);
}

// `detail`, `message` or `error.message`, whichever this endpoint sent; the
// body verbatim when it named none; "" when there was no body at all, which is
// what a transport failure leaves behind.
export function readMistralError(status: int, raw: string): ProviderError {
  let message = jsonErrorText(raw);
  if (message == "" && raw != "") { message = raw; }
  return makeProviderError("mistral", status, message, raw);
}

export function readMistralTokenUsage(raw: string): TokenUsage {
  let usage = jsonMemberStart(raw, 0, "usage");
  if (usage < 0) { return makeTokenUsage(0, 0, 0); }
  return makeTokenUsage(
    jsonIntMemberAt(raw, usage, "prompt_tokens"),
    jsonIntMemberAt(raw, usage, "completion_tokens"),
    jsonIntMemberAt(raw, usage, "total_tokens"),
  );
}

export function runMistralChatWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: Message[]): Result {
  const url = baseUrl + "/chat/completions";
  const body = buildMistralChatBody(model, messages, 0.7, 1024);
  const res = http.request(url, "POST", body, makeMistralAuthHeaders(apiKey));
  return mistralCallResult(url, res.status, res.ok, res.body);
}

export function runMistralChat(apiKey: string, model: string, messages: Message[]): Result {
  return runMistralChatWithBaseUrl("https://api.mistral.ai/v1", apiKey, model, messages);
}

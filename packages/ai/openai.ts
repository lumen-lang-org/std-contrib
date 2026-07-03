// OpenAI-compatible request and response helpers.

import { systemMessage } from "./messages.ts";
import { makeAiResult } from "./result.ts";
import { makeProviderError } from "./error.ts";
import { makeTokenUsage } from "./usage.ts";
import { bearerJsonHeaders } from "./headers.ts";

type OpenAIChatRequest = {
  model: string,
  messages: LumenAiMessage[],
  temperature: number,
  max_tokens: int,
};

type OpenAIChatRequestWithStops = {
  model: string,
  messages: LumenAiMessage[],
  temperature: number,
  max_tokens: int,
  stop: string[],
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

export function buildOpenAIChatBodyWithStops(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
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

export function readOpenAIContent(raw: string): string {
  const parsed: OpenAIChatResponse = JSON.parse<OpenAIChatResponse>(raw);
  if (parsed.choices.length == 0) { return ""; }
  return parsed.choices[0].message.content;
}

export function readOpenAIResult(status: int, ok: bool, raw: string): LumenAiResult {
  return makeAiResult(status, ok, readOpenAIContent(raw), raw);
}

function decodeOpenAIJsonString(src: string): string {
  let out = "";
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\\" && i + 1 < src.length) {
      let n = src.charAt(i + 1);
      if (n == "n") { out = out + "\n"; }
      else if (n == "r") { out = out + "\r"; }
      else if (n == "t") { out = out + "\t"; }
      else if (n == "\"") { out = out + "\""; }
      else if (n == "\\") { out = out + "\\"; }
      else { out = out + n; }
      i = i + 2;
    } else {
      out = out + c;
      i = i + 1;
    }
  }
  return out;
}

function scanOpenAIMessage(raw: string): string {
  let marker = "\"message\":\"";
  let start = raw.indexOf(marker);
  if (start < 0) { return ""; }
  let i = start + marker.length;
  let out = "";
  let escaped: bool = false;
  while (i < raw.length) {
    let c = raw.charAt(i);
    if (escaped) {
      out = out + "\\" + c;
      escaped = false;
      i = i + 1;
    } else if (c == "\\") {
      escaped = true;
      i = i + 1;
    } else if (c == "\"") {
      return decodeOpenAIJsonString(out);
    } else {
      out = out + c;
      i = i + 1;
    }
  }
  return "";
}

function scanOpenAIIntField(raw: string, field: string): int {
  let marker = "\"" + field + "\":";
  let start = raw.indexOf(marker);
  if (start < 0) { return 0; }
  let i = start + marker.length;
  while (i < raw.length && raw.charAt(i) == " ") { i = i + 1; }
  let out: int = 0;
  while (i < raw.length) {
    let c = raw.charAt(i);
    if (c.charCodeAt(0) >= "0".charCodeAt(0) && c.charCodeAt(0) <= "9".charCodeAt(0)) {
      out = out * 10 + (c.charCodeAt(0) - "0".charCodeAt(0));
      i = i + 1;
    } else {
      return out;
    }
  }
  return out;
}

export function readOpenAIError(status: int, raw: string): LumenAiProviderError {
  let message = scanOpenAIMessage(raw);
  if (message == "") { message = raw; }
  return makeProviderError("openai", status, message, raw);
}

export function readOpenAITokenUsage(raw: string): LumenAiTokenUsage {
  return makeTokenUsage(
    scanOpenAIIntField(raw, "prompt_tokens"),
    scanOpenAIIntField(raw, "completion_tokens"),
    scanOpenAIIntField(raw, "total_tokens"),
  );
}

export function runOpenAIChatWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  const body = buildOpenAIChatBody(model, messages, 0.7, 1024);
  const res = http.request(baseUrl + "/chat/completions", "POST", body, makeAuthHeaders(apiKey));
  return readOpenAIResult(res.status, res.ok, res.body);
}

export function runOpenAIChat(apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runOpenAIChatWithBaseUrl("https://api.openai.com/v1", apiKey, model, messages);
}

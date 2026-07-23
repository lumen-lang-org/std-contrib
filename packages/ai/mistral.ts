// Mistral-compatible request and response helpers.

import { systemMessage } from "./messages.ts";
import { makeAiResult } from "./result.ts";
import { makeProviderError } from "./error.ts";
import { makeTokenUsage } from "./usage.ts";
import { bearerJsonHeaders } from "./headers.ts";

type MistralChatRequest = {
  model: string,
  messages: LumenAiMessage[],
  temperature: number,
  max_tokens: int,
};

type MistralChatRequestWithStops = {
  model: string,
  messages: LumenAiMessage[],
  temperature: number,
  max_tokens: int,
  stop: string[],
};

type MistralChoiceMessage = {
  role: string,
  content: string,
};

type MistralChoice = {
  index: int,
  message: MistralChoiceMessage,
  finish_reason: string,
};

type MistralChatResponse = {
  id: string,
  object: string,
  created: int,
  model: string,
  choices: MistralChoice[],
};

function decodeJsonString(src: string): string {
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

function scanFirstContent(raw: string): string {
  let marker = "\"content\":\"";
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
      return decodeJsonString(out);
    } else {
      out = out + c;
      i = i + 1;
    }
  }
  return "";
}

function scanMistralStringField(raw: string, field: string): string {
  let marker = "\"" + field + "\":\"";
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
      return decodeJsonString(out);
    } else {
      out = out + c;
      i = i + 1;
    }
  }
  return "";
}

function scanMistralIntField(raw: string, field: string): int {
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

export function buildMistralChatBody(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  const req: MistralChatRequest = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };
  return JSON.stringify(req);
}

export function buildMistralChatBodyWithStops(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
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

// JSON.parse<T> throws on malformed bodies and on unknown fields, so an
// unexpected response shape falls back to the string scanner instead of
// aborting the caller.
export function readMistralContent(raw: string): string {
  try {
    const parsed: MistralChatResponse = JSON.parse<MistralChatResponse>(raw);
    if (parsed.choices.length > 0) { return parsed.choices[0].message.content; }
    return scanFirstContent(raw);
  } catch (err) {
    return scanFirstContent(raw);
  }
}

export function readMistralResult(status: int, ok: bool, raw: string): LumenAiResult {
  return makeAiResult(status, ok, readMistralContent(raw), raw);
}

export function readMistralError(status: int, raw: string): LumenAiProviderError {
  let message = scanMistralStringField(raw, "detail");
  if (message == "") { message = scanMistralStringField(raw, "message"); }
  if (message == "") { message = raw; }
  return makeProviderError("mistral", status, message, raw);
}

export function readMistralTokenUsage(raw: string): LumenAiTokenUsage {
  return makeTokenUsage(
    scanMistralIntField(raw, "prompt_tokens"),
    scanMistralIntField(raw, "completion_tokens"),
    scanMistralIntField(raw, "total_tokens"),
  );
}

export function runMistralChatWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  const body = buildMistralChatBody(model, messages, 0.7, 1024);
  const res = http.request(baseUrl + "/chat/completions", "POST", body, makeMistralAuthHeaders(apiKey));
  return readMistralResult(res.status, res.ok, res.body);
}

export function runMistralChat(apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runMistralChatWithBaseUrl("https://api.mistral.ai/v1", apiKey, model, messages);
}

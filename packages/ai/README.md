# ai

Typed AI helpers for OpenAI-compatible chat APIs, written in Lumen.

This package starts with the practical core of AI applications: messages,
prompt templates, model calls, and a small response parser. It stays
intentionally lean for V1 because Lumen is statically typed and does not expose
dynamic JSON, streaming HTTP responses, or provider SDKs yet.

## Use

```ts
import { chatMistral, system, user, renderTemplate } from "https://lumen-lang.org/package/std-contrib/ai/ai.ts";

let prompt = renderTemplate(
  "Explain {{topic}} in one sentence.",
  ["topic"],
  ["native compilation"],
);

let messages = [
  system("You are concise."),
  user(prompt),
];

let result = chatMistral("mistral-key", "mistral-large-latest", messages);
console.log(result.content);
```

For a local live smoke test, use the checked-in Mistral example:

```sh
export MISTRAL_API_KEY="..."
lumen compile packages/ai/examples/mistral-chat.ts
./mistral-chat
```

## API

| API | Meaning |
| --- | --- |
| `system(content)` | Create a system message |
| `user(content)` | Create a user message |
| `assistant(content)` | Create an assistant message |
| `renderTemplate(template, keys, values)` | Replace `{{key}}` placeholders |
| `openAIChatBody(model, messages, temperature, maxTokens)` | Build request JSON |
| `authHeaders(apiKey)` | Build OpenAI-compatible HTTP headers |
| `parseOpenAIContent(raw)` | Extract the first assistant message from response JSON |
| `parseOpenAIResult(status, ok, raw)` | Build a normalized result record |
| `chatOpenAI(apiKey, model, messages)` | POST to `https://api.openai.com/v1/chat/completions` |
| `chatOpenAIWithBaseUrl(baseUrl, apiKey, model, messages)` | POST to another OpenAI-compatible base URL |
| `mistralChatBody(model, messages, temperature, maxTokens)` | Build Mistral request JSON |
| `mistralAuthHeaders(apiKey)` | Build Mistral HTTP headers |
| `parseMistralContent(raw)` | Extract the first assistant message from Mistral response JSON |
| `parseMistralResult(status, ok, raw)` | Build a normalized Mistral result record |
| `chatMistral(apiKey, model, messages)` | POST to `https://api.mistral.ai/v1/chat/completions` |
| `chatMistralWithBaseUrl(baseUrl, apiKey, model, messages)` | POST to another Mistral-compatible base URL |

## Files

- `ai.ts` is the public entry point.
- `messages.ts` contains chat message constructors and the shared message type.
- `prompt.ts` contains prompt templating.
- `openai.ts` contains OpenAI-compatible request, response, and HTTP helpers.
- `mistral.ts` contains Mistral request, response, and HTTP helpers.
- `headers.ts` and `result.ts` contain shared provider helpers.
- `examples/mistral-chat.ts` is a live Mistral smoke test.
- `spec.md` and `tasks.md` track the AI package roadmap.

## Design

AI application frameworks are broad: agents, tools, memory, retrieval, tracing,
streaming, and provider integrations. This package starts with the smallest
useful Lumen-native layer:

- typed chat messages
- prompt templating
- JSON request construction through the stdlib `JSON.stringify`
- typed response parsing through `JSON.parse<T>`
- HTTP calls through stdlib `http.request`
- `Map<string, string>` headers
- OpenAI and Mistral non-streaming chat APIs

That gives Lumen users a real AI API client without Node.js, npm packages, or a
JavaScript runtime.

## Limits in V1

- no streaming responses
- no multimodal or chunk-list response content; V1 expects string `content`
- no tool-call loop yet
- no dynamic schema validation
- no provider-specific SDKs
- no automatic retries
- no response-header inspection

These are natural follow-ups as Lumen grows network streams, richer JSON value
support, and more runtime primitives.

Test:

```sh
lumen test packages/ai/ai.ts
```

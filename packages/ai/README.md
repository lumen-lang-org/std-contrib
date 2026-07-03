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
| `partialTemplate(template, keys, values)` | Replace known placeholders and leave unknown ones intact |
| `missingVariables(template, keys)` | Return placeholder names not present in `keys` |
| `unusedVariables(template, keys)` | Return provided keys not used by the template |
| `systemTemplate(template, keys, values)` | Render a system message template |
| `userTemplate(template, keys, values)` | Render a user message template |
| `assistantTemplate(template, keys, values)` | Render an assistant message template |
| `renderChatPrompt(roles, templates, keys, values)` | Render flat `role/content` chat prompt entries |
| `chatPromptRole(entry)` | Read the role from a rendered chat prompt entry |
| `chatPromptContent(entry)` | Read the content from a rendered chat prompt entry |
| `chatRequest(provider, model, messages, temperature, maxTokens)` | Build a provider-neutral chat request |
| `aiResult(status, ok, content, raw)` | Build a provider-neutral result |
| `providerError(provider, status, message, raw)` | Build a provider-neutral error |
| `modelOptions(temperature, maxTokens)` | Build provider-neutral model options |
| `defaultModelOptions()` | Build default model options |
| `providerChatBody(provider, model, messages, temperature, maxTokens)` | Build provider-specific chat JSON by provider name |
| `parseText(raw)` | Return raw model output as text |
| `parseLines(raw)` | Split model output into lines |
| `parseStringList(raw)` | Parse common bullet/number/plain line lists |
| `parseChoice(raw, choices, fallback)` | Parse one allowed string choice |
| `firstFencedBlock(raw)` | Extract the first triple-backtick block |
| `firstJsonObject(raw)` | Extract the first balanced JSON object |
| `typedJsonInput(raw)` | Extract the best JSON string to pass to `JSON.parse<T>` |
| `retryPrompt(instruction, invalidOutput, errorMessage)` | Build a correction prompt after invalid output |
| `openAIChatBody(model, messages, temperature, maxTokens)` | Build request JSON |
| `openAIChatBodyWithStops(model, messages, temperature, maxTokens, stop)` | Build request JSON with stop sequences |
| `authHeaders(apiKey)` | Build OpenAI-compatible HTTP headers |
| `parseOpenAIContent(raw)` | Extract the first assistant message from response JSON |
| `parseOpenAIResult(status, ok, raw)` | Build a normalized result record |
| `parseOpenAIError(status, raw)` | Parse an OpenAI-compatible error JSON body |
| `parseOpenAITokenUsage(raw)` | Parse OpenAI-compatible token usage |
| `chatOpenAI(apiKey, model, messages)` | POST to `https://api.openai.com/v1/chat/completions` |
| `chatOpenAIWithBaseUrl(baseUrl, apiKey, model, messages)` | POST to another OpenAI-compatible base URL |
| `mistralChatBody(model, messages, temperature, maxTokens)` | Build Mistral request JSON |
| `mistralChatBodyWithStops(model, messages, temperature, maxTokens, stop)` | Build Mistral request JSON with stop sequences |
| `mistralAuthHeaders(apiKey)` | Build Mistral HTTP headers |
| `parseMistralContent(raw)` | Extract the first assistant message from Mistral response JSON |
| `parseMistralResult(status, ok, raw)` | Build a normalized Mistral result record |
| `parseMistralError(status, raw)` | Parse a Mistral error JSON body |
| `parseMistralTokenUsage(raw)` | Parse Mistral token usage |
| `chatMistral(apiKey, model, messages)` | POST to `https://api.mistral.ai/v1/chat/completions` |
| `chatMistralWithBaseUrl(baseUrl, apiKey, model, messages)` | POST to another Mistral-compatible base URL |

## Files

- `ai.ts` is the public entry point.
- `messages.ts` contains chat message constructors and the shared message type.
- `request.ts` contains provider-neutral chat request helpers.
- `error.ts` contains provider-neutral error helpers.
- `usage.ts` contains provider-neutral token usage helpers.
- `options.ts` contains provider-neutral model option helpers.
- `provider.ts` contains provider selection helpers.
- `output.ts` contains output parser helpers.
- `prompt.ts` contains prompt templating.
- `openai.ts` contains OpenAI-compatible request, response, and HTTP helpers.
- `mistral.ts` contains Mistral request, response, and HTTP helpers.
- `headers.ts` and `result.ts` contain shared provider helpers.
- `examples/mistral-chat.ts` is a live Mistral smoke test.
- `examples/openai-chat.ts` is a live OpenAI-compatible smoke test.
- `examples/openai-compatible-chat.ts` is a live local gateway smoke test.
- `examples/prompt-snapshot.ts` is a deterministic prompt rendering example.
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

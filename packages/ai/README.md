# ai

Typed AI helpers for OpenAI-compatible chat APIs, written in Lumen.

This package starts with the practical core of AI applications: messages,
prompt templates, model calls, a small response parser, retrieval over local
documents, conversation memory, tools, and an agent loop that runs a model and
its tools until the task is done. It stays intentionally lean for V1 because
Lumen is statically typed and does not expose dynamic JSON, streaming HTTP
responses, or provider SDKs yet.

Everything is immutable: nothing in this package mutates an argument. Helpers
that look like they update a store, a document, or a history take a value and
return a new one.

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
| `document(id, text, source, metadata)` | Build a document record |
| `docMetadata(doc, key)` | Read one metadata value, or `""` when absent |
| `withDocMetadata(doc, key, value)` | Return a copy of the document with one metadata entry set |
| `splitText(text, size, overlap)` | Split text into fixed-size overlapping chunks |
| `splitTextRecursive(text, size, overlap)` | Split on paragraph, line, then word boundaries |
| `splitParagraphs(text)` | Split text on blank lines |
| `splitDocuments(text, source, size, overlap)` | Split text straight into document records |
| `dot(a, b)` | Dot product of two vectors |
| `norm(v)` | Euclidean length of a vector |
| `normalize(v)` | Scale a vector to unit length |
| `cosine(a, b)` | Cosine similarity in `[-1, 1]` |
| `distance(a, b)` | Euclidean distance between two vectors |
| `hashEmbedding(text, dims)` | Deterministic offline embedding, no API key |
| `embeddingBody(model, input)` | Build embeddings request JSON |
| `embeddingBodyBatch(model, inputs)` | Build batch embeddings request JSON |
| `parseEmbedding(raw)` | Parse one vector from an embeddings response |
| `parseEmbeddingBatch(raw)` | Parse every vector from an embeddings response |
| `embedText(apiKey, model, input)` | POST to `https://api.openai.com/v1/embeddings` |
| `embedTextWithBaseUrl(baseUrl, apiKey, model, input)` | POST to another OpenAI-compatible base URL |
| `embedMistral(apiKey, model, input)` | POST to `https://api.mistral.ai/v1/embeddings` |
| `vectorStore()` | Build an empty in-memory vector store |
| `storeSize(store)` | Count the documents in a store |
| `addVector(store, doc, vector)` | Return a new store with one document and its vector |
| `addDocs(store, docs, dims)` | Return a new store with documents embedded offline |
| `deleteDoc(store, id)` | Return a new store without the document with that ID |
| `filterDocs(store, key, value)` | Return a new store keeping only matching metadata |
| `searchVector(store, query, k)` | Top-k search with a vector you already have |
| `search(store, query, dims, k)` | Top-k search from query text |
| `queryTerms(text)` | Lowercase, punctuation-free query tokens |
| `keywordScore(doc, terms)` | Term-overlap score in `[0, 1]` |
| `keywordRetrieve(docs, query, k)` | Retrieve by term overlap, dropping non-matches |
| `vectorRetrieve(store, query, dims, k)` | Retrieve by cosine similarity, dropping zero scores |
| `retrieve(store, docs, query, dims, k)` | Hybrid retrieval: 0.6 keyword plus 0.4 vector |
| `formatContext(hits)` | Render hits as numbered, cited context blocks |
| `ragPrompt(question, hits)` | Build a grounded single-string answer prompt |
| `ragMessages(question, hits)` | Build grounded system and user messages |
| `appendMessage(history, msg)` | Return a new history with one message appended |
| `windowMemory(history, turns)` | Keep the last N messages plus any leading system message |
| `budgetMemory(history, maxChars)` | Drop the oldest turns until the history fits a character budget |
| `estimateTokens(text)` | Rough chars/4 token estimate |
| `historyChars(history)` | Total character count of a history |
| `transcript(history)` | Render a history as `role: content` lines |
| `summaryPrompt(history, priorSummary)` | Build a prompt that folds turns into a running summary |
| `applySummary(summary, recent)` | Replace old turns with a summary system message |
| `remember(store, key, value)` | Return a new key/value memory store with one entry set |
| `recall(store, key)` | Read one key/value memory entry, or `""` when absent |
| `serializeHistory(history)` | Serialize a history to JSON |
| `parseHistory(raw)` | Parse a history from JSON |
| `saveHistory(path, history)` | Write a history to a file |
| `loadHistory(path)` | Read a history from a file |
| `defineTool(name, description, params, run)` | Build a tool from a `(string) => string` function |
| `toolRegistry()` | Build an empty tool registry |
| `registerTool(tools, entry)` | Return a new registry with a tool added, or replaced by name |
| `findTool(tools, name)` | Index of a registered tool, or `-1` |
| `hasTool(tools, name)` | Whether a name is registered |
| `toolNames(tools)` | Registered tool names, in order |
| `toolDescriptions(tools)` | Render the registry as one `- name(params): description` line per tool |
| `runTool(tools, name, input)` | Dispatch one tool and return a result record |
| `runToolGuarded(tools, allow, deny, name, input)` | Dispatch only when the allow/deny policy permits it |
| `toolMessage(result)` | Turn a tool result into a `role: "tool"` message |
| `toolCall(id, name, args)` | Build a provider-neutral tool call record |
| `toolCalls(raw)` | Parse tool calls out of an OpenAI-compatible response body |
| `parseMistralToolCalls(raw)` | Parse tool calls out of a Mistral response body |
| `toolCallArg(call, key)` | Read one argument out of a tool call payload |
| `toolInput(call)` | Read the V1 `input` argument of a tool call |
| `hasToolCalls(raw)` | Whether a response body asks for any tool |
| `finishReason(raw)` | Read `finish_reason` from a response body |
| `serializeToolDefs(tools)` | Serialize the registry as an OpenAI-compatible `tools` array |
| `serializeToolDefsMistral(tools)` | Serialize the registry as a Mistral `tools` array |
| `agentSystemPrompt(tools, instruction)` | Build the agent system prompt that lists the tools and how to stop |
| `runAgent(model, tools, history, maxSteps)` | Run the model/tool loop and return answer, steps, and stop reason |
| `runAgentWithPolicy(model, tools, allow, deny, history, maxSteps)` | Run the loop with a tool allow/deny policy |
| `agentStep(index, name, input, output, ok)` | Build one agent step record |
| `agentTrace(result)` | Render every tool call in order and why the run stopped |
| `fakeModel(responses)` | Deterministic offline model driver replaying canned response bodies |
| `fakeAnswer(text)` | Build a canned provider body carrying a final answer |
| `fakeToolCall(name, input)` | Build a canned provider body carrying one tool call |

## RAG

Retrieval runs entirely offline: split local text into documents, index them
with the built-in hashing embedder, retrieve, then send grounded messages to a
model.

```ts
import {
  splitDocuments,
  vectorStore,
  addDocs,
  retrieve,
  formatContext,
  ragMessages,
  chatMistral,
} from "https://lumen-lang.org/package/std-contrib/ai/ai.ts";

let notes = "lumen compiles to a native binary with no runtime and no interpreter.\n\nsourdough bread needs a starter, flour, water and salt.";

let docs = splitDocuments(notes, "notes.md", 200, 20);
let store = addDocs(vectorStore(), docs, 128);

let question = "does lumen need a runtime?";
let hits = retrieve(store, docs, question, 128, 3);

console.log(formatContext(hits));

let result = chatMistral(
  "mistral-key",
  "mistral-large-latest",
  ragMessages(question, hits),
);
console.log(result.content);
```

The grounded system message tells the model to cite each claim with the bracket
number of its context block and to reply exactly `The context does not contain
the answer.` when the context does not answer the question.

Use at least 128 dimensions. `hashEmbedding` is a hashing bag of words, so
distinct terms collide into the same bucket at low dimension counts. When "no
match" must mean no results, use `keywordRetrieve`: it drops documents that
share no term with the query, while the vector path always returns some
collision noise. For real semantic search, index with `embedText` instead and
insert the returned vectors with `addVector`.

## Conversation memory

A history is a plain `LumenAiMessage[]`. Every memory helper returns a new
array, so a turn is a rebind rather than a mutation.

```ts
import {
  system,
  user,
  assistant,
  appendMessage,
  windowMemory,
  saveHistory,
  loadHistory,
  remember,
  recall,
  chatMistral,
} from "https://lumen-lang.org/package/std-contrib/ai/ai.ts";

let history = [system("You are concise.")];
history = appendMessage(history, user("What compiles to a native binary?"));

let reply = chatMistral(
  "mistral-key",
  "mistral-large-latest",
  windowMemory(history, 8),
);
history = appendMessage(history, assistant(reply.content));

saveHistory("chat.json", history);
let resumed = loadHistory("chat.json");
console.log(resumed.length);

let facts = remember("", "name", "Aymen");
facts = remember(facts, "language", "Lumen");
console.log(recall(facts, "language"));
```

`windowMemory` counts messages, not turn pairs, and always re-prepends a leading
system message. `budgetMemory` trims by character count instead but never drops
the system message or the most recent turn, so it can return a history that is
still over budget. For long conversations, build a running summary with
`summaryPrompt`, send it to a model, and fold the result back in with
`applySummary`.

## Tools and agents

A tool is a name, a description the model reads, a one-line note about the
input, and a plain function from one string to one string. An agent is a model
and a registry run in a loop: the model asks for a tool, the loop dispatches it,
appends the result to the conversation, and calls the model again until it
answers or the step budget runs out.

This example runs offline. `fakeModel` replays canned provider response bodies
in order, so the whole loop is testable with no network and no API key.

```ts
import {
  defineTool,
  toolRegistry,
  registerTool,
  system,
  user,
  agentSystemPrompt,
  runAgent,
  agentTrace,
  fakeModel,
  fakeToolCall,
  fakeAnswer,
} from "https://lumen-lang.org/package/std-contrib/ai/ai.ts";

function weatherTool(city: string): string {
  return "18C and clear in " + city;
}

function clockTool(zone: string): string {
  return "12:00 in " + zone;
}

let tools = registerTool(
  toolRegistry(),
  defineTool("weather", "Current weather for a city.", "city name", weatherTool),
);
tools = registerTool(
  tools,
  defineTool("clock", "The local time in a zone.", "zone name", clockTool),
);

let history = [
  system(agentSystemPrompt(tools, "You are a weather assistant.")),
  user("What is the weather in Paris?"),
];

// Turn one asks for the tool, turn two answers. A real run passes a closure
// that calls a provider and returns the raw response body instead.
let model = fakeModel([
  fakeToolCall("weather", "Paris"),
  fakeAnswer("It is 18C and clear in Paris."),
]);

let result = runAgent(model, tools, history, 4);

console.log(result.answer);      // It is 18C and clear in Paris.
console.log(result.stopReason);  // final
console.log(agentTrace(result));
// 1. weather(Paris) -> 18C and clear in Paris
// stopped: final after 2 model calls, 1 tool call
```

`stopReason` is one of exactly three values: `final` when the model answered
without asking for another tool, `max_steps` when the budget ran out first, and
`error` when the provider returned a body with no usable message in it.
`stepCount` counts model calls; `steps` holds one record per tool call, so a
turn that asked for two tools contributes one to `stepCount` and two to `steps`.
`answer` is the best answer seen so far, so a run that stops early still returns
whatever prose the model had already written.

A tool body must not throw, and must not call anything that throws: the
compiler rejects a throwing function in the registry's `run` field. Report
trouble by returning text. A failed dispatch — an unknown name, a denied name —
is not a crash either; it comes back as a step whose output is `error: ...` and
goes to the model in the same message shape as a success, so the model can read
it and try something else.

`runToolGuarded` and `runAgentWithPolicy` take an allow list and a deny list.
Deny wins over allow, an empty allow list means everything not denied, and
policy is checked before the registry is consulted, so a denied name never
reveals whether such a tool exists.

`maxSteps` bounds model calls, so the loop terminates even against a model that
asks for a tool forever. The tool calls of the last permitted turn are still
dispatched, so the trace shows what the agent was doing when it ran out of
budget; if a side effect must never run unobserved, deny that tool or raise the
budget.

To drive the loop with a real provider, pass a closure that returns the raw
response body, and send the tool definitions with the request:

```ts
let model = (messages: LumenAiMessage[]) => {
  return chatMistral("mistral-key", "mistral-large-latest", messages).raw;
};
console.log(serializeToolDefs(tools));
```

V1 sends that `tools` array as its own request field. The loop's own bookkeeping
is provider-neutral text: the assistant turn that asked for tools is recorded as
`[tool_calls] weather({"input":"Paris"})`, and results come back with role
`tool`. A live provider needs an adapter that turns those back into its native
`tool_calls` and `tool_call_id` fields rather than sending them verbatim.

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
- `document.ts` contains the document record, metadata, and text splitters.
- `vector.ts` contains vector maths and the offline hashing embedder.
- `embed.ts` contains embeddings request bodies, parsers, and HTTP helpers.
- `store.ts` contains the in-memory vector store and similarity search.
- `retrieve.ts` contains keyword, vector, and hybrid retrievers plus RAG prompts.
- `memory.ts` contains conversation memory, key/value memory, and history files.
- `tools.ts` contains the tool record, the registry, dispatch, and the
  allow/deny policy.
- `toolcall.ts` contains provider tool-call parsing and tool definition
  serialization.
- `agent.ts` contains the agent loop, its trace, and the offline fake model
  driver.
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
- documents, splitters, embeddings, and an in-memory vector store
- keyword, vector, and hybrid retrieval with grounded RAG prompts
- window, budget, summary, key/value, and file-backed memory
- a tool registry, tool dispatch, and an allow/deny policy
- provider tool-call parsing and a step-bounded agent loop

That gives Lumen users a real AI API client without Node.js, npm packages, or a
JavaScript runtime.

## Limits in V1

Retrieval, embeddings, memory, tools, and the agent loop now ship. What is still
missing:

- no streaming responses
- no multimodal or chunk-list response content; V1 expects string `content`
- a tool takes one string and returns one string; no typed tool arguments yet
- a tool body cannot throw, because the compiler rejects a throwing function in
  the registry's `run` field; report failures by returning text
- the agent loop records tool calls as provider-neutral text, so sending a run
  to a live provider needs an adapter that re-serializes native `tool_calls` and
  maps the `tool` role to a `tool_call_id`
- no middleware or guardrail hooks beyond the tool allow/deny policy
- no model retry policy and no tool retry policy
- no checkpoint, resume, or rewind of a partly finished agent run
- no human-in-the-loop pause before a sensitive tool
- no dynamic schema validation
- no provider-specific SDKs
- no automatic retries
- no response-header inspection
- the vector store is in-memory only; there is no persistent vector database
- `hashEmbedding` is a hashing bag of words, not a semantic model; real
  similarity needs provider embeddings through `embedText`
- no stemming, no stop-word list, and no re-ranking in the keyword retriever
- summary memory builds the prompt but does not call a model for you

These are natural follow-ups as Lumen grows network streams, richer JSON value
support, and more runtime primitives.

Test:

```sh
lumen test packages/ai/ai.ts
```

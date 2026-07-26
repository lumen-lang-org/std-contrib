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

let prompt = renderTemplate("Explain {{topic}} in one sentence.", [
  { name: "topic", value: "native compilation" },
]);

let messages = [
  system("You are concise."),
  user(prompt),
];

let result = chatMistral({
  apiKey: "mistral-key",
  model: "mistral-large-latest",
  baseUrl: "",
  messages: messages,
});
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
| `renderTemplate(template, vars)` | Replace `{{name}}` placeholders; a var is `{ name, value }` |
| `partialTemplate(template, vars)` | Replace known placeholders and leave unknown ones intact |
| `missingVariables(template, keys)` | Return placeholder names not present in `keys` |
| `unusedVariables(template, keys)` | Return provided keys not used by the template |
| `systemTemplate(template, vars)` | Render a system message template |
| `userTemplate(template, vars)` | Render a user message template |
| `assistantTemplate(template, vars)` | Render an assistant message template |
| `renderChatPrompt(parts, vars)` | Render `role/content` entries; a part is `{ role, template }` |
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
| `chatOpenAI(call)` | POST an OpenAI chat; `call` is `{ apiKey, model, baseUrl, messages }`, empty `baseUrl` meaning OpenAI itself |
| `mistralChatBody(model, messages, temperature, maxTokens)` | Build Mistral request JSON |
| `mistralChatBodyWithStops(model, messages, temperature, maxTokens, stop)` | Build Mistral request JSON with stop sequences |
| `mistralAuthHeaders(apiKey)` | Build Mistral HTTP headers |
| `parseMistralContent(raw)` | Extract the first assistant message from Mistral response JSON |
| `parseMistralResult(status, ok, raw)` | Build a normalized Mistral result record |
| `parseMistralError(status, raw)` | Parse a Mistral error JSON body |
| `parseMistralTokenUsage(raw)` | Parse Mistral token usage |
| `chatMistral(call)` | POST a Mistral chat; same `ChatCall` record, empty `baseUrl` meaning Mistral itself |
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
| `needsCompression(history, maxChars)` | Whether the conversation has outgrown its character budget |
| `compressHistory(summarize, history, keepRecent)` | Fold older turns into a running summary, keeping the system prompt and the last `keepRecent` messages |
| `compressIfNeeded(summarize, history, maxChars, keepRecent)` | Compress only when over budget |
| `summarizer(cfg)` | A summarizer backed by any configured model — the provider is a field of `cfg`, so there is one of these, not one per vendor |
| `schemaField(name, type, description, required)` | Describe one property of an object schema |
| `objectSchema(fields)` | Build a strict JSON Schema object from fields |
| `schemaRequired(fields)` | The required field names, for validation |
| `structuredChat(provider, apiKey, model, messages, name, schema, required)` | Native schema-mode request by provider name |
| `structuredOpenAI(...)` / `structuredMistral(...)` | Native schema mode for a specific provider |
| `structuredWithBaseUrl(baseUrl, ...)` | Schema mode against any OpenAI-compatible endpoint |
| `structuredJsonMode(baseUrl, ...)` | JSON-mode fallback for endpoints without schema mode |
| `validateStructured(json, required)` | Check a reply is an object carrying every required field |
| `structuredRetryPrompt(schema, invalid, reason)` | Correction prompt after an invalid structured reply |
| `defineTool(name, description, params, run)` | Build a tool from a `(string) => string` function |
| `toolRegistry()` | Build an empty tool registry |
| `registerTool(tools, entry)` | Return a new registry with a tool added, or replaced by name |
| `findTool(tools, name)` | Index of a registered tool, or `-1` |
| `hasTool(tools, name)` | Whether a name is registered |
| `toolNames(tools)` | Registered tool names, in order |
| `toolDescriptions(tools)` | Render the registry as one `- name(params): description` line per tool |
| `runTool(tools, name, input)` | Dispatch one tool and return a result record |
| `runToolGuarded(tools, policy, name, input)` | Dispatch only when the policy permits it; `policy` is `{ allow, deny }` |
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
| `runAgentWithPolicy(model, tools, policy, history, maxSteps)` | Run the loop under a `{ allow, deny }` tool policy |
| `agentStep(index, name, input, output, ok)` | Build one agent step record |
| `agentTrace(result)` | Render every tool call in order and why the run stopped |
| `fakeModel(responses)` | Deterministic offline model driver replaying canned response bodies |
| `fakeAnswer(text)` | Build a canned provider body carrying a final answer |
| `fakeToolCall(name, input)` | Build a canned provider body carrying one tool call |
| `openAIAgent(apiKey, model, tools)` | Live OpenAI-compatible `AiModel` for `runAgent`, tool definitions and round trip included |
| `mistralAgent(apiKey, model, tools)` | Live Mistral `AiModel` for `runAgent`, tool definitions and round trip included |
| `agentChatTurns(messages)` | Rebuild native `tool_calls` / `tool_call_id` turns from the loop's neutral history |
| `openAIToolBody(model, turns, tools, temperature, maxTokens)` | Build a tool-enabled OpenAI-compatible chat body from native turns |
| `mistralToolBody(model, turns, tools, temperature, maxTokens)` | Build a tool-enabled Mistral chat body from native turns |
| `toolChatOpenAI(apiKey, model, turns, tools)` | One tool-enabled OpenAI-compatible round trip, returning the raw body |
| `toolChatMistral(apiKey, model, turns, tools)` | One tool-enabled Mistral round trip, returning the raw body |
| `mcpRequestBody(id, method, params)` | Build a JSON-RPC 2.0 request with raw JSON `params` embedded verbatim |
| `mcpConnectBody()` | Build the MCP `initialize` request body |
| `mcpListToolsBody(id)` | Build a `tools/list` request body |
| `mcpCallBody(id, name, argumentsJson)` | Build a `tools/call` request body with raw JSON arguments |
| `mcpParseTools(raw)` | Parse tool descriptors (name, description, raw schema) from a `tools/list` reply |
| `parseMcpResult(raw)` | Parse a `tools/call` reply into an `ok`/`content`/`error` record |
| `mcpReplyId(raw)` | Read the JSON-RPC `id` from a reply |
| `mcpIsError(raw)` | Whether a reply carries a JSON-RPC error |
| `mcpErrorMessage(raw)` | Read the JSON-RPC error message, or `""` |
| `mcpResultField(raw)` | Source text of the top-level `result`, or `""` |
| `mcpConnect(url, headers)` | POST an `initialize` handshake and return the raw reply body |
| `mcpTools(url, headers)` | List an MCP server's tools over HTTP |
| `mcpCall(url, headers, name, argumentsJson)` | Call one MCP tool over HTTP |
| `mcpAsTool(url, headers, tool)` | Adapt one MCP tool descriptor into a runnable `AiTool` |
| `mcpAsTools(url, headers, tools)` | Adapt every MCP tool descriptor into a `AiTool[]` for `runAgent` |
| `mcpStdioConnect(command, args)` | Spawn a local MCP server as a subprocess and return a live stdio session |
| `mcpStdioTools(session)` | List an MCP server's tools over stdio |
| `mcpStdioCall(session, name, argumentsJson)` | Call one MCP tool over stdio |
| `mcpStdioAsTools(session, tools)` | Adapt stdio MCP tools into a `AiTool[]` for `runAgent` |
| `mcpStdioClose(session)` | Close the server's stdin and wait for it to exit |
| `mcpSseTools(url, headers)` | List tools from an SSE/streamable-HTTP MCP server (`http://` only) |
| `mcpSseCall(url, headers, name, argumentsJson)` | Call one MCP tool over SSE |
| `mcpSseAsTools(url, headers, tools)` | Adapt SSE MCP tools into a `AiTool[]` for `runAgent` |

## Documents, splitting and loading

Retrieval starts by cutting a document into pieces small enough to embed. The
splitter follows the document's own structure rather than a byte count: it
splits on the widest separator present — a blank line, then a line, then a
sentence, then a word — and recurses into only the pieces that are still too
long. Three short paragraphs stay three chunks; one long paragraph among them is
the only one broken down further.

```ts
let cs = chunks(text, 1000, 200);
for (const c of cs) {
  console.log(`${c.start}..${c.end} ${c.text}`);
}
```

**Sizes and overlaps are byte counts**, like everything else about a Lumen
string. For English that reads as characters; for CJK a byte budget of 1000
holds about 333 characters, since each is three bytes. Chunks never split a
character regardless — the budget is a ceiling the splitter stays under, backing
off to a character boundary.

Every chunk carries the byte range it came from, so `text.substring(c.start,
c.end)` is exactly `c.text`, and the chunks cover the document contiguously —
with no overlap, each begins where the last ended, so concatenating them
reproduces the text. That is what lets a retrieved chunk point back at
its place in the source, which is most of what a citation is. `c.forced` marks a
chunk whose boundary fell inside a word because the text offered no separator to
break on — a long URL, or a run of CJK.

Splitting a document carries its metadata into every chunk, and adds the chunk's
index, byte range, and parent id:

```ts
let doc = loadText(notes, "notes.md");
let parts = splitDocument(doc, 1000, 200);
documentMetadata(parts[3], "chunk");   // "3"
documentMetadata(parts[3], "parent");  // "notes.md"
```

`markdownChunks` breaks at headings before prose boundaries and `codeChunks` at
declarations; `chunksWith` takes an explicit separator list. A separator that
opens a section heads its chunk, while one that closes a sentence tails the
piece it ended — so a heading starts a chunk and a full stop finishes one.

Loading reads from the filesystem and reports what it could not read, rather
than leaving a hole in an index that later just looks incomplete:

```ts
let r = loadDirectory("./docs", [".md", ".txt"], true);
if (!r.ok) { console.error(r.error); }
for (const d of r.docs) { /* d.source is the path */ }
```

A failure is reported, never raised: a directory passed where a file belongs, or
a file the process may not read, comes back as `ok: false` rather than ending
the run. One gap is the runtime's own — a directory that cannot be read comes
back as an empty listing, indistinguishable from an empty one, so such a subtree
is skipped silently.

`loadFile` reads one file, `loadText` wraps text already in hand, and
`loadDirectory` takes an extension filter (including the dot; an empty list
takes everything) and an optional recursive descent. Matching is by extension
only — there is no globbing.

### Differences from LangChain

The algorithm is LangChain's `RecursiveCharacterTextSplitter`, with two of its
behaviours deliberately changed:

- **Overlap always applies.** LangChain runs its overlap logic only while
  resolving a chunk-size overflow, so a document whose pieces all fit gets no
  overlap at all despite asking for it (langchain#34804). Here overlap applies
  whenever a chunk has a predecessor.
- **Overlap is the number you asked for.** LangChain's overlap is whatever whole
  pieces survive eviction, so it depends on split granularity and is never
  exactly the configured figure. Here it is a byte count taken off the chunk's
  own start.

Not carried over: the class hierarchy (a markdown splitter is this splitter with
a different separator list — a default argument, not a subclass), async (there
is no tokenizer to await), and the lookahead-regex separator split, which
attaches every separator to the *following* piece and is why Chinese chunks
there begin with a full stop (langchain#18770).

Tool-call-aware and token-based splitting are not implemented: token counts need
a tokenizer, and this package has none.

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

let result = chatMistral({
  apiKey: "mistral-key",
  model: "mistral-large-latest",
  baseUrl: "",
  messages: ragMessages(question, hits),
});
console.log(result.content);
```

The grounded system message tells the model to cite each claim with the bracket
number of its context block and to reply exactly `The context does not contain
the answer.` when the context does not answer the question.

Use at least 128 dimensions. `hashEmbedding` is a hashing bag of words, so
distinct terms collide into the same bucket at low dimension counts. When "no
match" must mean no results, use `keywordRetrieve`: it drops documents that
share no term with the query, while the vector path always returns some
collision noise. For real semantic search, embed with a provider model instead. `embedBatchWithConfig`
takes every chunk in one request, and the returned vectors go into the store
with `addVector`:

```ts
let cfg = modelConfig({ provider: "mistral", model: "mistral-embed", apiKey: apiKey });
let vectors = embedBatchWithConfig(cfg, texts);
```

A response with fewer rows than inputs yields none rather than a partial list —
a partial one would pair vectors with the wrong chunks, and the misalignment
would show up later as retrieval that is merely bad rather than broken.
`examples/embed-search.ts` is a runnable version; against mistral-embed it ranks
a passage that shares no words with the question above one that does not, which
is the whole difference from the hashing embedder.

## Conversation memory

A history is a plain `AiMessage[]`. Every memory helper returns a new
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

let reply = chatMistral({
  apiKey: "mistral-key",
  model: "mistral-large-latest",
  baseUrl: "",
  messages: windowMemory(history, 8),
});
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

`runToolGuarded` and `runAgentWithPolicy` take a `ToolPolicy` — `{ allow, deny }`
as one record rather than two adjacent lists, because swapping two lists of
strings compiles and inverts the policy, permitting exactly what was meant to be
blocked. Deny wins over allow, an empty allow list means everything not denied, and
policy is checked before the registry is consulted, so a denied name never
reveals whether such a tool exists.

`maxSteps` bounds model calls, so the loop terminates even against a model that
asks for a tool forever. The tool calls of the last permitted turn are still
dispatched, so the trace shows what the agent was doing when it ran out of
budget; if a side effect must never run unobserved, deny that tool or raise the
budget.

### Live tool-calling agents

`openAIAgent` and `mistralAgent` return a `AiModel` you hand straight to
`runAgent`. The closure carries the serialized tool definitions in every request
and performs the native tool round trip, so the loop and its public signature are
unchanged — only the model source differs from the offline `fakeModel`.

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
  openAIAgent,
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

// The only change from the offline example is the model source. The request now
// carries the tool definitions, and the assistant tool_calls -> tool result
// round trip is handled for you: each request rebuilds native tool_calls on the
// assistant turn and a matching tool_call_id on each tool turn.
let model = openAIAgent("sk-your-key", "gpt-4o-mini", tools);

let result = runAgent(model, tools, history, 6);

console.log(result.answer);
console.log(result.stopReason);
console.log(agentTrace(result));
```

`mistralAgent` is the same against the Mistral endpoint. The loop still keeps its
own bookkeeping as provider-neutral text (`[tool_calls] weather({"input":"Paris"})`
for the assistant turn, role `tool` for a result); the agent model rebuilds that
into native `tool_calls` and `tool_call_id` fields per request. The ids are
synthesized fresh each request (`call_1`, `call_2`, ...) — a chat request is
self-contained, so they only need to agree within the one request, not with any
id the provider returned earlier. To build or send a single tool-enabled request
yourself, use `openAIToolBody` / `toolChatOpenAI` (and the Mistral equivalents)
over turns from `agentChatTurns`.

## MCP

The Model Context Protocol lets an agent borrow tools that live on another
server. `mcpTools` lists a server's tools, `mcpAsTools` adapts each one into a
`AiTool` whose `run` calls the server, and the result drops straight into
`runAgent` next to any local tools you defined. The adapter keeps each tool's
raw JSON input schema in the `params` field, and follows this package's one
string in, one string out convention: the input is sent as `{"input": <input>}`
and the server's text output comes back as the tool result.

```ts
import {
  mcpTools,
  mcpAsTools,
  registerTool,
  defineTool,
  system,
  user,
  agentSystemPrompt,
  runAgent,
  agentTrace,
  openAIAgent,
} from "https://lumen-lang.org/package/std-contrib/ai/ai.ts";

let url = "http://127.0.0.1:8080/mcp";
let headers = new Map<string, string>();

// List the server's tools and adapt them into runnable AiTools.
let remote = mcpAsTools(url, headers, mcpTools(url, headers));

// Mix them with any local tools and hand the registry to runAgent.
let tools = remote;
tools = registerTool(
  tools,
  defineTool("clock", "The local time in a zone.", "zone name", (zone: string) => "12:00 in " + zone),
);

let history = [
  system(agentSystemPrompt(tools, "You are a helpful assistant.")),
  user("What is the weather in Paris?"),
];

let model = openAIAgent("sk-your-key", "gpt-4o-mini", tools);
let result = runAgent(model, tools, history, 6);

console.log(result.answer);
console.log(agentTrace(result));
```

To call a single MCP tool without an agent, use `mcpCall(url, headers, name,
argumentsJson)`; it returns an `ok` / `content` / `error` record. `mcpConnect`
performs the `initialize` handshake, and the request builders (`mcpConnectBody`,
`mcpListToolsBody`, `mcpCallBody`) plus parsers (`parseMcpTools`,
`parseMcpResult`) are exposed for building or reading JSON-RPC yourself.

Three transports are supported, all driving the same `runAgent`:

- **HTTP JSON-RPC** (`mcpConnect` / `mcpTools` / `mcpCall` / `mcpAsTools`) — one
  POST per call returning one complete JSON reply. Pass auth through `headers`.
- **stdio** (`mcpStdioConnect` / `mcpStdioTools` / `mcpStdioCall` /
  `mcpStdioAsTools` / `mcpStdioClose`) — spawn a local MCP server as a
  subprocess and exchange newline-delimited JSON-RPC over its stdin/stdout. The
  session stays live across calls, and the reader matches replies by id so a
  server's startup banner or stray blank lines can't desync it.
- **SSE / streamable HTTP** (`mcpSseTools` / `mcpSseCall` / `mcpSseAsTools`) —
  for servers whose replies stream as chunked Server-Sent Events, over a raw TCP
  socket. Plain `http://` only: `net.connect` has no TLS, so use localhost or a
  server behind a terminating proxy.

```ts
// stdio: spawn a server and give its tools to the agent
let session = mcpStdioConnect("npx", ["-y", "@modelcontextprotocol/server-everything"]);
let tools = mcpStdioAsTools(session, mcpStdioTools(session));
let result = runAgent(openAIAgent(apiKey, "gpt-4o", tools), tools, history, 8);
mcpStdioClose(session);
```

See `examples/support-agent/` for runnable HTTP, stdio, and SSE examples.

## Context compression

A long conversation eventually costs more to resend than it is worth. Compression
folds the older turns into a running summary **on demand** — the app checks a
budget and compresses only when it is exceeded:

```ts
let summarize = summarizer(modelConfig({
  provider: "mistral", model: "mistral-large-latest", apiKey: apiKey,
}));

if (needsCompression(history, 8000)) {
  history = compressHistory(summarize, history, 4);   // keep the last 4 turns
}
// or, the same thing guarded in one call:
history = compressIfNeeded(summarize, history, 8000, 4);
```

The result is `[your system prompt, a summary message, ...the recent turns]`. An
existing summary is folded forward rather than re-summarised, so compressing
repeatedly keeps one running summary instead of nesting them.

Two safety properties matter in practice:

- **A failed summarizer never destroys the conversation.** If the model call
  fails or is rate-limited and returns nothing, the history is returned
  unchanged.
- **Your system prompt survives.** Only the conversation turns are folded.

The summarizer is an injected `(prompt: string) => string`, so the memory module
does no I/O and is testable with a deterministic fake; the provider-backed
`summarizer(cfg)` is the convenience — one function, since which provider to call is already a field of the config.

## Structured output

Ask a provider for JSON that conforms to a schema and get a validated result
instead of free text. Lumen has no runtime reflection, so a schema is described
with explicit fields:

```ts
let fields = [
  schemaField("name", "string", "the person's full name", true),
  schemaField("age", "integer", "age in years", true),
  schemaField("city", "string", "city of residence", true),
];
let schema = objectSchema(fields);

let r = structuredChat("mistral", apiKey, "mistral-large-latest",
                       [user("Invent a person from Lisbon.")],
                       "person", schema, schemaRequired(fields));
if (r.ok) { let p = JSON.parse<Person>(r.json); }
else      { console.log(r.error); }
```

**The two provider modes are not equivalent**, and the difference bites:

- **Schema mode** (`response_format: {"type":"json_schema", strict: true}`)
  constrains the *shape*. Verified against OpenAI and Mistral.
- **JSON mode** (`{"type":"json_object"}`) only guarantees the reply *parses*.
  Probed against Mistral, asking for name/age/city in JSON mode returned
  `{"person":{...}}` — valid JSON, wrong shape.

So `structuredChat` uses schema mode for `openai` and `mistral`. For the many
OpenAI-compatible endpoints that accept only JSON mode (Groq, Together,
OpenRouter, Ollama, ...), `structuredJsonMode` states the schema in the prompt
and validates the reply locally with `validateStructured`, which reports every
missing field so you can drive a `structuredRetryPrompt`.

`validateStructured` is a top-level presence check, not a full JSON Schema
validator — it deliberately ignores a key that only appears nested or inside a
string value. Types and nested constraints are left to the provider's strict mode.

## Streaming

Read a reply as it is generated instead of waiting for it to finish. Each
`data:` line the provider sends becomes one normalized event, handed to your
handler the moment it arrives:

```ts
let stats = new Map<string, i64>();
stats.set("n", 0);

let onEvent: AiStreamHandler = (event: AiStreamEvent): void => {
  if (event.kind == "delta") {
    stats.set("n", (stats.get("n") ?? 0) + 1);
    console.log(event.delta);          // one piece of the answer
  }
};

let r = streamChat(mistral, [user("Name the planets.")], onEvent);
console.log(r.content);                // the whole reply, assembled
```

`event.kind` is `"delta"` (text in `event.delta`), `"done"` (the stream ended,
with `finishReason` when the provider sent one), `"other"` (a chunk carrying no
text — a role announcement or keep-alive), or `"error"` (a line that was not a
chunk, kept verbatim in `raw`). Every event carries `raw`, so a field this
record does not model is still reachable.

A handler assigned to a function type may read the variables it closes over but
not reassign them, which is why the counter above lives in a map.

`streamChat` returns the assembled reply as well as streaming it, so one call
serves both the live view and the final text. `streamChatCollect` drops the
handler when you want streaming's arrival behaviour but have nothing to do per
token, and `streamEvents`/`streamText` replay a captured body through the same
parser with no network — which is how the tests cover it.

OpenAI and Mistral send the same chunk shape, so one parser serves both.
Tool-call streaming is not covered yet: those arrive as fragments that must be
reassembled by index, which is its own slice.

## Token budget

Every provider call costs money, and an agent loop makes as many as its
stopping condition allows. `maxSteps` bounds tool dispatches; nothing bounds
tokens, and a long conversation or a large retrieved context can cost far more
than the step count suggests.

A budget is a ceiling plus a running total, checked before a call and charged
after one:

```ts
let b = budget(50000);

if (!budgetAllowsMessages(b, msgs)) {
  console.log(budgetRefusal(b, messagesCost(msgs)));   // says what was spent
} else {
  let reply = chat(cfg, msgs);
  b = chargeCall(b, msgs, reply.content);              // request and reply
}
```

`chargeCall` counts the reply as well as the request, since output tokens are
usually the more expensive half. A limit of 0 means unlimited, so a budget can
be threaded through code that does not always want one, and `budgetLeft`
reports `-1` there rather than a number that would look like zero remaining.

There is no wrapper that takes a model and returns a guarded one: a closure
here may read the values it captures but cannot call a function it received as
a parameter. The explicit form is three lines and shows where the money goes.

**Counts are estimates.** There is no tokenizer in this package, so
`estimateTokens` approximates at four characters per token — enough to stop a
runaway loop, not enough to reconcile against an invoice.

## Files

The package is grouped by concern; `ai.ts` at the root is the public barrel and
the only entry point consumers import.

```
ai.ts              public barrel — the package API
core/              provider-neutral schema: messages, request, result,
                   error, options, usage, headers, provider selection
providers/         openai.ts, mistral.ts, chat.ts, stream.ts
prompt/            prompt templates, output parsers, structured output
rag/               vector maths, documents, splitting, loading,
                   embeddings, store, retrieval
memory/            conversation memory, persistence, context compression
agent/             tools, tool-call JSON, the tool round trip, the agent loop
mcp/               client.ts (HTTP), stdio.ts, sse.ts
examples/          runnable examples, incl. examples/support-agent/
```

Tests live beside the code they cover as `*.test.ts` — `rag/vector.test.ts`
covers `rag/vector.ts`. Run one file, or the whole package:

```sh
lumen test packages/ai/rag/vector.test.ts   # one module
sh packages/ai/run-tests.sh                 # all of them
```

A module exporting a helper only so its test file can reach it is deliberate:
a module's exports are not the package's API — only what `ai.ts` re-exports is
public.

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

Retrieval, embeddings, memory, tools, splitting, loading, and the agent loop now
ship. What is still missing:

- token streaming ships, but tool-call streaming does not: a streamed tool call
  arrives as fragments that must be reassembled by index
- MCP over SSE is plain `http://` only (`net.connect` has no TLS); point it at
  localhost or a server behind a terminating proxy
- no multimodal or chunk-list response content; V1 expects string `content`
- a tool takes one string and returns one string; no typed tool arguments yet
- a tool body cannot throw, because the compiler rejects a throwing function in
  the registry's `run` field; report failures by returning text
- no middleware or guardrail hooks beyond the tool allow/deny policy
- no model retry policy and no tool retry policy
- no checkpoint, resume, or rewind of a partly finished agent run
- no human-in-the-loop pause before a sensitive tool
- splitting measures in bytes; token-based splitting would need a tokenizer,
  which this package does not have, so a byte budget is a proxy for the token
  limit an embedding endpoint actually enforces
- loaders read plain text only: no PDF, DOCX, HTML or CSV parsing, and directory
  matching is by extension with no globbing
- no dynamic schema validation
- no provider-specific SDKs
- no automatic retries
- no response-header inspection
- the built-in vector store is in-memory only: it is rebuilt on every start, so
  a service re-embeds its corpus each boot. The `pgvector` package in this
  repository keeps vectors in PostgreSQL instead, so an index survives a restart
  and unchanged text is not embedded twice
- `hashEmbedding` is a hashing bag of words, not a semantic model; real
  similarity needs provider embeddings through `embedText`
- no stemming, no stop-word list, and no re-ranking in the keyword retriever
- summary memory builds the prompt but does not call a model for you

These are natural follow-ups as Lumen grows richer JSON value support and more
runtime primitives. Streaming was one of them until `http.stream` landed.

Test:

```sh
lumen test packages/ai/ai.ts
```

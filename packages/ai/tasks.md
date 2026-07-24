# Tasks: Lumen AI Package Roadmap

## M0: Baseline Hardening

- [x] Add OpenAI-compatible chat helper.
- [x] Add Mistral chat helper.
- [x] Add shared bearer JSON headers.
- [x] Add normalized result record.
- [x] Add prompt template helper.
- [x] Add live Mistral example.
- [x] Load Mistral key from `process.env` or local `.env`.
- [x] Ignore generated binaries and local `.env` files.
- [x] Add live-shaped Mistral parser test.
- [x] Add `spec.md` and `tasks.md` to README file list.
- [x] Decide whether examples should import other std-contrib packages.

## M1: Provider Core

- [x] Create provider-neutral request helper.
- [x] Create provider-neutral result helper.
- [x] Add provider error record.
- [x] Parse OpenAI-compatible error JSON.
- [x] Parse Mistral error JSON.
- [x] Parse token usage from OpenAI-compatible responses.
- [x] Parse token usage from Mistral responses.
- [x] Add model option helpers for temperature and max tokens.
- [x] Add stop sequence support.
- [x] Add provider selector for `openai`, `mistral`, and `openai-compatible`.
- [x] Add OpenAI live example using environment key.
- [x] Add local OpenAI-compatible example for Ollama or compatible gateway.

## M2: Prompting

- [x] Add chat prompt template renderer.
- [x] Add `systemTemplate`, `userTemplate`, and `assistantTemplate`.
- [x] Add missing variable detection.
- [x] Add unused variable detection.
- [x] Add partial template application.
- [x] Add prompt snapshot examples.
- [x] Add tests for repeated variables.
- [x] Add tests for missing variables.

## M3: Output Parsers

- [x] Add text parser.
- [x] Add line parser.
- [x] Add string list parser.
- [x] Add enum choice parser.
- [x] Add first fenced block extractor.
- [x] Add first JSON object extractor.
- [x] Add typed JSON parse result helper.
- [x] Add retry prompt helper for invalid output.
- [x] Add parser tests with malformed model output.

## M4: Structured Output

- [x] Add provider-native JSON mode body option where supported.
- [x] Add structured output result record.
- [x] Add validation status record (presence check + missing-field diagnostics).
- [ ] Add tool-strategy structured output plan.
- [x] Mistral structured output verified live (schema mode constrains the shape).
- [x] OpenAI-compatible path via structuredOpenAI / structuredWithBaseUrl, plus a
      JSON-mode fallback for endpoints without schema mode.

## M5: Tools

- [x] Add tool metadata record.
- [x] Add string-input/string-output tool function shape.
- [x] Add tool registry builder.
- [x] Add tool lookup by name.
- [x] Add tool dispatch result record.
- [x] Add tool error result record.
- [x] Add provider-neutral tool call record.
- [x] Parse OpenAI-compatible tool calls.
- [x] Parse Mistral tool calls.
- [x] Serialize tool definitions for OpenAI-compatible providers.
- [x] Serialize tool definitions for Mistral.
- [x] Add deterministic fake tool tests.
- [x] Carry the serialized tool definitions in the chat request bodies.
      `toolchat.ts` (`buildOpenAIToolBody` / `buildMistralToolBody`) splices the
      `serializeToolDefs` array into the chat body, omitting the field for an
      empty registry.
- [x] Add a provider adapter for the tool round trip. `toolchat.ts` emits native
      `tool_calls` on the assistant turn and a `tool_call_id` on each tool turn,
      and `agent.ts` `openAIAgent` / `mistralAgent` rebuild those turns from the
      loop's neutral history so `runAgent` drives a live provider unchanged.
- [ ] Add typed tool arguments. V1 tools take and return one string, and a tool
      body cannot throw because the compiler rejects a throwing function in the
      registry's `run` field.

## M6: Agent Loop

- [ ] Add agent input record. `runAgent` takes the model, the registry, the
      history, and the step budget as parameters; there is no single input
      record yet.
- [x] Add agent result record.
- [x] Add max-step loop.
- [x] Add stop condition for final assistant message.
- [x] Add stop condition for max steps reached.
- [x] Add tool execution step.
- [x] Append tool result messages.
- [x] Add intermediate step trace.
- [x] Add deterministic fake model driver for tests.
- [x] Add a stop condition for an unusable provider body. A response with no
      message object ends the run with `error` instead of retrying.
- [ ] Add one-tool agent example. README carries a runnable offline snippet; no
      `examples/` program yet.

## M7: Middleware And Guardrails

- [ ] Add before-model middleware hook.
- [ ] Add after-model middleware hook.
- [ ] Add before-tool middleware hook.
- [ ] Add after-tool middleware hook.
- [ ] Add request redaction helper.
- [x] Add allowlist guard for tool names.
- [x] Add denylist guard for tool names.
- [x] Add token budget guard. `AiBudget` with a ceiling and a running total,
      checked before a call and charged after one. No wrapper that guards a
      model: a closure may read what it captures but cannot call a function it
      received as a parameter, so the explicit three-line form is the API.
- [ ] Add retry policy record.
- [ ] Add retry wrapper for transient provider errors.

## M8: Documents And Text Splitters

Shipped in the first pass:

- [x] Add document record. `AiDocument` with id, text, source, metadata.
- [x] Add document constructor helper. `makeDocument`.
- [x] Add fixed-size text splitter. `splitFixed`, byte budget, UTF-8 safe cuts.
- [x] Add overlapping text splitter. `splitFixed`'s overlap argument.
- [x] Add metadata string encoding helper. `documentMetadata` / `withMetadata`,
      escaped key-value encoding.
- [x] Add splitter tests for overlap and boundaries.

Still open. See spec.md 9a for the design and for what is deliberately not
copied from LangChain.

### Recursive splitting

- [x] Replace `splitRecursive`'s single-level best-break scan with the real
      recursive algorithm: pick the first separator present, split, recurse into
      any piece still over the limit with the remaining separators, emit a piece
      as-is once the separators run out.
- [x] Merge adjacent under-size pieces back up toward the size limit.
- [x] Apply overlap by byte count whenever overlap is configured and a chunk
      follows — including when every piece already fits, which LangChain skips
      (langchain#34804).
- [x] Keep a separator with the piece it terminates, not the piece that follows
      (langchain#18770 / langchainjs#5151 are the cost of the other choice).
- [x] Walk code point boundaries in the no-separator fallback, so a run of text
      with no break yields valid UTF-8.
- [x] Reject a size at or below the overlap.
- [x] Report an atomic piece that could not be divided. Implemented as a
      `forced` flag on the chunk plus a hard cut at a character boundary, rather
      than emitting an oversized chunk: an embedding endpoint rejects anything
      over its limit, so a chunk that respects the budget and admits the broken
      word is more useful than one that does neither.
- [x] Keep `splitFixed` and `splitParagraphs` as they are; only the recursive
      path changes.

### Provenance

- [x] Record each chunk's byte range as the split is made, not by searching for
      the chunk afterwards.
- [x] Carry the parent document's metadata into every chunk.
- [x] Record the chunk index and the source id on each chunk.
- [x] `splitDocument(doc, size, overlap)` splitting an `AiDocument` into
      `AiDocument`s, beside the existing text-to-documents entry point.

### Loaders

- [x] `loadText(text, source)` — the trivial case, so a caller assembling a
      document by hand does not hand-roll metadata.
- [x] `loadFile(path)` — read a file, record its path as the source, report an
      unreadable path rather than returning an empty document.
- [x] `loadDirectory(path, extensions, recursive)` — one document per matching
      file, recursion optional, unreadable entries reported. Extension matching
      only; no globbing.

### Language separators

- [x] Separator tables as plain data: markdown, and one code table covering
      brace languages.
- [x] `splitMarkdown` / `splitCode` as the recursive splitter with a table
      selected — a default argument, not a new type.

### Tests

- [x] A document of paragraphs splits at paragraph boundaries, with only
      over-long paragraphs broken down further.
- [x] Byte ranges index the original text exactly, for every chunk.
- [x] Overlap is present when configured and every piece already fits.
- [x] Overlap is the configured byte count, backed off to a character boundary.
- [x] Text that is entirely multi-byte yields valid UTF-8 in every chunk.
- [x] A single word longer than the size limit is reported, not cut.
- [x] Metadata survives a split, and chunk index and source id are present.
- [x] Markdown splits at headings; code splits at declarations.
- [x] Loading a missing file, and a directory holding an unreadable file, are
      both reported.
- [x] An empty file, an empty directory, and a file of only separators.

## M9: Embeddings

- [x] Add embedding request body helper.
- [x] Add OpenAI-compatible embeddings helper.
- [x] Add Mistral embeddings helper if API support is confirmed.
- [x] Add deterministic fake embedding helper for tests.
- [x] Add dot product helper.
- [x] Add vector norm helper.
- [x] Add cosine similarity helper.
- [x] Add batch embedding helper. `embedBatchOpenAI`, `embedBatchMistral`,
      `embedBatchWithBaseUrl` and `embedBatchWithConfig`. A response with fewer
      rows than inputs yields none rather than a partial list, since a partial
      one would pair vectors with the wrong chunks.
- [x] Add live embedding example behind environment key.
      `examples/embed-search.ts` ranks passages by cosine similarity over
      mistral-embed. Verified live: "what starts instantly?" ranks a passage
      sharing none of its words first (0.616) over one that is merely unrelated
      (0.546) — the match `hashEmbedding` cannot make.

## M10: Vector Stores And Retrievers

Persistence is covered by the `pgvector` package in this repository rather than
here: it keeps vectors in PostgreSQL, so an index survives a restart and text
that has not changed is not embedded again. The in-memory store below stays as
the dependency-free default.


- [x] Add in-memory vector store record.
- [x] Add document insertion helper.
- [x] Add vector insertion helper.
- [x] Add delete by ID helper.
- [x] Add top-k similarity search.
- [x] Add keyword retriever.
- [x] Add vector retriever.
- [x] Add metadata filter plan.
- [x] Add RAG context formatter.
- [ ] Add RAG example over local text. README carries a runnable snippet; no
      `examples/` program yet.

## M11: Memory

- [x] Add conversation buffer helper.
- [x] Add fixed-window memory helper.
- [x] Add summary memory plan.
- [x] Add key/value memory helper.
- [x] Add file-backed memory helper.
- [ ] Add retrieval-backed memory plan.
- [x] Add memory update tests.

## M12: Persistence And Checkpointing

- [ ] Add checkpoint record.
- [ ] Add checkpoint JSON serializer.
- [ ] Add checkpoint JSON parser.
- [ ] Add save checkpoint helper.
- [ ] Add load checkpoint helper.
- [ ] Add resume agent from checkpoint.
- [ ] Add rewind-to-step helper.
- [ ] Add checkpoint example.

## M13: Streaming

- [x] Track stdlib support for streaming HTTP responses. Landed as lumen spec
      452: `http.stream` returns a read handle over a response in progress.
- [x] Design provider-neutral stream event record. `AiStreamEvent` carries a
      `kind` discriminator (delta/done/other/error), the text `delta`, a
      `finishReason`, and the `raw` payload for anything the record omits.
- [x] Parse OpenAI-compatible stream events.
- [x] Parse Mistral stream events. Both wire formats send the same chunk shape,
      so one parser serves both and the entry points differ only by name.
- [x] Add callback/event handler API. `streamChat(cfg, messages, onEvent)`
      calls the handler per event and returns the assembled reply;
      `streamChatCollect` is the handler-free form.
- [x] Add streaming example. `examples/mistral-stream.ts` prints each delta with
      its arrival time — verified live against mistral-large-latest, first token
      at 410ms and 9 deltas over 685ms, which a buffered call cannot produce.

## M14: Human In The Loop

- [ ] Add approval request record.
- [ ] Add sensitive tool marker.
- [ ] Add pause-before-tool behavior.
- [ ] Add resume with approval.
- [ ] Add resume with denial.
- [ ] Add file-backed pause state.
- [ ] Add human-in-the-loop example.

## M15: Observability And Evaluation

- [ ] Add trace event record.
- [ ] Add run ID helper.
- [ ] Add timing helper using stdlib time.
- [ ] Add JSONL trace writer.
- [ ] Add exact match evaluator.
- [ ] Add contains evaluator.
- [ ] Add fixture-based eval runner.
- [ ] Add eval summary output.
- [ ] Add local trace example.

## M16: Integrations

- [x] Keep dotenv usage in examples only unless package policy changes.
- [ ] Add file document loader.
- [ ] Add HTTP fetch tool.
- [ ] Add filesystem read tool with explicit allowlist.
- [ ] Add shell command tool only behind explicit allowlist.
- [ ] Plan SQLite vector store integration once sqlite package is CI-friendly.
- [ ] Plan CSV/TOML document loaders.

## M17: MCP

- [x] Add JSON-RPC 2.0 request framing.
- [x] Add the `initialize` handshake over HTTP.
- [x] Add `tools/list` discovery over HTTP.
- [x] Add `tools/call` invocation over HTTP.
- [x] Parse tool descriptors (name, description, raw input schema) from a
      `tools/list` reply.
- [x] Parse a `tools/call` reply into an `ok`/`content`/`error` record.
- [x] Adapt an MCP tool descriptor into a first-class `AiTool` for
      `runAgent`.
- [x] Add offline tests over hand-written JSON-RPC bodies.
- [x] Add stdio transport (spec 450's persistent `child_process.spawn`): a live
      session over newline-delimited JSON-RPC, with id-matched reads that skip a
      server's banner/blank/notification lines.
- [x] Add SSE / streamable-HTTP transport over raw `net` sockets: a hand-written
      HTTP/1.1 client, chunked transfer decoding, and SSE frame parsing.
      (`http://` only — `net.connect` has no TLS.)

## Continuous Quality

- [ ] Keep `lumen test packages/ai/ai.ts` passing.
- [ ] Keep all AI implementation files individually compilable where possible.
- [ ] Keep pure-package suite passing.
- [ ] Add live tests only as opt-in examples.
- [ ] Document every provider's live environment variable.
- [ ] Avoid committing secrets or generated binaries.

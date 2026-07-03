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

- [ ] Add provider-native JSON mode body option where supported.
- [ ] Add structured output result record.
- [ ] Add validation status record.
- [ ] Add tool-strategy structured output plan.
- [ ] Add Mistral structured output example if supported by API.
- [ ] Add OpenAI-compatible structured output example if supported by API.

## M5: Tools

- [ ] Add tool metadata record.
- [ ] Add string-input/string-output tool function shape.
- [ ] Add tool registry builder.
- [ ] Add tool lookup by name.
- [ ] Add tool dispatch result record.
- [ ] Add tool error result record.
- [ ] Add provider-neutral tool call record.
- [ ] Parse OpenAI-compatible tool calls.
- [ ] Parse Mistral tool calls.
- [ ] Serialize tool definitions for OpenAI-compatible providers.
- [ ] Serialize tool definitions for Mistral.
- [ ] Add deterministic fake tool tests.

## M6: Agent Loop

- [ ] Add agent input record.
- [ ] Add agent result record.
- [ ] Add max-step loop.
- [ ] Add stop condition for final assistant message.
- [ ] Add stop condition for max steps reached.
- [ ] Add tool execution step.
- [ ] Append tool result messages.
- [ ] Add intermediate step trace.
- [ ] Add deterministic fake model driver for tests.
- [ ] Add one-tool agent example.

## M7: Middleware And Guardrails

- [ ] Add before-model middleware hook.
- [ ] Add after-model middleware hook.
- [ ] Add before-tool middleware hook.
- [ ] Add after-tool middleware hook.
- [ ] Add request redaction helper.
- [ ] Add allowlist guard for tool names.
- [ ] Add denylist guard for tool names.
- [ ] Add token budget guard.
- [ ] Add retry policy record.
- [ ] Add retry wrapper for transient provider errors.

## M8: Documents And Text Splitters

- [ ] Add document record.
- [ ] Add document constructor helper.
- [ ] Add text loader helper.
- [ ] Add file loader helper.
- [ ] Add fixed-size text splitter.
- [ ] Add overlapping text splitter.
- [ ] Add recursive character splitter.
- [ ] Add metadata string encoding helper.
- [ ] Add splitter tests for overlap and boundaries.

## M9: Embeddings

- [ ] Add embedding request body helper.
- [ ] Add OpenAI-compatible embeddings helper.
- [ ] Add Mistral embeddings helper if API support is confirmed.
- [ ] Add deterministic fake embedding helper for tests.
- [ ] Add dot product helper.
- [ ] Add vector norm helper.
- [ ] Add cosine similarity helper.
- [ ] Add batch embedding helper.
- [ ] Add live embedding example behind environment key.

## M10: Vector Stores And Retrievers

- [ ] Add in-memory vector store record.
- [ ] Add document insertion helper.
- [ ] Add vector insertion helper.
- [ ] Add delete by ID helper.
- [ ] Add top-k similarity search.
- [ ] Add keyword retriever.
- [ ] Add vector retriever.
- [ ] Add metadata filter plan.
- [ ] Add RAG context formatter.
- [ ] Add RAG example over local text.

## M11: Memory

- [ ] Add conversation buffer helper.
- [ ] Add fixed-window memory helper.
- [ ] Add summary memory plan.
- [ ] Add key/value memory helper.
- [ ] Add file-backed memory helper.
- [ ] Add retrieval-backed memory plan.
- [ ] Add memory update tests.

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

- [ ] Track stdlib support for streaming HTTP responses.
- [ ] Design provider-neutral stream event record.
- [ ] Parse OpenAI-compatible stream events.
- [ ] Parse Mistral stream events.
- [ ] Add callback/event handler API.
- [ ] Add streaming example once stdlib supports it.

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

## Continuous Quality

- [ ] Keep `lumen test packages/ai/ai.ts` passing.
- [ ] Keep all AI implementation files individually compilable where possible.
- [ ] Keep pure-package suite passing.
- [ ] Add live tests only as opt-in examples.
- [ ] Document every provider's live environment variable.
- [ ] Avoid committing secrets or generated binaries.

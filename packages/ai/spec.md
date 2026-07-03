# Feature Specification: Lumen AI Package

## Objective

Build `@lumen-lang/ai` into a Lumen-native AI application framework. The
package should demonstrate that Lumen can call model providers, compose prompts
and tools, run agent loops, retrieve context, and expose production-friendly
primitives without Node.js or a JavaScript runtime.

The package is not intended to mirror another framework's API. It should provide
the useful conceptual layers of modern AI applications while choosing typed,
deterministic APIs that fit Lumen's compiler, stdlib, and package model.

## Scope Inputs

- Common agent architecture: model plus tools plus prompt plus middleware.
- Tool interfaces: typed callable functions exposed to models.
- Model capabilities: text, tool calling, structured output, multimodality, and
  reasoning.
- Retrieval workflows: documents, text splitters, embeddings, vector stores, and
  retrievers.
- Runtime needs: persistence, streaming, human-in-the-loop, time travel,
  standard content blocks, and structured output.
- Orchestration needs: durable execution, streaming, human-in-the-loop, and
  persistence.
- Integration categories: chat models, embedding models, tools, middleware,
  checkpointers, retrievers, text splitters, vector stores, and document
  loaders.

## Current State

Implemented in V0:

- chat message helpers: `system`, `user`, `assistant`
- prompt template rendering
- OpenAI-compatible chat request and response helpers
- Mistral chat request and response helpers
- shared bearer JSON headers
- normalized result record
- live Mistral example using `MISTRAL_API_KEY` or `.env`

Current limitations:

- no streaming HTTP response handling
- no dynamic JSON value type
- exported type aliases are not supported by module imports
- module inlining means type aliases must avoid duplicate names
- no async package API yet
- no provider-native tool-call parser yet
- no vector database or embedding storage abstraction yet

## Design Principles

- Keep APIs typed and explicit.
- Prefer provider-agnostic primitives, then provider adapters.
- Keep all tests deterministic by default; live tests must be examples or
  opt-in scripts.
- Avoid hidden global state.
- Make each module independently compilable when possible.
- Treat stdlib gaps as explicit roadmap blockers, not reasons to overbuild.

## Capability Map

### 1. Core Schema

Define stable records and helpers for:

- messages
- model requests
- model responses
- generation options
- provider errors
- token usage
- content blocks
- tool calls
- documents
- embeddings
- retrieval results
- traces/events

Success criteria:

- Public functions can pass these records without exposing duplicate type alias
  conflicts.
- Tests cover serialization and parsing for each schema.

### 2. Model Providers

Support a consistent chat model interface across providers.

Initial providers:

- OpenAI-compatible endpoint
- Mistral

Planned providers:

- Anthropic
- Google Gemini
- OpenRouter
- Ollama/local OpenAI-compatible servers
- Azure OpenAI
- Groq
- Fireworks

Provider capabilities to track:

- chat completion
- model options
- max tokens
- temperature
- stop sequences
- token usage
- provider errors
- structured output mode
- tool calling mode
- streaming mode once stdlib supports it

Success criteria:

- `chat(provider, request)` style abstraction can select provider by string.
- Provider-specific modules remain directly usable.
- Provider tests use recorded/offline JSON unless marked live.

### 3. Prompting

Expand prompt helpers from simple `{{key}}` replacement into composable prompt
templates.

Features:

- string templates
- chat prompt templates
- system/user/assistant template helpers
- partial variable application
- missing variable diagnostics
- prompt examples
- prompt snapshots for tests

Success criteria:

- Prompt rendering is deterministic.
- Missing variables are detectable without throwing.

### 4. Output Parsers

Provide common parser helpers.

Features:

- text parser
- JSON parser over typed records
- first fenced-code-block extractor
- first JSON-object extractor
- line parser
- list parser
- enum/string-choice parser
- retry prompt builder for invalid output

Success criteria:

- Works without dynamic JSON.
- Gives clear fallback values and parse status.

### 5. Structured Output

Modern AI frameworks support structured output through provider-native
strategies and tool-call strategies. Lumen should start with typed JSON schemas
and explicit provider flags.

Features:

- typed JSON response helper
- provider-native JSON mode where available
- tool-strategy structured output later
- validation status record
- parse error diagnostics

Success criteria:

- A user can request a typed record response from Mistral or OpenAI-compatible
  models where supported.
- Invalid structured output produces a useful error record.

### 6. Tools

Tools are callable functions with names, descriptions, input schemas, and output
strings.

V1 constraints:

- Use string inputs and string outputs first.
- Add typed records once exported type support improves.

Features:

- tool metadata
- tool registry
- tool lookup by name
- tool dispatch
- tool result messages
- provider-specific tool-call JSON parsing
- tool error handling
- tool allow/deny policy

Success criteria:

- A model response can request a tool call.
- The package can dispatch the tool and append the result to messages.

### 7. Agents

An agent is a model calling tools in a loop until the task is done.

Features:

- `runAgent`
- max step limit
- stop conditions
- tool-call dispatch
- final answer extraction
- intermediate step trace
- model retry policy
- tool retry policy
- guardrail hooks

Success criteria:

- A deterministic fake model can drive an agent test through at least one tool
  call and final answer.

### 8. Middleware And Guardrails

Modern agent harnesses emphasize middleware around the model loop.

Features:

- before-model hook
- after-model hook
- before-tool hook
- after-tool hook
- request mutation
- response validation
- deny unsafe tool call
- redact secrets
- budget/token guard
- timeout/retry policy

Success criteria:

- Middleware can modify messages before a provider call.
- Guardrails can stop an agent step with a structured error.

### 9. Retrieval And RAG

Implement RAG primitives.

Features:

- `Document` record
- text splitter
- recursive character splitter
- simple metadata as normalized strings
- embedding request helpers
- in-memory vector store
- cosine similarity
- keyword retriever
- vector retriever
- contextual prompt builder

Success criteria:

- A user can split text, embed chunks, store vectors, retrieve top-k documents,
  and feed them to a chat model.

### 10. Embeddings

Features:

- OpenAI-compatible embeddings
- Mistral embeddings if available
- local deterministic test embedding model
- vector normalization
- cosine similarity
- batch embedding helper

Success criteria:

- Offline tests cover vector math with deterministic fake vectors.
- Live examples are opt-in with environment keys.

### 11. Memory

AI agents need both short-term conversation state and long-term memory.

Features:

- conversation buffer
- fixed-window memory
- summary memory
- key/value memory
- file-backed memory
- retrieval-backed memory

Success criteria:

- Agent/chat helpers can receive memory and produce updated memory.

### 12. Persistence And Checkpointing

Persistent agent execution needs resumable checkpoints.

Features:

- checkpoint record
- save/load checkpoint to file
- step log
- resume from checkpoint
- rewind to step

Success criteria:

- A multi-step agent can save state between steps and resume deterministically.

### 13. Streaming

Blocked on stdlib streaming HTTP responses.

Planned features:

- token streaming
- tool-call streaming
- reasoning/event streaming
- stream event parser
- callback interface

Success criteria:

- Once HTTP streaming is available, a provider stream can produce normalized
  event records.

### 14. Human In The Loop

Features:

- approval request record
- pause agent before sensitive tool
- resume with approval/denial
- file-backed pause state

Success criteria:

- An agent can stop before a tool call and resume with a supplied decision.

### 15. Observability And Evaluation

Cloud tracing platforms are outside std-contrib scope, but local observability
should exist.

Features:

- trace events
- run IDs
- timing using stdlib time
- token usage collection
- JSONL trace writer
- simple eval runner over fixtures
- exact match evaluator
- contains evaluator
- model-graded evaluator later

Success criteria:

- Examples can emit local trace JSONL without external services.

### 16. Integrations

Scope integrations carefully so the package remains portable.

Initial integrations:

- dotenv for examples
- file document loader
- text document loader
- CSV/TOML helpers later, if cross-package imports are acceptable

Future integrations:

- SQLite vector store if the sqlite package becomes available in CI
- HTTP tools
- filesystem tools
- shell tools behind explicit allowlist

Success criteria:

- Integrations remain optional and do not make core chat helpers harder to use.

## Milestones

### M0: Current Baseline

Status: mostly complete.

- OpenAI-compatible chat
- Mistral chat
- prompt templates
- live Mistral example
- dotenv-based example key loading

### M1: Provider Core

- normalize request/result records
- provider selector
- provider errors
- token usage
- live examples for OpenAI-compatible and Mistral

### M2: Prompt And Parser Core

- chat prompt templates
- missing-variable diagnostics
- text/JSON/list parsers
- structured parse records

### M3: Tools

- tool registry
- tool-call parser
- tool dispatcher
- provider tool-call adapters

### M4: Agent Loop

- deterministic agent loop
- max steps
- trace events
- tool errors
- middleware hooks

### M5: Retrieval

- documents
- splitters
- embeddings
- in-memory vector store
- retriever
- RAG prompt helper

### M6: Memory And Persistence

- buffer memory
- summary memory
- checkpoints
- resume/rewind

### M7: Production Extras

- guardrails
- evaluation runner
- JSONL traces
- human-in-the-loop
- streaming when stdlib enables it

## Non-Goals For Now

- compatibility with any external framework API
- npm package compatibility
- cloud tracing platform integration
- multi-modal binary payloads
- browser runtime support before stdlib HTTP and filesystem parity
- dynamic plugin loading

## Open Questions

- Should public type aliases wait until Lumen supports exported types?
- Should provider selection be string-based or function-based?
- Should cross-package imports from `dotenv`, `csv`, and `toml` be allowed in
  production package code or only examples?
- Should vector storage use plain arrays first or depend on future typed array
  support?
- Should live tests live in examples, scripts, or a `live/` folder?

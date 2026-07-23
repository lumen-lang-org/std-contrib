# Support agent — an end-to-end example project

A small, runnable project that ties four parts of the `ai` package together into
one working agent, with **no API key and no network**:

1. **RAG** — retrieve the relevant documentation passage for a question
2. **Tools** — expose that lookup as a tool the agent can call
3. **Agent** — a tool-calling loop that decides when to search
4. **Memory** — keep the conversation and persist it to disk

The model is a scripted `fakeModel`, so the whole thing compiles and runs offline.
Swapping that one line for `openAIAgent(key, model, tools)` or `mistralAgent(...)`
runs the identical loop against a real provider — the tools, RAG, memory, and agent
code do not change.

## Files

- `knowledge.ts` — an inline knowledge base and a keyword-RAG `lookupDocs(question)`
- `main.ts` — the full offline agent: tools + RAG + agent loop + persisted memory
- `mcp-tools.ts` — the same loop driven by an MCP server's tools (needs a live
  HTTP MCP endpoint; runs a guard message otherwise)

## Run it

```sh
# From the std-contrib repo root.
lumen compile packages/ai/examples/support-agent/main.ts
./main
```

Expected output: the agent calls `search_docs`, the keyword retriever returns the
passage about the native binary / garbage collector / install, the loop stops with
a final answer, and the conversation is saved to `/tmp/support-agent-history.json`
and restored.

## Try it against a real model

In `main.ts`, replace

```ts
let result = runAgent(fakeModel(script), tools, history, 5);
```

with

```ts
let result = runAgent(openAIAgent(apiKey, "gpt-4o", tools), tools, history, 5);
```

Everything else — the `search_docs` tool, the RAG lookup, the memory — stays the same.

## Try it with MCP tools

`mcp-tools.ts` lists an MCP server's tools, adapts each into a `LumenAiTool`, and
hands them to the same `runAgent`. It needs a Streamable-HTTP MCP endpoint:

```sh
MCP_URL=http://localhost:3000/mcp lumen compile packages/ai/examples/support-agent/mcp-tools.ts
./mcp-tools
```

The MCP client speaks HTTP JSON-RPC. stdio and SSE transports are tracked
separately in the package spec (M17).

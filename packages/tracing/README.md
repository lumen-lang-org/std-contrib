# tracing

OpenTelemetry traces for AI runs, over OTLP/HTTP. Tested against Langfuse's
attribute conventions and verified against the OpenTelemetry Collector.

## Why

An agent run is a tree: a chain calls a model, the model asks for a tool, the
tool answers, the model is called again. Without tracing you see the final
answer and a bill. With it you see which step was slow, which tool failed, and
where the tokens went.

## Why OTLP rather than Langfuse's own endpoint

Langfuse has a flat-JSON ingestion endpoint at `/api/public/ingestion` that is
easier to hand-build against. It is **deprecated in Langfuse's own API
specification**, which says to use the OpenTelemetry endpoint instead, and their
Python SDK already exports that way.

OTLP costs one extra layer of nesting and a typed attribute union. In exchange
the same exporter works against Langfuse, Phoenix, Braintrust, Honeycomb, and
any OpenTelemetry collector — and nanosecond timestamps are *easier* to produce
than ISO-8601, since there is no date arithmetic.

## Use

```ts
import { makeTracer, startSpan, endSpan, endGeneration, endTool, flush,
         TRACE_CHAIN, TRACE_GENERATION, TRACE_TOOL } from "./tracing.ts";

let t = makeTracer(
  "https://cloud.langfuse.com/api/public/otel/v1/traces",
  publicKey, secretKey, "my-agent");

let run = startSpan("support-agent", TRACE_CHAIN, "");

let call = startSpan("mistral-large", TRACE_GENERATION, run.id);
let reply = chat(cfg, messages);
t = endGeneration(t, call, "mistral-large-latest", 0.2, 512,
                  question, reply.content, inputTokens, outputTokens);

let tool = startSpan("weather", TRACE_TOOL, run.id);
t = endTool(t, tool, "Paris", "18C, clear", true);

t = endSpan(t, run, question, answer);

let sent = flush(t);
if (!sent.ok) { console.error(sent.error); }
```

`startSpan`'s third argument is the parent's id, or `""` for the root. Records
are immutable, so each `end*` returns a new tracer — thread it through the run
and flush the last one.

## API

| function | does |
| --- | --- |
| `makeTracer(endpoint, publicKey, secretKey, serviceName)` | open a trace |
| `tracerWithEnvironment(t, name)` / `tracerWithSession(t, sessionId, userId)` | attribution |
| `startSpan(name, kind, parentId)` | begin a span |
| `endSpan(t, span, input, output)` | close it |
| `endSpanFailed(t, span, input, message)` | close it as an error |
| `endGeneration(t, span, model, temperature, maxTokens, input, output, inTokens, outTokens)` | close a model call |
| `endTool(t, span, input, output, ok)` | close a tool dispatch |
| `traceBody(t)` | the OTLP document, for inspection |
| `flush(t)` | send it |
| `resetTracer(t)` | keep the settings, start a new trace |

Kinds: `TRACE_SPAN`, `TRACE_GENERATION`, `TRACE_TOOL`, `TRACE_CHAIN`,
`TRACE_AGENT`, `TRACE_RETRIEVER` — the observation types Langfuse renders.

## What LangChain-equivalent means here

LangChain's Langfuse handler maps `on_chain_start` to a chain span,
`on_llm_start` to a **generation** carrying model and parameters,
`on_tool_start` to a tool span, and errors to `level: ERROR` with a status
message. This package emits the same vocabulary — the difference is that you
call it rather than a callback doing it for you, which is the honest trade in a
language with no framework to hook into.

Every span also carries the standard `gen_ai.*` attributes
(`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`),
so a collector that knows nothing of Langfuse still classifies it correctly.

## Flushing

Spans are buffered for the run and sent in one request. That is not a
compromise: the Python and JS SDKs batch on a background thread to avoid
blocking, and with synchronous execution there is nothing to block. It also
removes the failure they need process-exit hooks to guard — the flush is a
statement in your program rather than a race with shutdown.

A failed flush returns `ok: false` with the collector's own response. It cannot
raise, so tracing never takes down the run it was watching.

## Verified

`lumen test packages/tracing/tracing.test.ts` covers the wire format offline —
29 tests over escaping, base64 vectors, id widths, span nesting, usage, and
error status.

The document was also posted to a real OpenTelemetry Collector
(`otel/opentelemetry-collector-contrib`), which accepted it with
`HTTP 200 {"partialSuccess":{}}` and decoded a five-span tree with correct
parents, `Status code: Error` on the failing span, and its message intact:

```
Trace ID       : 7d4faadda3774b92a728e1558d932fd1
Parent ID      : d62b5ea99c4df281
Name           : mistral-large
 -> langfuse.observation.type: Str(generation)
 -> langfuse.observation.usage_details: Str({"input":120,"output":18,"total":138})
 -> gen_ai.operation.name: Str(chat)
...
Status code    : Error
Status message : the provider returned 429 "rate limited"
```

Reproduce with:

```sh
docker run -d --name otelcol -p 4318:4318 \
  -v $PWD/otelcol.yaml:/etc/otelcol-contrib/config.yaml \
  otel/opentelemetry-collector-contrib:latest
curl -X POST http://127.0.0.1:4318/v1/traces \
  -H 'Content-Type: application/json' --data-binary @trace.json
```

Langfuse itself can be self-hosted for an end-to-end check: `docker compose up`
in their repository, with `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` and
`LANGFUSE_INIT_PROJECT_SECRET_KEY` set so keys exist without touching the UI.

## Limits

- **No sampling.** Every span is recorded and sent. At high volume that is
  bandwidth and storage you may not want.
- **No retry.** A failed flush loses the trace; it reports the failure rather
  than queuing.
- **Millisecond clock.** `Date.now()` is the source, so nanosecond timestamps
  end in six zeros. Ordering within a millisecond is not preserved.
- **No score events.** Langfuse scores use a separate ingestion path this does
  not implement.
- **No trace-level input and output.** Those ride on the root span, which
  Langfuse renders, but a dedicated trace object would carry them better.
- **Nesting is manual**: you pass the parent id. There is no implicit span
  stack, because a closure here cannot call a function it was handed, which is
  what an automatic context manager would need.

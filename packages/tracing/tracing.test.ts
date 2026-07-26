// The wire format, offline. Nothing here sends a request; what matters is that
// the document is valid JSON, that the OTLP shapes are exactly what a collector
// expects, and that ids are the widths the protocol fixes.

import { base64Encode, langfuseBackend, otlpBackend, phoenixBackend, braintrustBackend, langsmithBackend, arizeBackend, noBackend, backendNamed, hasDatasets, canSend, traceEndpointFor, otlpPathOf, WIRE_JSON, WIRE_PROTOBUF, ATTRS_OPENINFERENCE, ATTRS_NONE } from "./backend.ts";
import { openInferenceKind, makeTracer, tracerWithEnvironment, tracerWithSession, traceId, spanCount, startSpan, endSpan, endSpanFailed, endGeneration, endTool, traceBody, flush, resetTracer, jsonString, newTraceId, newSpanId, nowNanos, TRACE_SPAN, TRACE_GENERATION, TRACE_TOOL, TRACE_CHAIN, TRACE_AGENT, tracerSpans, tracerWithMoreSpans, tracerForCallee, noTracer, tracing } from "./tracing.ts";

function tracer(): Tracer {
  return makeTracer("http://127.0.0.1:9/v1/traces", "pk-lf-test", "sk-lf-test", "lumen-test");
}

// A minimal well-formedness check: every brace, bracket and quote balances,
// with escapes respected. A hand-built document that fails this is rejected by
// a collector before anything else is considered.
function balanced(s: string): bool {
  let depth: int = 0;
  let brackets: int = 0;
  let inString: bool = false;
  let escaped: bool = false;
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c == "\\") {
        escaped = true;
      } else if (c == "\"") {
        inString = false;
      }
    } else {
      if (c == "\"") { inString = true; }
      if (c == "{") { depth = depth + 1; }
      if (c == "}") { depth = depth - 1; }
      if (c == "[") { brackets = brackets + 1; }
      if (c == "]") { brackets = brackets - 1; }
      if (depth < 0 || brackets < 0) { return false; }
    }
    i = i + 1;
  }
  return depth == 0 && brackets == 0 && !inString;
}

// --- JSON escaping ------------------------------------------------------------

test("a plain string needs only quotes", () => {
  expect(jsonString("hello") == "\"hello\"");
});

test("quotes and backslashes are escaped", () => {
  expect(jsonString("a\"b") == "\"a\\\"b\"");
  expect(jsonString("a\\b") == "\"a\\\\b\"");
});

test("a newline is escaped, not passed through", () => {
  // A model reply carrying a raw newline is the usual way to produce an
  // invalid document.
  expect(jsonString("a\nb") == "\"a\\nb\"");
  expect(jsonString("a\tb") == "\"a\\tb\"");
  expect(jsonString("a\rb") == "\"a\\rb\"");
});

test("an escaped string stays balanced", () => {
  expect(balanced(jsonString("a\"b{c}[d]")));
  expect(balanced(jsonString("}}}]]]")));
});

// --- base64 --------------------------------------------------------------------

test("base64 matches the known vectors", () => {
  expect(base64Encode("") == "");
  expect(base64Encode("f") == "Zg==");
  expect(base64Encode("fo") == "Zm8=");
  expect(base64Encode("foo") == "Zm9v");
  expect(base64Encode("foob") == "Zm9vYg==");
  expect(base64Encode("fooba") == "Zm9vYmE=");
  expect(base64Encode("foobar") == "Zm9vYmFy");
});

test("a credential pair encodes as basic auth expects", () => {
  expect(base64Encode("pk:sk") == "cGs6c2s=");
});

// --- identifiers ------------------------------------------------------------------

test("a trace id is 32 hex characters and a span id is 16", () => {
  // OTLP fixes these widths; a collector rejects anything else.
  expect(newTraceId().length == 32);
  expect(newSpanId().length == 16);
});

test("ids are hexadecimal", () => {
  let id = newTraceId();
  let i: int = 0;
  while (i < id.length) {
    let c = id.charCodeAt(i);
    let isDigit = c >= 48 && c <= 57;
    let isLower = c >= 97 && c <= 102;
    expect(isDigit || isLower);
    i = i + 1;
  }
});

test("ids differ between calls", () => {
  expect(newTraceId() != newTraceId());
  expect(newSpanId() != newSpanId());
});

test("nanoseconds are far larger than milliseconds", () => {
  // A millisecond clock scaled to nanoseconds: the value must be in the
  // 10^18 range, not 10^12, or the collector places the span in 1970.
  expect(nowNanos() > 1700000000000000000);
});

// --- spans ---------------------------------------------------------------------

test("a fresh tracer has a trace id and no spans", () => {
  let t = tracer();
  expect(traceId(t).length == 32);
  expect(spanCount(t) == 0);
});

test("recording a span leaves the tracer it was given alone", () => {
  let t = tracer();
  let s = startSpan("step", TRACE_SPAN, "");
  let t2 = endSpan(t, s, "in", "out");
  expect(spanCount(t) == 0);
  expect(spanCount(t2) == 1);
});

test("a span carries its trace, its own id and its timings", () => {
  let t = tracer();
  let s = startSpan("retrieve", TRACE_SPAN, "");
  let body = traceBody(endSpan(t, s, "q", "docs"));
  expect(body.indexOf(traceId(t)) >= 0);
  expect(body.indexOf(s.id) >= 0);
  expect(body.indexOf("startTimeUnixNano") >= 0);
  expect(body.indexOf("endTimeUnixNano") >= 0);
  expect(body.indexOf("\"name\":\"retrieve\"") >= 0);
});

test("a child names its parent and a root does not", () => {
  let t = tracer();
  let root = startSpan("run", TRACE_CHAIN, "");
  let child = startSpan("call", TRACE_GENERATION, root.id);
  let body = traceBody(endSpan(endSpan(t, root, "", ""), child, "", ""));
  expect(body.indexOf("\"parentSpanId\":\"" + root.id + "\"") >= 0);
  // The root's own span carries no parent.
  expect(body.indexOf("\"parentSpanId\":\"\"") < 0);
});

test("the document is well formed with several spans", () => {
  let t = tracer();
  let root = startSpan("run", TRACE_CHAIN, "");
  let gen = startSpan("chat", TRACE_GENERATION, root.id);
  let tool = startSpan("weather", TRACE_TOOL, root.id);
  let t2 = endGeneration(t, gen, "mistral-large", 0.2, 512, "hi", "hello", 10, 4);
  let t3 = endTool(t2, tool, "Paris", "18C", true);
  let t4 = endSpan(t3, root, "q", "a");
  expect(spanCount(t4) == 3);
  expect(balanced(traceBody(t4)));
});

test("output containing braces and quotes keeps the document valid", () => {
  // A model that answers with JSON is the case that breaks a naive builder.
  let t = tracer();
  let s = startSpan("chat", TRACE_GENERATION, "");
  let nasty = "{\"answer\": \"it's \\\"quoted\\\"\"}\n[1,2]";
  expect(balanced(traceBody(endSpan(t, s, nasty, nasty))));
});

// --- kinds and levels -------------------------------------------------------------

test("a generation carries model, parameters and usage", () => {
  let t = tracer();
  let s = startSpan("chat", TRACE_GENERATION, "");
  let body = traceBody(endGeneration(t, s, "mistral-large-latest", 0.7, 1024, "in", "out", 120, 45));
  expect(body.indexOf("langfuse.observation.model.name") >= 0);
  expect(body.indexOf("mistral-large-latest") >= 0);
  expect(body.indexOf("\\\"temperature\\\":0.7") >= 0);
  expect(body.indexOf("usage_details") >= 0);
  expect(body.indexOf("\\\"input\\\":120") >= 0);
  expect(body.indexOf("\\\"total\\\":165") >= 0);
});

test("a generation also carries the standard opentelemetry attributes", () => {
  // These are what a collector that knows nothing of Langfuse classifies on.
  let t = tracer();
  let s = startSpan("chat", TRACE_GENERATION, "");
  let body = traceBody(endGeneration(t, s, "gpt-4o", 0.5, 256, "in", "out", 7, 3));
  expect(body.indexOf("\"gen_ai.operation.name\"") >= 0);
  expect(body.indexOf("\"chat\"") >= 0);
  expect(body.indexOf("gen_ai.usage.input_tokens") >= 0);
  // An integer attribute is carried as a string in OTLP's JSON mapping.
  expect(body.indexOf("\"intValue\":\"7\"") >= 0);
});

test("a failed span is marked error and says why", () => {
  let t = tracer();
  let s = startSpan("chat", TRACE_GENERATION, "");
  let body = traceBody(endSpanFailed(t, s, "in", "the provider returned 429"));
  // The message goes in OTLP's own status field as well as a Langfuse
  // attribute, so a collector that knows nothing of Langfuse still shows why.
  expect(body.indexOf("\"status\":{\"code\":2,\"message\":") >= 0);
  expect(body.indexOf("ERROR") >= 0);
  expect(body.indexOf("429") >= 0);
});

test("a successful span leaves its status unset", () => {
  let t = tracer();
  let s = startSpan("step", TRACE_SPAN, "");
  expect(traceBody(endSpan(t, s, "", "")).indexOf("\"status\"") < 0);
});

test("a failed tool is marked error, a successful one is not", () => {
  let t = tracer();
  let good = startSpan("weather", TRACE_TOOL, "");
  let bad = startSpan("weather", TRACE_TOOL, "");
  expect(traceBody(endTool(t, good, "Paris", "18C", true)).indexOf("\"code\":2") < 0);
  expect(traceBody(endTool(t, bad, "Paris", "no such city", false)).indexOf("\"code\":2") >= 0);
});

test("the observation type reaches the document", () => {
  let t = tracer();
  let s = startSpan("x", TRACE_TOOL, "");
  let body = traceBody(endTool(t, s, "", "", true));
  expect(body.indexOf("langfuse.observation.type") >= 0);
  expect(body.indexOf("\"tool\"") >= 0);
});

// --- resource and session ----------------------------------------------------------

test("the service name and environment ride on the resource", () => {
  let t = tracerWithEnvironment(tracer(), "staging");
  let s = startSpan("x", TRACE_SPAN, "");
  let body = traceBody(endSpan(t, s, "", ""));
  expect(body.indexOf("service.name") >= 0);
  expect(body.indexOf("lumen-test") >= 0);
  expect(body.indexOf("staging") >= 0);
});

test("session and user are repeated on every span", () => {
  // A collector filters span by span, so a value set only on the root would
  // not be found.
  let t = tracerWithSession(tracer(), "sess-1", "user-1");
  let a = startSpan("one", TRACE_SPAN, "");
  let b = startSpan("two", TRACE_SPAN, "");
  let body = traceBody(endSpan(endSpan(t, a, "", ""), b, "", ""));
  let first = body.indexOf("sess-1");
  expect(first >= 0);
  // Present twice, once per span.
  expect(body.indexOf("sess-1", first + 1) > first);
  expect(body.indexOf("user-1") >= 0);
});

test("an unset session is omitted rather than sent empty", () => {
  let t = tracer();
  let s = startSpan("x", TRACE_SPAN, "");
  expect(traceBody(endSpan(t, s, "", "")).indexOf("session.id") < 0);
});

// --- envelope and flush ---------------------------------------------------------

test("the envelope nests resource, scope and spans", () => {
  let t = tracer();
  let s = startSpan("x", TRACE_SPAN, "");
  let body = traceBody(endSpan(t, s, "", ""));
  expect(body.indexOf("\"resourceSpans\"") >= 0);
  expect(body.indexOf("\"scopeSpans\"") >= 0);
  expect(body.indexOf("\"spans\"") >= 0);
  expect(body.indexOf("\"kind\":1") >= 0);
});

test("flushing nothing makes no request", () => {
  // The endpoint is unroutable, so a request would fail — succeeding proves
  // none was made.
  let r = flush(tracer());
  expect(r.ok);
  expect(r.status == 0);
});

test("a failed flush reports the collector's answer", () => {
  let t = tracer();
  let s = startSpan("x", TRACE_SPAN, "");
  let r = flush(endSpan(t, s, "", ""));
  expect(!r.ok);
  expect(r.error.length > 0);
});

test("resetting keeps the settings and takes a new trace id", () => {
  let t = tracer();
  let s = startSpan("x", TRACE_SPAN, "");
  let used = endSpan(t, s, "", "");
  let fresh = resetTracer(used);
  expect(spanCount(fresh) == 0);
  expect(traceId(fresh) != traceId(used));
  expect(fresh.serviceName == used.serviceName);
  expect(fresh.backend.authValue == used.backend.authValue);
  expect(fresh.backend.name == used.backend.name);
});

// --- spans recorded elsewhere ---------------------------------------------------

test("a callee's spans can be folded into the caller's tracer", () => {
  // A sub-agent runs as a separate call and cannot hand a tracer back, because
  // records are immutable and its additions are on its own copy.
  let parent = makeTracer("http://collector", "pk", "sk", "svc");
  let root = startSpan("parent", TRACE_AGENT, "");
  parent = endSpan(parent, root, "in", "out");

  let child = makeTracer("http://collector", "pk", "sk", "svc");
  let below = startSpan("child", TRACE_AGENT, root.id);
  child = endSpan(child, below, "in", "out");
  expect(spanCount(child) == 1);

  let merged = tracerWithMoreSpans(parent, tracerSpans(child));
  expect(spanCount(merged) == 2);
  // And the child still names the parent it was opened under.
  expect(traceBody(merged).indexOf(root.id) >= 0);
});

test("folding in nothing changes nothing", () => {
  let t = makeTracer("http://collector", "pk", "sk", "svc");
  let none: string[] = [];
  expect(spanCount(tracerWithMoreSpans(t, none)) == 0);
});

test("a tracer that is not configured sends nothing", () => {
  // Tracing is off unless configured, and a caller should not have to ask:
  // the same code threads a real tracer or this one.
  let off = noTracer();
  expect(!tracing(off));
  expect(tracing(makeTracer("http://collector", "pk", "sk", "svc")));
  // Flushing it makes no request and reports no failure.
  expect(flush(off).ok);
});

test("a callee starts from an empty tracer in the same trace", () => {
  // Handing a callee your own tracer means it accumulates on top of your
  // spans and hands them back with its own — folding that in records
  // everything below the call twice. Observed as a duplicated sub-agent
  // subtree in a real run.
  let parent = makeTracer("http://collector", "pk", "sk", "svc");
  let root = startSpan("parent", TRACE_AGENT, "");
  parent = endSpan(parent, root, "in", "out");
  expect(spanCount(parent) == 1);

  let forChild = tracerForCallee(parent);
  expect(spanCount(forChild) == 0);
  // Same trace, or the child's work lands in a different tree entirely.
  expect(traceId(forChild) == traceId(parent));

  let below = startSpan("child", TRACE_AGENT, root.id);
  forChild = endSpan(forChild, below, "in", "out");
  let merged = tracerWithMoreSpans(parent, tracerSpans(forChild));
  expect(spanCount(merged) == 2);
});

// --- backends -----------------------------------------------------------------------

test("langfuse authenticates with basic and asks for its ingestion header", () => {
  let b = langfuseBackend("https://cloud.langfuse.com", "pk", "sk");
  expect(b.authHeader == "Authorization");
  // Against a value computed elsewhere, not against base64Encode itself: a
  // test that encodes the same string with the same function passes however
  // wrong the function is, and this header is the one thing a collector
  // refuses the whole trace over.
  expect(b.authValue == "Basic cGs6c2s=");
  // Without this header a trace can take minutes to appear.
  expect(b.extraHeaders.length == 1);
  expect(b.extraHeaders[0].name == "x-langfuse-ingestion-version");
  expect(b.attributeStyle == "langfuse");
  expect(hasDatasets(b));
});

test("a plain collector gets no vendor header and no vendor attributes", () => {
  let b = otlpBackend("http://collector:4318/v1/traces", "", "");
  expect(b.authHeader == "");
  expect(b.extraHeaders.length == 0);
  expect(b.attributeStyle == ATTRS_NONE);
  // And no datasets: that is not an OpenTelemetry concept, so there is nowhere
  // for evaluation cases to live.
  expect(!hasDatasets(b));
});

test("a backend is chosen by name, not sniffed from a url", () => {
  let lf = backendNamed("langfuse", "https://lf.example/api/public/otel/v1/traces", "pk", "sk");
  expect(lf.name == "langfuse");
  expect(lf.apiBase == "https://lf.example");

  // A collector with a token takes it as a bearer; one without takes no
  // header at all.
  let withToken = backendNamed("otlp", "http://c:4318/v1/traces", "", "tok");
  expect(withToken.authValue == "Bearer tok");
  expect(backendNamed("otlp", "http://c:4318/v1/traces", "", "").authHeader == "");

  // An unknown name sends nowhere rather than guessing.
  expect(backendNamed("something-else", "http://x", "", "").name == "none");
});

test("the trace url is the backend's, whichever way it was given", () => {
  let lf = langfuseBackend("https://lf.example", "pk", "sk");
  expect(traceEndpointFor(lf, "https://lf.example") == "https://lf.example/api/public/otel/v1/traces");
  // Already complete, so it is left alone rather than doubled.
  expect(traceEndpointFor(lf, "https://lf.example/api/public/otel/v1/traces") == "https://lf.example/api/public/otel/v1/traces");
  // A collector's path is its own and is never rewritten.
  let otel = otlpBackend("http://c:4318/v1/traces", "", "");
  expect(traceEndpointFor(otel, "http://c:4318/v1/traces") == "http://c:4318/v1/traces");
});

test("a plain collector still gets the standard attributes", () => {
  let t = makeTracerFor(otlpBackend("http://c:4318/v1/traces", "", ""), "http://c:4318/v1/traces", "svc");
  let s = startSpan("call", TRACE_TOOL, "");
  t = endSpan(t, s, "in", "out");
  let body = traceBody(t);
  expect(body.indexOf("otel.span.kind") >= 0);
  expect(body.indexOf("deployment.environment.name") >= 0);
  // And none of the vendor's.
  expect(body.indexOf("langfuse.") < 0);
});

test("langfuse still gets its own attributes", () => {
  let t = makeTracer("https://lf.example/api/public/otel/v1/traces", "pk", "sk", "svc");
  let s = startSpan("call", TRACE_TOOL, "");
  t = endSpan(t, s, "in", "out");
  let body = traceBody(t);
  expect(body.indexOf("langfuse.observation.type") >= 0);
  expect(body.indexOf("langfuse.observation.input") >= 0);
});

test("base64 matches known encodings, including both pad lengths", () => {
  // Checked against values from another implementation. Encoding a string and
  // comparing it to the same call proves nothing.
  expect(base64Encode("abc") == "YWJj");
  expect(base64Encode("ab") == "YWI=");
  expect(base64Encode("a") == "YQ==");
  expect(base64Encode("hello") == "aGVsbG8=");
  expect(base64Encode("pk-lf-lumen-demo:sk-lf-lumen-demo") == "cGstbGYtbHVtZW4tZGVtbzpzay1sZi1sdW1lbi1kZW1v");
});

// --- other backends ------------------------------------------------------------------

test("braintrust takes a bearer and a parent project", () => {
  let b = braintrustBackend("https://api.braintrust.dev", "sk-bt", "project_id:abc");
  expect(b.authValue == "Bearer sk-bt");
  expect(b.extraHeaders[0].name == "x-bt-parent");
  expect(b.extraHeaders[0].value == "project_id:abc");
  // It reads the standard GenAI conventions, so no vendor scheme is sent.
  expect(b.attributeStyle == ATTRS_NONE);
});

test("langsmith puts its key in its own header, not an authorization", () => {
  let b = langsmithBackend("https://api.smith.langchain.com", "lsv2-key", "my-project");
  expect(b.authHeader == "x-api-key");
  expect(b.authValue == "lsv2-key");
  expect(b.extraHeaders[0].name == "Langsmith-Project");
});

test("arize needs two headers, which is why extras are a list", () => {
  // The single-slot design could not express this: neither header is an
  // Authorization and both are required.
  let b = arizeBackend("https://otlp.arize.com/v1", "space-1", "key-1");
  expect(b.authHeader == "space_id");
  expect(b.authValue == "space-1");
  expect(b.extraHeaders.length == 1);
  expect(b.extraHeaders[0].name == "api_key");
});

test("a backend whose datasets we cannot read reports none", () => {
  // Braintrust and Phoenix both have datasets. This package speaks neither
  // dialect, and saying so beats aiming Langfuse's URLs at their hosts.
  expect(!hasDatasets(braintrustBackend("https://api.braintrust.dev", "k", "")));
  expect(!hasDatasets(phoenixBackend("http://localhost:6006/v1/traces", "")));
});

test("each backend's otlp path is appended once, or not at all", () => {
  expect(otlpPathOf("braintrust") == "/otel/v1/traces");
  expect(otlpPathOf("phoenix") == "");
  let bt = braintrustBackend("https://api.braintrust.dev", "k", "");
  expect(traceEndpointFor(bt, "https://api.braintrust.dev") == "https://api.braintrust.dev/otel/v1/traces");
  // Given whole, it is left alone rather than doubled.
  expect(traceEndpointFor(bt, "https://api.braintrust.dev/otel/v1/traces") == "https://api.braintrust.dev/otel/v1/traces");
});

// --- openinference --------------------------------------------------------------------

test("openinference names attributes by meaning, not by vendor", () => {
  let t = makeTracerFor(phoenixBackend("http://localhost:6006/v1/traces", ""), "http://localhost:6006/v1/traces", "svc");
  let s = startSpan("read_file", TRACE_TOOL, "");
  t = endSpan(t, s, "the input", "the output");
  let body = traceBody(t);
  // The kind is namespaced and capitalised; the values are not namespaced.
  expect(body.indexOf("\"openinference.span.kind\"") >= 0);
  expect(body.indexOf("\"TOOL\"") >= 0);
  expect(body.indexOf("\"input.value\"") >= 0);
  expect(body.indexOf("\"output.value\"") >= 0);
  // And nothing of the other vendor's.
  expect(body.indexOf("langfuse.") < 0);
});

test("a model call carries openinference token counts", () => {
  let t = makeTracerFor(phoenixBackend("http://localhost:6006/v1/traces", ""), "http://localhost:6006/v1/traces", "svc");
  let s = startSpan("gpt", TRACE_GENERATION, "");
  t = endGeneration(t, s, "mistral-small", 0.2, 512, "in", "out", 11, 22);
  let body = traceBody(t);
  expect(body.indexOf("\"llm.model_name\"") >= 0);
  expect(body.indexOf("\"llm.token_count.prompt\"") >= 0);
  expect(body.indexOf("\"llm.token_count.total\"") >= 0);
  expect(body.indexOf("\"33\"") >= 0);
  // A generation is an LLM span there, not a "generation".
  expect(body.indexOf("\"LLM\"") >= 0);
});

test("span kinds map onto openinference's fixed vocabulary", () => {
  expect(openInferenceKind(TRACE_GENERATION) == "LLM");
  expect(openInferenceKind(TRACE_TOOL) == "TOOL");
  expect(openInferenceKind(TRACE_AGENT) == "AGENT");
  expect(openInferenceKind(TRACE_RETRIEVER) == "RETRIEVER");
  // Nothing there is called "span"; a plain step is a chain.
  expect(openInferenceKind(TRACE_SPAN) == "CHAIN");
});

// --- what cannot be sent at all -------------------------------------------------------

test("a protobuf-only backend is refused before a request is made", () => {
  // Verified against a running Phoenix: it answers 415 to JSON and accepts the
  // same document as protobuf. That is not a misconfiguration to report as
  // one — the deployment and the credentials are fine and the encoding is not
  // something this package writes.
  let phoenix = phoenixBackend("http://localhost:6006/v1/traces", "");
  expect(phoenix.wire == WIRE_PROTOBUF);
  expect(!canSend(phoenix));

  let t = makeTracerFor(phoenix, "http://localhost:6006/v1/traces", "svc");
  let s = startSpan("x", TRACE_SPAN, "");
  t = endSpan(t, s, "", "");
  let sent = flush(t);
  expect(!sent.ok);
  expect(sent.status == 0);
  expect(sent.error.indexOf("only protobuf") >= 0);
  expect(sent.error.indexOf("phoenix") >= 0);
});

test("the json backends can send", () => {
  expect(canSend(langfuseBackend("http://lf", "pk", "sk")));
  expect(canSend(otlpBackend("http://c:4318/v1/traces", "", "")));
  expect(canSend(braintrustBackend("https://api.braintrust.dev", "k", "")));
  expect(canSend(langsmithBackend("https://api.smith.langchain.com", "k", "")));
});

test("an empty trace is not sent anywhere, whatever the backend", () => {
  // Nothing recorded is not a failure, and the encoding check must not turn it
  // into one.
  expect(flush(makeTracerFor(phoenixBackend("http://x", ""), "http://x", "svc")).ok);
});

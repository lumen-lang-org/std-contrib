// tracing -- OpenTelemetry traces for AI runs, over OTLP/HTTP.
//
// An agent run is a tree: a chain calls a model, the model asks for a tool, the
// tool returns, the model is called again. Without tracing you see the last
// answer and a bill. With it you see which step was slow, which tool failed,
// and where the tokens went.
//
// This speaks OTLP/HTTP with JSON-encoded protobuf, which Langfuse ingests at
// `/api/public/otel/v1/traces` — and so do Phoenix, Braintrust, Honeycomb and
// any OpenTelemetry collector. Langfuse's own flat-JSON ingestion endpoint is
// simpler to build against, but its API specification marks it deprecated and
// points here, and their SDK already exports this way.
//
// Spans are buffered for the run and sent in one request at the end. That is
// not the compromise it would be elsewhere: the SDKs batch on a background
// thread to avoid blocking, and with synchronous execution there is nothing to
// block. It also removes the failure they need process-exit hooks to handle,
// since the flush is a statement in your program rather than a race with
// shutdown.
//
// Run: lumen test packages/tracing/tracing.test.ts

import { TraceBackend, langfuseBackend, otlpBackend, noBackend, backendNamed, langfuseRootOf, base64Encode, traceEndpointFor, hasDatasets } from "./backend.ts";

// One in-flight span. `parentId` is "" for the root.
export type TraceSpan = {
  id: string,
  parentId: string,
  name: string,
  kind: string,
  startNs: i64,
};

// A run being traced. Records are immutable, so every call that records a span
// returns a new tracer; thread it through the run and flush the last one.
export type Tracer = {
  traceId: string,
  spans: string[],
  endpoint: string,
  // Which observability backend this goes to: how it authenticates, which
  // extra header it wants, and whose attribute namespace it reads. A string
  // of credentials was enough while there was one backend; naming the backend
  // is what stops the vendor being assumed in three separate files.
  backend: TraceBackend,
  serviceName: string,
  environment: string,
  sessionId: string,
  userId: string,
};

export type TraceResult = {
  ok: bool,
  status: int,
  error: string,
};

// Observation types Langfuse understands. Anything else is recorded as a plain
// span, which still shows in the tree.
export const TRACE_SPAN = "span";
export const TRACE_GENERATION = "generation";
export const TRACE_TOOL = "tool";
export const TRACE_CHAIN = "chain";
export const TRACE_AGENT = "agent";
export const TRACE_RETRIEVER = "retriever";

export const TRACE_DEFAULT = "DEFAULT";
export const TRACE_WARNING = "WARNING";
export const TRACE_ERROR = "ERROR";

// --- JSON -------------------------------------------------------------------

// A JSON string literal, with the escapes the format requires. Control
// characters below 0x20 must be escaped or the document is invalid, and a model
// reply carrying a raw newline is the common way to produce one.
export function jsonString(s: string): string {
  let out = "\"";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    let code = s.charCodeAt(i);
    if (c == "\"") {
      out = out + "\\\"";
    } else if (c == "\\") {
      out = out + "\\\\";
    } else if (code == 10) {
      out = out + "\\n";
    } else if (code == 13) {
      out = out + "\\r";
    } else if (code == 9) {
      out = out + "\\t";
    } else if (code == 8) {
      out = out + "\\b";
    } else if (code == 12) {
      out = out + "\\f";
    } else if (code < 32) {
      // Any other control byte, as a four-hex escape.
      out = out + "\\u00" + hexByte(code);
    } else {
      out = out + c;
    }
    i = i + 1;
  }
  return out + "\"";
}

function hexDigit(v: int): string {
  const digits = "0123456789abcdef";
  return digits.charAt(v);
}

function hexByte(v: int): string {
  return hexDigit(v / 16) + hexDigit(v % 16);
}

// --- base64 -----------------------------------------------------------------

export function newTraceId(): string {
  return crypto.randomBytes(16);
}

export function newSpanId(): string {
  return crypto.randomBytes(8);
}

// Nanoseconds since the epoch, as a decimal string. OTLP wants a 64-bit number
// carried as a string, and the clock here has millisecond resolution — so the
// last six digits are always zero, which is honest rather than invented
// precision.
export function nowNanos(): i64 {
  return Date.now() * 1000000;
}

function nanosText(ns: i64): string {
  return `${ns}`;
}

// --- attributes ---------------------------------------------------------------

// An OTLP attribute. Values are a typed union in the protobuf, so a string is
// `{"stringValue": ...}` rather than a bare JSON string.
function attrString(key: string, value: string): string {
  return "{\"key\":" + jsonString(key) + ",\"value\":{\"stringValue\":" + jsonString(value) + "}}";
}

function attrInt(key: string, value: int): string {
  // An integer attribute is carried as a string in OTLP's JSON mapping, since
  // JSON numbers cannot hold the full 64-bit range.
  return "{\"key\":" + jsonString(key) + ",\"value\":{\"intValue\":\"" + `${value}` + "\"}}";
}

function joinAttrs(attrs: string[]): string {
  let out = "";
  let i: int = 0;
  while (i < attrs.length) {
    if (i > 0) { out = out + ","; }
    out = out + attrs[i];
    i = i + 1;
  }
  return out;
}

// --- the tracer -----------------------------------------------------------------

// `endpoint` is the collector's trace URL. For Langfuse that is
// `https://cloud.langfuse.com/api/public/otel/v1/traces`, or the same path on a
// self-hosted instance.
export function makeTracer(endpoint: string, publicKey: string, secretKey: string, serviceName: string): Tracer {
  let none: string[] = [];
  let t: Tracer = {
    traceId: newTraceId(),
    spans: none,
    endpoint: endpoint,
    backend: langfuseBackend(langfuseRootOf(endpoint), publicKey, secretKey),
    serviceName: serviceName,
    environment: "production",
    sessionId: "",
    userId: "",
  };
  return t;
}

export function tracerWithEnvironment(t: Tracer, environment: string): Tracer {
  let out: Tracer = {
    traceId: t.traceId, spans: t.spans, endpoint: t.endpoint, backend: t.backend,
    serviceName: t.serviceName, environment: environment,
    sessionId: t.sessionId, userId: t.userId,
  };
  return out;
}

// A session groups several runs by the same person; a user id attributes them.
// Both are carried on every span, because a collector filters on spans and a
// value set only on the root would not be found.
export function tracerWithSession(t: Tracer, sessionId: string, userId: string): Tracer {
  let out: Tracer = {
    traceId: t.traceId, spans: t.spans, endpoint: t.endpoint, backend: t.backend,
    serviceName: t.serviceName, environment: t.environment,
    sessionId: sessionId, userId: userId,
  };
  return out;
}

export function traceId(t: Tracer): string {
  return t.traceId;
}

// The backend this tracer sends to. A caller doing more than sending spans —
// fetching evaluation cases, posting scores — needs to know where its API is
// and whether it has one.
export function tracerBackend(t: Tracer): TraceBackend {
  return t.backend;
}

// A tracer for a backend the caller has already chosen. `makeTracer` above is
// this with a Langfuse backend built from a public and secret key, kept
// because it is what every existing caller uses.
export function makeTracerFor(backend: TraceBackend, endpoint: string, serviceName: string): Tracer {
  let none: string[] = [];
  let t: Tracer = {
    traceId: newTraceId(),
    spans: none,
    endpoint: endpoint,
    backend: backend,
    serviceName: serviceName,
    environment: "production",
    sessionId: "",
    userId: "",
  };
  return t;
}

// The encoded spans recorded so far.
//
// A run that hands work to something running separately — a sub-agent, a
// worker — cannot pass a tracer back, because records are immutable and the
// callee's additions are on its own copy. It returns this instead, and the
// caller folds it in with `tracerWithMoreSpans`. Without that pair, the
// callee's spans are recorded and then dropped on the floor, which looks
// exactly like work that never happened.
export function tracerSpans(t: Tracer): string[] {
  return t.spans;
}

// Take spans recorded elsewhere into this tracer. They keep whatever parent
// they were opened with, so a child's tree hangs where it belongs.
export function tracerWithMoreSpans(t: Tracer, spans: string[]): Tracer {
  let all = t.spans;
  let i: int = 0;
  while (i < spans.length) {
    all = [...all, spans[i]];
    i = i + 1;
  }
  let out: Tracer = {
    traceId: t.traceId, spans: all, endpoint: t.endpoint, backend: t.backend,
    serviceName: t.serviceName, environment: t.environment,
    sessionId: t.sessionId, userId: t.userId,
  };
  return out;
}

// The same trace, with nothing recorded yet.
//
// What to hand a callee whose spans you will fold back in. Passing your own
// tracer instead means the callee accumulates on top of your spans and returns
// them with its own, and folding *that* in records everything below the call
// twice — a tree that looks plausible and is wrong. `resetTracer` is not this:
// it starts a new trace, which would leave the callee's work in a different
// tree altogether.
export function tracerForCallee(t: Tracer): Tracer {
  let none: string[] = [];
  let out: Tracer = {
    traceId: t.traceId, spans: none, endpoint: t.endpoint, backend: t.backend,
    serviceName: t.serviceName, environment: t.environment,
    sessionId: t.sessionId, userId: t.userId,
  };
  return out;
}

// A tracer that records nothing and sends nothing. Tracing is off unless it is
// configured, and every call site should be able to run without asking whether
// it is: an unconfigured tracer is threaded through exactly like a real one.
export function noTracer(): Tracer {
  let none: string[] = [];
  let t: Tracer = {
    traceId: "", spans: none, endpoint: "", backend: noBackend(),
    serviceName: "", environment: "", sessionId: "", userId: "",
  };
  return t;
}

// Whether this tracer would send anything.
export function tracing(t: Tracer): bool {
  return t.endpoint != "";
}

export function spanCount(t: Tracer): int {
  return t.spans.length;
}

// Open a span. `parentId` is "" for the root of the run.
export function startSpan(name: string, kind: string, parentId: string): TraceSpan {
  let s: TraceSpan = {
    id: newSpanId(),
    parentId: parentId,
    name: name,
    kind: kind,
    startNs: nowNanos(),
  };
  return s;
}

function withSpan(t: Tracer, encoded: string): Tracer {
  let out: Tracer = {
    traceId: t.traceId, spans: [...t.spans, encoded], endpoint: t.endpoint,
    backend: t.backend, serviceName: t.serviceName, environment: t.environment,
    sessionId: t.sessionId, userId: t.userId,
  };
  return out;
}

// The attributes every span carries, whatever its kind.
function baseAttrs(t: Tracer, span: TraceSpan, input: string, output: string, level: string, statusMessage: string): string[] {
  let attrs: string[] = [];
  // The standard attributes go to everyone: a collector that has never heard
  // of this program still shows the span's name, kind and timing.
  attrs = [...attrs, attrString("otel.span.kind", span.kind)];
  attrs = [...attrs, attrString("deployment.environment.name", t.environment)];

  // The vendor's namespace goes only to that vendor. Sending langfuse.* to a
  // plain OpenTelemetry collector is harmless and pointless, and it puts every
  // span's input and output on the wire a second time.
  let vendor = t.backend.vendorPrefix;
  if (vendor != "") {
    attrs = [...attrs, attrString(vendor + ".observation.type", span.kind)];
    attrs = [...attrs, attrString(vendor + ".environment", t.environment)];
    if (input != "") { attrs = [...attrs, attrString(vendor + ".observation.input", input)]; }
    if (output != "") { attrs = [...attrs, attrString(vendor + ".observation.output", output)]; }
    if (level != "" && level != TRACE_DEFAULT) {
      attrs = [...attrs, attrString(vendor + ".observation.level", level)];
    }
    if (statusMessage != "") {
      attrs = [...attrs, attrString(vendor + ".observation.status_message", statusMessage)];
    }
  }
  // Repeated on every span rather than the root alone: a collector filters
  // span by span, and the SDKs achieve this with a baggage processor that
  // copies these down the tree.
  if (t.sessionId != "") { attrs = [...attrs, attrString("session.id", t.sessionId)]; }
  if (t.userId != "") { attrs = [...attrs, attrString("user.id", t.userId)]; }
  return attrs;
}

function encodeSpan(t: Tracer, span: TraceSpan, endNs: i64, attrs: string[], isError: bool, statusMessage: string): string {
  let out = "{\"traceId\":" + jsonString(t.traceId)
    + ",\"spanId\":" + jsonString(span.id);
  if (span.parentId != "") {
    out = out + ",\"parentSpanId\":" + jsonString(span.parentId);
  }
  out = out + ",\"name\":" + jsonString(span.name)
    // kind 1 is INTERNAL: this is work inside the program, not an inbound or
    // outbound RPC as OTLP means those.
    + ",\"kind\":1"
    + ",\"startTimeUnixNano\":\"" + nanosText(span.startNs) + "\""
    + ",\"endTimeUnixNano\":\"" + nanosText(endNs) + "\""
    + ",\"attributes\":[" + joinAttrs(attrs) + "]";
  // Status codes: 0 unset, 1 ok, 2 error. Only error is worth stating; a span
  // that did not fail is left unset, as the specification prefers.
  //
  // The message goes in the status as well as in a Langfuse attribute: a
  // collector that knows nothing of Langfuse shows this field and would
  // otherwise report a failure with no reason attached.
  if (isError) {
    out = out + ",\"status\":{\"code\":2";
    if (statusMessage != "") {
      out = out + ",\"message\":" + jsonString(statusMessage);
    }
    out = out + "}";
  }
  return out + "}";
}

// Close a span and record it.
export function endSpan(t: Tracer, span: TraceSpan, input: string, output: string): Tracer {
  let attrs = baseAttrs(t, span, input, output, TRACE_DEFAULT, "");
  return withSpan(t, encodeSpan(t, span, nowNanos(), attrs, false, ""));
}

// Close a span that failed. The message is what a reader sees first when they
// open the trace, so it should say what went wrong rather than name a type.
export function endSpanFailed(t: Tracer, span: TraceSpan, input: string, message: string): Tracer {
  let attrs = baseAttrs(t, span, input, "", TRACE_ERROR, message);
  return withSpan(t, encodeSpan(t, span, nowNanos(), attrs, true, message));
}

// Close a model call, with the model's name, its settings and what it cost.
//
// Token counts go in `usage_details`. Langfuse's older `usage` field is
// deprecated in its own schema, and the newer one takes any keys, so a provider
// reporting something beyond input and output has somewhere to put it.
export function endGeneration(t: Tracer, span: TraceSpan, model: string, temperature: number, maxTokens: int, input: string, output: string, inputTokens: int, outputTokens: int): Tracer {
  let attrs = baseAttrs(t, span, input, output, TRACE_DEFAULT, "");
  let vendor = t.backend.vendorPrefix;
  if (vendor != "") {
    attrs = [...attrs, attrString(vendor + ".observation.model.name", model)];
    attrs = [...attrs, attrString(vendor + ".observation.model.parameters",
      "{\"temperature\":" + `${temperature}` + ",\"max_tokens\":" + `${maxTokens}` + "}")];
    attrs = [...attrs, attrString(vendor + ".observation.usage_details",
      "{\"input\":" + `${inputTokens}` + ",\"output\":" + `${outputTokens}`
      + ",\"total\":" + `${inputTokens + outputTokens}` + "}")];
  }
  // The standard OpenTelemetry attribute for a model call. A collector that
  // knows nothing of Langfuse still classifies the span correctly from this.
  attrs = [...attrs, attrString("gen_ai.operation.name", "chat")];
  attrs = [...attrs, attrString("gen_ai.request.model", model)];
  attrs = [...attrs, attrInt("gen_ai.usage.input_tokens", inputTokens)];
  attrs = [...attrs, attrInt("gen_ai.usage.output_tokens", outputTokens)];
  return withSpan(t, encodeSpan(t, span, nowNanos(), attrs, false, ""));
}

// Close a tool dispatch.
export function endTool(t: Tracer, span: TraceSpan, input: string, output: string, ok: bool): Tracer {
  let level = TRACE_DEFAULT;
  let message = "";
  if (!ok) {
    level = TRACE_ERROR;
    message = "the tool reported a failure";
  }
  let attrs = baseAttrs(t, span, input, output, level, message);
  attrs = [...attrs, attrString("gen_ai.operation.name", "execute_tool")];
  attrs = [...attrs, attrString("gen_ai.tool.name", span.name)];
  return withSpan(t, encodeSpan(t, span, nowNanos(), attrs, !ok, message));
}

// --- export --------------------------------------------------------------------

// The whole OTLP document for what has been recorded.
export function traceBody(t: Tracer): string {
  let spans = "";
  let i: int = 0;
  while (i < t.spans.length) {
    if (i > 0) { spans = spans + ","; }
    spans = spans + t.spans[i];
    i = i + 1;
  }
  return "{\"resourceSpans\":[{\"resource\":{\"attributes\":["
    + attrString("service.name", t.serviceName) + ","
    + attrString("deployment.environment.name", t.environment)
    + "]},\"scopeSpans\":[{\"scope\":{\"name\":\"lumen-ai\"},\"spans\":["
    + spans + "]}]}]}";
}

// Send what has been recorded. Returns without a request when nothing has been.
export function flush(t: Tracer): TraceResult {
  if (t.spans.length == 0) {
    let empty: TraceResult = { ok: true, status: 0, error: "" };
    return empty;
  }
  // The headers are the backend's, not this file's. A collector wanting no
  // credential gets no Authorization header rather than an empty one, and a
  // vendor's extra header is sent only to that vendor.
  let headers = new Map<string, string>();
  headers.set("Content-Type", "application/json");
  if (t.backend.authHeader != "") { headers.set(t.backend.authHeader, t.backend.authValue); }
  if (t.backend.extraHeader != "") { headers.set(t.backend.extraHeader, t.backend.extraValue); }

  let res = http.request(traceEndpointFor(t.backend, t.endpoint), "POST", traceBody(t), headers);
  if (res.status < 200 || res.status >= 300) {
    let failed: TraceResult = {
      ok: false,
      status: res.status,
      error: "the collector rejected the trace: " + res.body,
    };
    return failed;
  }
  let ok: TraceResult = { ok: true, status: res.status, error: "" };
  return ok;
}

// Drop what has been recorded, keeping the connection settings. Useful after a
// flush when a program traces several runs.
export function resetTracer(t: Tracer): Tracer {
  let none: string[] = [];
  let out: Tracer = {
    traceId: newTraceId(), spans: none, endpoint: t.endpoint, backend: t.backend,
    serviceName: t.serviceName, environment: t.environment,
    sessionId: t.sessionId, userId: t.userId,
  };
  return out;
}

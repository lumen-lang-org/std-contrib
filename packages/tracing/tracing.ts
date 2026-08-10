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

import { varint, fieldTag, bytesField, varintField, fixed64Field, bytesFromHex } from "./protobuf.ts";
import { TraceBackend, TraceHeader, langfuseBackend, otlpBackend, phoenixBackend, braintrustBackend, langsmithBackend, arizeBackend, noBackend, backendNamed, langfuseRootOf, base64Encode, traceEndpointFor, hasDatasets, canSend, WIRE_JSON, WIRE_PROTOBUF, ATTRS_LANGFUSE, ATTRS_OPENINFERENCE, ATTRS_NONE } from "./backend.ts";

// One in-flight span. `parentId` is "" for the root.
export type TraceSpan = {
  id: string,
  parentId: string,
  name: string,
  kind: string,
  startNs: i64,
};

// One attribute on a span, before it is encoded. Held as data rather than as
// finished JSON because the same span has to be written two ways: a receiver
// takes OTLP as JSON or as protobuf and may implement only one.
export type SpanAttr = {
  key: string,
  text: string,
  number: i64,
  isInt: bool,
};

// A finished span, still structured. What the tracer accumulates.
export type RecordedSpan = {
  traceId: string,
  id: string,
  parentId: string,
  name: string,
  startNs: i64,
  endNs: i64,
  attrs: SpanAttr[],
  isError: bool,
  statusMessage: string,
};

// A run being traced. Records are immutable, so every call that records a span
// returns a new tracer; thread it through the run and flush the last one.
export type Tracer = {
  traceId: string,
  spans: RecordedSpan[],
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

// An OTLP attribute. A typed union on the wire in both encodings, so which of
// the two values is meant is carried rather than inferred.
function attrString(key: string, value: string): SpanAttr {
  let a: SpanAttr = { key: key, text: value, number: 0, isInt: false };
  return a;
}

function attrInt(key: string, value: int): SpanAttr {
  let a: SpanAttr = { key: key, text: "", number: value, isInt: true };
  return a;
}

// One attribute in OTLP's JSON mapping. An integer is a *string* there, since
// JSON numbers cannot hold the full 64-bit range.
function attrJson(a: SpanAttr): string {
  if (a.isInt) {
    return "{\"key\":" + jsonString(a.key) + ",\"value\":{\"intValue\":\"" + `${a.number}` + "\"}}";
  }
  return "{\"key\":" + jsonString(a.key) + ",\"value\":{\"stringValue\":" + jsonString(a.text) + "}}";
}

function joinAttrs(attrs: SpanAttr[]): string {
  let out = "";
  let i: int = 0;
  while (i < attrs.length) {
    if (i > 0) { out = out + ","; }
    out = out + attrJson(attrs[i]);
    i = i + 1;
  }
  return out;
}

// --- the tracer -----------------------------------------------------------------

// `endpoint` is the collector's trace URL. For Langfuse that is
// `https://cloud.langfuse.com/api/public/otel/v1/traces`, or the same path on a
// self-hosted instance.
export function makeTracer(endpoint: string, publicKey: string, secretKey: string, serviceName: string): Tracer {
  let none: RecordedSpan[] = [];
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
  let none: RecordedSpan[] = [];
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
export function tracerSpans(t: Tracer): RecordedSpan[] {
  return t.spans;
}

// Take spans recorded elsewhere into this tracer. They keep whatever parent
// they were opened with, so a child's tree hangs where it belongs.
export function tracerWithMoreSpans(t: Tracer, spans: RecordedSpan[]): Tracer {
  let all: RecordedSpan[] = t.spans;
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
  let none: RecordedSpan[] = [];
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
  let none: RecordedSpan[] = [];
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

function withSpan(t: Tracer, encoded: RecordedSpan): Tracer {
  let out: Tracer = {
    traceId: t.traceId, spans: [...t.spans, encoded], endpoint: t.endpoint,
    backend: t.backend, serviceName: t.serviceName, environment: t.environment,
    sessionId: t.sessionId, userId: t.userId,
  };
  return out;
}

// The attributes every span carries, whatever its kind.
function baseAttrs(t: Tracer, span: TraceSpan, input: string, output: string, level: string, statusMessage: string): SpanAttr[] {
  let attrs: SpanAttr[] = [];
  // The standard attributes go to everyone: a collector that has never heard
  // of this program still shows the span's name, kind and timing.
  attrs = [...attrs, attrString("otel.span.kind", span.kind)];
  attrs = [...attrs, attrString("deployment.environment.name", t.environment)];

  // The vendor's scheme goes only to a backend that reads it. Sending one a
  // backend does not know is harmless and pointless, and it puts every span's
  // input and output on the wire a second time.
  let style = t.backend.attributeStyle;

  if (style == ATTRS_LANGFUSE) {
    attrs = [...attrs, attrString("langfuse.observation.type", span.kind)];
    attrs = [...attrs, attrString("langfuse.environment", t.environment)];
    if (input != "") { attrs = [...attrs, attrString("langfuse.observation.input", input)]; }
    if (output != "") { attrs = [...attrs, attrString("langfuse.observation.output", output)]; }
    if (level != "" && level != TRACE_DEFAULT) {
      attrs = [...attrs, attrString("langfuse.observation.level", level)];
    }
    if (statusMessage != "") {
      attrs = [...attrs, attrString("langfuse.observation.status_message", statusMessage)];
    }
    // The session and the person, which is what turns a heap of traces into
    // something you can navigate. Langfuse groups by session, so a caller that
    // sets one gets every turn of a conversation on one page and every trace
    // linkable back to the thread it came from.
    //
    // These are the reason `sessionId` and `userId` are on the Tracer at all.
    // They were carried on the struct from the beginning and NEVER PUT ON THE
    // WIRE, so a caller could set them, read them back, write a passing test,
    // and still send traces that grouped under nothing. Empty stays absent
    // rather than sending "", which Langfuse would take as a session whose id
    // is the empty string and group unrelated turns beneath it.
    if (t.sessionId != "") {
      attrs = [...attrs, attrString("langfuse.session.id", t.sessionId)];
    }
    if (t.userId != "") {
      attrs = [...attrs, attrString("langfuse.user.id", t.userId)];
    }
  }

  // OpenInference names attributes by what they mean rather than by who reads
  // them: the kind is namespaced, the input and output are not, and the kinds
  // themselves are a fixed vocabulary in capitals. None of that is reachable
  // by pasting a prefix, which is why the backend selects a scheme.
  if (style == ATTRS_OPENINFERENCE) {
    attrs = [...attrs, attrString("openinference.span.kind", openInferenceKind(span.kind))];
    if (input != "") {
      attrs = [...attrs, attrString("input.value", input)];
      attrs = [...attrs, attrString("input.mime_type", "text/plain")];
    }
    if (output != "") {
      attrs = [...attrs, attrString("output.value", output)];
      attrs = [...attrs, attrString("output.mime_type", "text/plain")];
    }
  }
  // Repeated on every span rather than the root alone: a collector filters
  // span by span, and the SDKs achieve this with a baggage processor that
  // copies these down the tree.
  if (t.sessionId != "") { attrs = [...attrs, attrString("session.id", t.sessionId)]; }
  if (t.userId != "") { attrs = [...attrs, attrString("user.id", t.userId)]; }
  return attrs;
}

function recordSpan(t: Tracer, span: TraceSpan, endNs: i64, attrs: SpanAttr[], isError: bool, statusMessage: string): RecordedSpan {
  let r: RecordedSpan = {
    traceId: t.traceId,
    id: span.id,
    parentId: span.parentId,
    name: span.name,
    startNs: span.startNs,
    endNs: endNs,
    attrs: attrs,
    isError: isError,
    statusMessage: statusMessage,
  };
  return r;
}

// One span in OTLP's JSON mapping.
function spanJson(span: RecordedSpan): string {
  let out = "{\"traceId\":" + jsonString(span.traceId)
    + ",\"spanId\":" + jsonString(span.id);
  if (span.parentId != "") {
    out = out + ",\"parentSpanId\":" + jsonString(span.parentId);
  }
  out = out + ",\"name\":" + jsonString(span.name)
    // kind 1 is INTERNAL: this is work inside the program, not an inbound or
    // outbound RPC as OTLP means those.
    + ",\"kind\":1"
    + ",\"startTimeUnixNano\":\"" + nanosText(span.startNs) + "\""
    + ",\"endTimeUnixNano\":\"" + nanosText(span.endNs) + "\""
    + ",\"attributes\":[" + joinAttrs(span.attrs) + "]";
  // Status codes: 0 unset, 1 ok, 2 error. Only error is worth stating; a span
  // that did not fail is left unset, as the specification prefers.
  //
  // The message goes in the status as well as in a Langfuse attribute: a
  // collector that knows nothing of Langfuse shows this field and would
  // otherwise report a failure with no reason attached.
  if (span.isError) {
    out = out + ",\"status\":{\"code\":2";
    if (span.statusMessage != "") {
      out = out + ",\"message\":" + jsonString(span.statusMessage);
    }
    out = out + "}";
  }
  return out + "}";
}

// Close a span and record it.
// What went into a span and what came out.
//
// Two adjacent strings positionally, and a transposition is invisible: the
// trace renders identically, just backwards.
export type SpanResult = {
  input: string,
  output: string,
};

export function endSpan(t: Tracer, span: TraceSpan, result: SpanResult): Tracer {
  let attrs = baseAttrs(t, span, result.input, result.output, TRACE_DEFAULT, "");
  return withSpan(t, recordSpan(t, span, nowNanos(), attrs, false, ""));
}

// Close a span that failed. The message is what a reader sees first when they
// open the trace, so it should say what went wrong rather than name a type.
// A failure is not a SpanResult: `message` is not an output, and swapping it
// with the input puts the user's prompt where the error headline goes — which
// is the first thing a reader sees when they open the trace.
export type SpanFailure = {
  input: string,
  message: string,
};

export function endSpanFailed(t: Tracer, span: TraceSpan, failure: SpanFailure): Tracer {
  let attrs = baseAttrs(t, span, failure.input, "", TRACE_ERROR, failure.message);
  return withSpan(t, recordSpan(t, span, nowNanos(), attrs, true, failure.message));
}

// What a model call cost and what went through it.
//
// A record, because the positional form had two adjacent same-typed pairs and
// both transpositions are silent. `input`/`output` swapped renders a trace
// where every call shows the reply as the prompt — the UI cannot tell, because
// both fields hold plausible prose. `inputTokens`/`outputTokens` swapped is
// worse: the total is their sum, so every aggregate still reconciles while the
// per-token cost is wrong, and output tokens are priced several times input.
export type GenerationCall = {
  model: string,
  temperature: number,
  maxTokens: int,
  input: string,
  output: string,
  inputTokens: int,
  outputTokens: int,
};

// Close a model call, with the model's name, its settings and what it cost.
//
// Token counts go in `usage_details`. Langfuse's older `usage` field is
// deprecated in its own schema, and the newer one takes any keys, so a provider
// reporting something beyond input and output has somewhere to put it.
export function endGeneration(t: Tracer, span: TraceSpan, call: GenerationCall): Tracer {
  let model = call.model;
  let temperature = call.temperature;
  let maxTokens = call.maxTokens;
  let inputTokens = call.inputTokens;
  let outputTokens = call.outputTokens;
  let attrs = baseAttrs(t, span, call.input, call.output, TRACE_DEFAULT, "");
  let style = t.backend.attributeStyle;
  if (style == ATTRS_LANGFUSE) {
    attrs = [...attrs, attrString("langfuse.observation.model.name", model)];
    attrs = [...attrs, attrString("langfuse.observation.model.parameters",
      "{\"temperature\":" + `${temperature}` + ",\"max_tokens\":" + `${maxTokens}` + "}")];
    attrs = [...attrs, attrString("langfuse.observation.usage_details",
      "{\"input\":" + `${inputTokens}` + ",\"output\":" + `${outputTokens}`
      + ",\"total\":" + `${inputTokens + outputTokens}` + "}")];
  }
  if (style == ATTRS_OPENINFERENCE) {
    attrs = [...attrs, attrString("llm.model_name", model)];
    attrs = [...attrs, attrString("llm.invocation_parameters",
      "{\"temperature\":" + `${temperature}` + ",\"max_tokens\":" + `${maxTokens}` + "}")];
    attrs = [...attrs, attrInt("llm.token_count.prompt", inputTokens)];
    attrs = [...attrs, attrInt("llm.token_count.completion", outputTokens)];
    attrs = [...attrs, attrInt("llm.token_count.total", inputTokens + outputTokens)];
  }
  // The standard OpenTelemetry attribute for a model call. A collector that
  // knows nothing of Langfuse still classifies the span correctly from this.
  attrs = [...attrs, attrString("gen_ai.operation.name", "chat")];
  attrs = [...attrs, attrString("gen_ai.request.model", model)];
  attrs = [...attrs, attrInt("gen_ai.usage.input_tokens", inputTokens)];
  attrs = [...attrs, attrInt("gen_ai.usage.output_tokens", outputTokens)];
  return withSpan(t, recordSpan(t, span, nowNanos(), attrs, false, ""));
}

// Close a tool dispatch.
export function endTool(t: Tracer, span: TraceSpan, result: SpanResult, ok: bool): Tracer {
  let input = result.input;
  let output = result.output;
  let level = TRACE_DEFAULT;
  let message = "";
  if (!ok) {
    level = TRACE_ERROR;
    message = "the tool reported a failure";
  }
  let attrs = baseAttrs(t, span, input, output, level, message);
  attrs = [...attrs, attrString("gen_ai.operation.name", "execute_tool")];
  attrs = [...attrs, attrString("gen_ai.tool.name", span.name)];
  return withSpan(t, recordSpan(t, span, nowNanos(), attrs, !ok, message));
}

// This package's span kinds in OpenInference's vocabulary, which is a fixed
// list in capitals. `span` has no equivalent and becomes CHAIN, which is what
// OpenInference calls a step that is neither a model call nor a tool.
export function openInferenceKind(kind: string): string {
  if (kind == TRACE_GENERATION) { return "LLM"; }
  if (kind == TRACE_TOOL) { return "TOOL"; }
  if (kind == TRACE_AGENT) { return "AGENT"; }
  if (kind == TRACE_RETRIEVER) { return "RETRIEVER"; }
  return "CHAIN";
}

// --- export --------------------------------------------------------------------

// The whole OTLP document for what has been recorded.
export function traceBody(t: Tracer): string {
  let spans = "";
  let i: int = 0;
  while (i < t.spans.length) {
    if (i > 0) { spans = spans + ","; }
    spans = spans + spanJson(t.spans[i]);
    i = i + 1;
  }
  let resource: SpanAttr[] = [
    attrString("service.name", t.serviceName),
    attrString("deployment.environment.name", t.environment),
  ];
  return "{\"resourceSpans\":[{\"resource\":{\"attributes\":["
    + joinAttrs(resource)
    + "]},\"scopeSpans\":[{\"scope\":{\"name\":\"lumen-ai\"},\"spans\":["
    + spans + "]}]}]}";
}

// The same document, protobuf-encoded.
//
// Field numbers are OTLP's, and they are not guessable: a receiver reads by
// number, so a wrong one is silently the wrong field rather than an error.
//   ExportTraceServiceRequest { resource_spans = 1 }
//   ResourceSpans { resource = 1, scope_spans = 2 }
//   Resource { attributes = 1 }
//   ScopeSpans { scope = 1, spans = 2 }
//   Span { trace_id=1 span_id=2 parent_span_id=4 name=5 kind=6
//          start=7 end=8 attributes=9 status=15 }
//   KeyValue { key = 1, value = 2 }
//   AnyValue { string_value = 1, int_value = 3 }
//   Status { message = 2, code = 3 }
export function traceBodyProtobuf(t: Tracer): string {
  let resource = bytesField(1, attrProto(attrString("service.name", t.serviceName)))
    + bytesField(1, attrProto(attrString("deployment.environment.name", t.environment)));

  let spans = "";
  let i: int = 0;
  while (i < t.spans.length) {
    spans = spans + bytesField(2, spanProto(t.spans[i]));
    i = i + 1;
  }

  let scope = bytesField(1, bytesField(1, "lumen-ai")) + spans;
  let resourceSpans = bytesField(1, resource) + bytesField(2, scope);
  return bytesField(1, resourceSpans);
}

// One attribute as a KeyValue.
function attrProto(a: SpanAttr): string {
  let value = "";
  if (a.isInt) {
    value = varintField(3, a.number);
  } else {
    value = bytesField(1, a.text);
  }
  return bytesField(1, a.key) + bytesField(2, value);
}

// One span. Ids go as the bytes their hex stands for, not as the hex: a
// receiver sent the text would record an id of twice the width, matching
// nothing and breaking every parent link.
function spanProto(span: RecordedSpan): string {
  let out = bytesField(1, bytesFromHex(span.traceId))
    + bytesField(2, bytesFromHex(span.id));
  if (span.parentId != "") {
    out = out + bytesField(4, bytesFromHex(span.parentId));
  }
  out = out + bytesField(5, span.name)
    // 1 is INTERNAL, as in the JSON encoding.
    + varintField(6, 1)
    + fixed64Field(7, span.startNs)
    + fixed64Field(8, span.endNs);

  let a: int = 0;
  while (a < span.attrs.length) {
    out = out + bytesField(9, attrProto(span.attrs[a]));
    a = a + 1;
  }

  if (span.isError) {
    let status = varintField(3, 2);
    if (span.statusMessage != "") { status = bytesField(2, span.statusMessage) + status; }
    out = out + bytesField(15, status);
  }
  return out;
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
  // The encoding is the backend's too. OTLP defines both mappings and a
  // receiver may implement one: Langfuse takes JSON, Phoenix takes only
  // protobuf and answers 415 to the other.
  let body = traceBody(t);
  let contentType = "application/json";
  if (t.backend.wire == WIRE_PROTOBUF) {
    body = traceBodyProtobuf(t);
    contentType = "application/x-protobuf";
  }

  let headers = new Map<string, string>();
  headers.set("Content-Type", contentType);
  if (t.backend.authHeader != "") { headers.set(t.backend.authHeader, t.backend.authValue); }
  let h: int = 0;
  while (h < t.backend.extraHeaders.length) {
    headers.set(t.backend.extraHeaders[h].name, t.backend.extraHeaders[h].value);
    h = h + 1;
  }

  let res = http.request(traceEndpointFor(t.backend, t.endpoint), "POST", body, headers);
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
  let none: RecordedSpan[] = [];
  let out: Tracer = {
    traceId: newTraceId(), spans: none, endpoint: t.endpoint, backend: t.backend,
    serviceName: t.serviceName, environment: t.environment,
    sessionId: t.sessionId, userId: t.userId,
  };
  return out;
}

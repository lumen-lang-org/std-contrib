// Which observability backend a trace is being sent to.
//
//   let lf = langfuseBackend("https://cloud.langfuse.com", "pk-...", "sk-...");
//   let otel = otlpBackend("http://collector:4318/v1/traces", "x-api-key", "...");
//
// The span document is OpenTelemetry and the same everywhere. What differs is
// the vendor's edges: how a request authenticates, which extra header it wants,
// which attribute namespace it reads, and whether it has anything like datasets
// and scores. Those four things are data, so they live in a record rather than
// in `if` statements spread across three files.
//
// Data rather than functions deliberately. What varies between backends here is
// a handful of strings; a record of closures would be harder to test, harder to
// read, and would not carry any more meaning.

// --- what a backend is ------------------------------------------------------------

// One header a backend requires beyond authentication. A list rather than a
// single pair because Arize AX wants `space_id` and `api_key` together, and a
// design with one slot would have had to pick which of them to honour.
export type TraceHeader = {
  name: string,
  value: string,
};

// How a backend names what a span carries.
//
// Not a prefix. The first version of this held `vendorPrefix` and pasted it in
// front of `.observation.input`, on the assumption that vendors differ by
// namespace and agree about shape. OpenInference disproves that: its names are
// `openinference.span.kind`, `input.value`, `output.value`, `llm.model_name` --
// four prefixes chosen by what the attribute *means*, not by who reads it. No
// amount of prefix substitution produces them, so what varies is the whole
// scheme and that is what this selects.
// How the body is encoded. OTLP defines both a JSON and a protobuf mapping and
// lets a receiver implement either; this package writes JSON, so a backend that
// takes only protobuf cannot be sent to at all.
//
// Found by sending to a real Phoenix, which answers
// `415 Unsupported content type: application/json` and accepts the same
// request as protobuf. No amount of attribute or header work reaches it — the
// gap is the encoding, and saying so beats a 415 from someone else's server.
export const WIRE_JSON = "json";
export const WIRE_PROTOBUF = "protobuf";

export const ATTRS_LANGFUSE = "langfuse";
export const ATTRS_OPENINFERENCE = "openinference";
export const ATTRS_NONE = "none";

export type TraceBackend = {
  // For diagnostics, and for a caller deciding whether a feature is available.
  name: string,

  // How a request proves who it is. `authHeader` is "" for a collector that
  // wants no credential at all — a local OpenTelemetry collector usually does
  // not, and sending an empty Authorization header to one is worse than
  // sending none.
  authHeader: string,
  authValue: string,

  // Headers a vendor requires beyond authentication: Langfuse's ingestion
  // version, Braintrust's parent project, LangSmith's project name. Empty for
  // a plain collector.
  extraHeaders: TraceHeader[],

  // Which encoding this backend accepts, one of the WIRE_ values above.
  wire: string,

  // Which naming scheme to emit beyond the standard `gen_ai.*`, one of the
  // ATTRS_ values above. Sending a scheme a backend does not read is harmless
  // and pointless, and it puts every span's input and output on the wire
  // twice.
  attributeStyle: string,

  // Where this backend's REST API lives, "" when it has none.
  apiBase: string,

  // Which dataset-and-scores API dialect this backend speaks *that this
  // package implements*, "" when none.
  //
  // Two different questions hide here and conflating them is a bug waiting to
  // happen: Phoenix has datasets, and this package cannot read them, so it
  // must report none rather than build Langfuse's URLs against a Phoenix host.
  // A backend gains a dialect when someone writes it, not when the vendor
  // ships one.
  datasetApi: string,
};

// --- the backends -----------------------------------------------------------------

export function traceHeader(name: string, value: string): TraceHeader {
  let h: TraceHeader = { name: name, value: value };
  return h;
}

// Langfuse, cloud or self-hosted. `base` is the instance root — the OTLP path
// and the API path are both derived from it, so a caller gives the address
// once and cannot point the two halves at different deployments.
export function langfuseBackend(base: string, publicKey: string, secretKey: string): TraceBackend {
  let root = withoutTrailingSlash(base);
  // Without this header Langfuse may take minutes to process a trace; with it
  // the trace is available as soon as it lands.
  let extras: TraceHeader[] = [traceHeader("x-langfuse-ingestion-version", "4")];
  let b: TraceBackend = {
    name: "langfuse",
    authHeader: "Authorization",
    authValue: "Basic " + base64Encode(publicKey + ":" + secretKey),
    extraHeaders: extras,
    wire: WIRE_JSON,
    attributeStyle: ATTRS_LANGFUSE,
    apiBase: root,
    datasetApi: "langfuse",
  };
  return b;
}

// Any OpenTelemetry collector. `endpoint` is the full trace URL, because
// collectors do not agree on a path the way a vendor's API does.
export function otlpBackend(endpoint: string, headerName: string, headerValue: string): TraceBackend {
  let none: TraceHeader[] = [];
  let b: TraceBackend = {
    name: "otlp",
    authHeader: headerName,
    authValue: headerValue,
    extraHeaders: none,
    wire: WIRE_JSON,
    attributeStyle: ATTRS_NONE,
    apiBase: "",
    datasetApi: "",
  };
  return b;
}

// Braintrust. A bearer token, and a header naming which project the trace
// belongs to — `project_id:...`, `project_name:...` or `experiment_id:...`,
// passed through as given because Braintrust decides what those prefixes mean.
//
// It reads the OpenTelemetry GenAI conventions, which every span here already
// carries, so no vendor scheme is emitted.
export function braintrustBackend(base: string, apiKey: string, parent: string): TraceBackend {
  let extras: TraceHeader[] = [];
  if (parent != "") { extras.push(traceHeader("x-bt-parent", parent)); }
  let b: TraceBackend = {
    name: "braintrust",
    authHeader: "Authorization",
    authValue: "Bearer " + apiKey,
    extraHeaders: extras,
    // Unverified: no account to send to. Its documentation describes an OTLP
    // endpoint without naming an encoding, and JSON is the assumption until
    // someone runs it.
    wire: WIRE_JSON,
    attributeStyle: ATTRS_NONE,
    apiBase: withoutTrailingSlash(base),
    // It has datasets and experiments; nobody has written that dialect here.
    datasetApi: "",
  };
  return b;
}

// LangSmith. The key is its own header rather than an Authorization, and the
// project is a second one.
export function langsmithBackend(base: string, apiKey: string, project: string): TraceBackend {
  let extras: TraceHeader[] = [];
  if (project != "") { extras.push(traceHeader("Langsmith-Project", project)); }
  let b: TraceBackend = {
    name: "langsmith",
    authHeader: "x-api-key",
    authValue: apiKey,
    extraHeaders: extras,
    // Unverified, like Braintrust.
    wire: WIRE_JSON,
    attributeStyle: ATTRS_NONE,
    apiBase: withoutTrailingSlash(base),
    datasetApi: "",
  };
  return b;
}

// Phoenix, and anything else reading OpenInference. A bearer token when the
// instance wants one — a local Phoenix usually does not.
export function phoenixBackend(endpoint: string, apiKey: string): TraceBackend {
  let none: TraceHeader[] = [];
  let auth = "";
  let value = "";
  if (apiKey != "") { auth = "Authorization"; value = "Bearer " + apiKey; }
  let b: TraceBackend = {
    name: "phoenix",
    authHeader: auth,
    authValue: value,
    extraHeaders: none,
    // Verified against a running Phoenix: JSON is refused with a 415 and the
    // same request in protobuf is accepted.
    wire: WIRE_PROTOBUF,
    attributeStyle: ATTRS_OPENINFERENCE,
    apiBase: "",
    datasetApi: "",
  };
  return b;
}

// Arize AX. Two headers, neither of them an Authorization — the reason
// `extraHeaders` is a list.
export function arizeBackend(endpoint: string, spaceId: string, apiKey: string): TraceBackend {
  let extras: TraceHeader[] = [traceHeader("api_key", apiKey)];
  let b: TraceBackend = {
    name: "arize",
    authHeader: "space_id",
    authValue: spaceId,
    extraHeaders: extras,
    // Inferred from sharing Phoenix's ingest stack, not verified — there is no
    // instance here to try. Marked protobuf so it refuses early rather than
    // discovering it at a 415.
    wire: WIRE_PROTOBUF,
    attributeStyle: ATTRS_OPENINFERENCE,
    apiBase: "",
    datasetApi: "",
  };
  return b;
}

// A backend that sends nowhere. What `tracerFor` hands back when tracing is
// not configured, so every call site threads a backend without asking whether
// there is one.
export function noBackend(): TraceBackend {
  let none: TraceHeader[] = [];
  let b: TraceBackend = {
    name: "none", authHeader: "", authValue: "",
    extraHeaders: none, wire: WIRE_JSON, attributeStyle: ATTRS_NONE,
    apiBase: "", datasetApi: "",
  };
  return b;
}

// The backend a name stands for, built from the settings a deployment holds.
//
// `endpoint` is the full trace URL in both cases. For Langfuse the API root is
// derived from it by removing the OTLP path — the two are the same deployment,
// and asking for the address twice is asking for them to disagree.
export function backendNamed(name: string, endpoint: string, publicKey: string, secretKey: string): TraceBackend {
  if (name == "langfuse") {
    return langfuseBackend(langfuseRootOf(endpoint), publicKey, secretKey);
  }
  if (name == "otlp") {
    // A collector wanting no credential leaves the key empty and gets no
    // header; one wanting a token gets it as a bearer, which is what almost
    // all of them take.
    if (secretKey == "") { return otlpBackend(endpoint, "", ""); }
    return otlpBackend(endpoint, "Authorization", "Bearer " + secretKey);
  }
  // `publicKey` is the second thing each of these needs, and what it means is
  // the backend's business: a project for Braintrust and LangSmith, a space
  // for Arize. One column rather than one per vendor, because a config row
  // should not grow a field every time a backend is added.
  if (name == "braintrust") { return braintrustBackend(rootOf(endpoint, "/otel/v1/traces"), secretKey, publicKey); }
  if (name == "langsmith") { return langsmithBackend(rootOf(endpoint, "/otel/v1/traces"), secretKey, publicKey); }
  if (name == "phoenix") { return phoenixBackend(endpoint, secretKey); }
  if (name == "arize") { return arizeBackend(endpoint, publicKey, secretKey); }
  return noBackend();
}

// A URL with a known suffix removed, for backends whose API root and trace
// path live on one host.
function rootOf(endpoint: string, suffix: string): string {
  let at = endpoint.indexOf(suffix);
  if (at < 0) { return withoutTrailingSlash(endpoint); }
  return endpoint.slice(0, at);
}

// The Langfuse instance root behind an OTLP trace URL.
//
// Exported because a caller that was handed only an endpoint — a config row
// written before backends were named, say — still needs to find the API.
export function langfuseRootOf(endpoint: string): string {
  let marker = "/api/public/otel/v1/traces";
  let at = endpoint.indexOf(marker);
  if (at < 0) { return withoutTrailingSlash(endpoint); }
  return endpoint.slice(0, at);
}

// Where a backend's traces are POSTed.
export function traceEndpointFor(backend: TraceBackend, endpoint: string): string {
  return withPath(endpoint, otlpPathOf(backend.name));
}

// The OTLP path each backend serves, "" for one whose endpoint is given whole.
export function otlpPathOf(name: string): string {
  if (name == "langfuse") { return "/api/public/otel/v1/traces"; }
  if (name == "braintrust") { return "/otel/v1/traces"; }
  if (name == "langsmith") { return "/otel/v1/traces"; }
  return "";
}

// An endpoint with the backend's path appended, unless it already carries it.
// A caller may give the instance root or the full URL; both are common, and
// doubling the path is the failure that follows from picking one.
function withPath(endpoint: string, path: string): string {
  if (path == "") { return endpoint; }
  if (endpoint.indexOf(path) >= 0) { return endpoint; }
  return withoutTrailingSlash(endpoint) + path;
}

// Whether this package can send to this backend at all. Both encodings are
// written now, so the only backend it cannot reach is one with no address.
export function canSend(backend: TraceBackend): bool {
  return backend.name != "none";
}

// Whether evaluation cases can be read from this backend.
//
// Both halves matter: an address to ask, and a dialect this package can speak.
// A backend with datasets we cannot read is the same as none, and saying so is
// better than building another vendor's URLs against its host.
export function hasDatasets(backend: TraceBackend): bool {
  return backend.apiBase != "" && backend.datasetApi != "";
}

function withoutTrailingSlash(url: string): string {
  let out = url;
  while (out.endsWith("/")) { out = out.slice(0, out.length - 1); }
  return out;
}

// --- base64, for Basic auth --------------------------------------------------------

// Kept here rather than imported so a backend is self-contained; tracing.ts
// re-exports the same function for callers that already used it.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(text: string): string {
  let out = "";
  let i: int = 0;
  while (i + 2 < text.length) {
    let n = text.charCodeAt(i) * 65536 + text.charCodeAt(i + 1) * 256 + text.charCodeAt(i + 2);
    out = out + B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
              + B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
    i = i + 3;
  }
  let left = text.length - i;
  if (left == 1) {
    let n = text.charCodeAt(i) << 16;
    out = out + B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + "==";
  } else if (left == 2) {
    let n = (text.charCodeAt(i) << 16) + (text.charCodeAt(i + 1) << 8);
    out = out + B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
              + B64.charAt((n >> 6) & 63) + "=";
  }
  return out;
}

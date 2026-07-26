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

export type TraceBackend = {
  // For diagnostics, and for a caller deciding whether a feature is available.
  name: string,

  // How a request proves who it is. `authHeader` is "" for a collector that
  // wants no credential at all — a local OpenTelemetry collector usually does
  // not, and sending an empty Authorization header to one is worse than
  // sending none.
  authHeader: string,
  authValue: string,

  // A second header a vendor requires. Langfuse wants
  // `x-langfuse-ingestion-version: 4`, without which a trace can take minutes
  // to appear; everyone else wants nothing.
  extraHeader: string,
  extraValue: string,

  // The attribute namespace this backend reads, without the trailing dot —
  // "langfuse" or "" for a backend that reads only the standard OpenTelemetry
  // `gen_ai.*` attributes. Emitting a vendor's attributes to a collector that
  // does not know them is harmless but pointless, and it puts the input and
  // output of every span on the wire twice.
  vendorPrefix: string,

  // Where this backend's REST API lives, "" when it has none.
  //
  // Datasets, dataset runs and scores are not an OpenTelemetry concept, so
  // there is no standard to target and a backend either has them or does not.
  // A caller checks this rather than assuming.
  apiBase: string,
};

// --- the backends -----------------------------------------------------------------

// Langfuse, cloud or self-hosted. `base` is the instance root — the OTLP path
// and the API path are both derived from it, so a caller gives the address
// once and cannot point the two halves at different deployments.
export function langfuseBackend(base: string, publicKey: string, secretKey: string): TraceBackend {
  let root = withoutTrailingSlash(base);
  let b: TraceBackend = {
    name: "langfuse",
    authHeader: "Authorization",
    authValue: "Basic " + base64Encode(publicKey + ":" + secretKey),
    // Without this header Langfuse may take minutes to process a trace; with
    // it the trace is available as soon as it lands.
    extraHeader: "x-langfuse-ingestion-version",
    extraValue: "4",
    vendorPrefix: "langfuse",
    apiBase: root,
  };
  return b;
}

// Any OpenTelemetry collector. `endpoint` is the full trace URL, because
// collectors do not agree on a path the way a vendor's API does.
//
// No datasets: `apiBase` is "", so evaluations report that this backend has
// nowhere to keep cases rather than building a URL that will 404.
export function otlpBackend(endpoint: string, headerName: string, headerValue: string): TraceBackend {
  let b: TraceBackend = {
    name: "otlp",
    authHeader: headerName,
    authValue: headerValue,
    extraHeader: "",
    extraValue: "",
    vendorPrefix: "",
    apiBase: "",
  };
  return b;
}

// A backend that sends nowhere. What `tracerFor` hands back when tracing is
// not configured, so every call site threads a backend without asking whether
// there is one.
export function noBackend(): TraceBackend {
  let b: TraceBackend = {
    name: "none", authHeader: "", authValue: "",
    extraHeader: "", extraValue: "", vendorPrefix: "", apiBase: "",
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
  return noBackend();
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
  if (backend.name == "langfuse") {
    if (endpoint.indexOf("/api/public/otel/v1/traces") >= 0) { return endpoint; }
    return withoutTrailingSlash(endpoint) + "/api/public/otel/v1/traces";
  }
  return endpoint;
}

// Whether this backend keeps datasets and scores.
export function hasDatasets(backend: TraceBackend): bool {
  return backend.apiBase != "";
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

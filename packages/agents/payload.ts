// What a request body says, decided without a database or a socket.
//
// These lived in api.ts, which calls `main()` at the bottom — importing it to
// test anything starts an HTTP server. So the parts that are decisions rather
// than plumbing are here, where a test can reach them.

import { Db } from "../plume/driver.ts";
import { DbRepository, existsById } from "../plume/plume.ts";
import { ScopeNode } from "./knowledge.ts";

// --- creating -------------------------------------------------------------------------

// An id read out of a posted document, so a create can answer with the whole
// row rather than the fragment it was given.
//
// Scanned rather than parsed, for the same reason the provider replies are:
// the document's shape is the caller's and no record type here declares it.
export function jsonId(document: string): string {
  let at = document.indexOf("\"id\"");
  if (at < 0) { return ""; }
  let rest = document.substring(at + 4, document.length);

  // Past the colon and any spacing. What follows must be a quote: an id that
  // is not a string is not an id, and reading on would find the next quoted
  // thing in the document — the following key — and take that instead.
  let i: int = 0;
  while (i < rest.length && (rest.charAt(i) == " " || rest.charAt(i) == ":"
      || rest.charAt(i) == "\n" || rest.charAt(i) == "\t" || rest.charAt(i) == "\r")) {
    i = i + 1;
  }
  if (i >= rest.length || rest.charAt(i) != "\"") { return ""; }

  let value = rest.substring(i + 1, rest.length);
  let close = value.indexOf("\"");
  if (close < 0) { return ""; }
  return value.substring(0, close);
}

// Why a POST cannot go ahead.
//
// `persist` is an upsert, so a POST to an id that exists overwrites it without
// a word. That is how a prompt's version 4 was replaced by another version 4
// while every agent pointing at it silently changed behaviour.
//
// So every create refuses a taken id, by name. Changing a row is what PUT is
// for, and for prompts the answer is a new version, which is a new id.
export function createProblem(db: Db, repo: DbRepository, document: string): string {
  if (document == "") { return "a body is required"; }
  let id = jsonId(document);
  if (id == "") { return "an \"id\" is required"; }
  if (existsById(db, repo, id)) {
    return "\"" + id + "\" already exists; a POST creates, and changing a row is a PUT";
  }
  return "";
}

// --- tracing --------------------------------------------------------------------------

// The backends this API will write into a trace_config row. Checked when it is
// set rather than at the tracer, because a typo that silently turns tracing off
// later is found by nobody.
export function backendOr(name: string): string {
  if (name == "") { return "langfuse"; }
  return name;
}

export function knownBackend(name: string): bool {
  return name == "langfuse" || name == "otlp" || name == "phoenix"
    || name == "braintrust" || name == "langsmith" || name == "arize";
}

// --- scopes ---------------------------------------------------------------------------

// A list of folders with their counts.
export function scopesJson(nodes: ScopeNode[]): string {
  let out = "[";
  let i: int = 0;
  while (i < nodes.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"path\":" + JSON.stringify(nodes[i].path)
      + ",\"documents\":" + `${nodes[i].documents}`
      + ",\"total\":" + `${nodes[i].total}` + "}";
    i = i + 1;
  }
  return out + "]";
}

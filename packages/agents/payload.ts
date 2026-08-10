import { Db } from "../plume/driver.ts";
import { DbRepository, existsById } from "../plume/plume.ts";
import { ScopeNode } from "./knowledge.ts";

export function jsonId(document: string): string {
  let at = document.indexOf("\"id\"");
  if (at < 0) { return ""; }
  let rest = document.substring(at + 4, document.length);

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

export function createProblem(db: Db, repo: DbRepository, document: string): string {
  if (document == "") { return "a body is required"; }
  let id = jsonId(document);
  if (id == "") { return "an \"id\" is required"; }
  if (existsById(db, repo, id)) {
    return "\"" + id + "\" already exists; a POST creates, and changing a row is a PUT";
  }
  return "";
}

export function backendOr(name: string): string {
  if (name == "") { return "langfuse"; }
  return name;
}

export function knownBackend(name: string): bool {
  return name == "langfuse" || name == "otlp" || name == "phoenix"
    || name == "braintrust" || name == "langsmith" || name == "arize";
}

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

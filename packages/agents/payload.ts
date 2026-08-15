import { Db } from "../plume/driver.ts";
import { DbRepository, countWhere } from "../plume/plume.ts";
import { ScopeNode } from "./routes/authoring/scopes/scope.utils.ts";

export function jsonId(document: string): string {
  let at = document.indexOf("\"id\"");
  if (at < 0) {
    return "";
  }
  let rest = document.substring(at + 4, document.length);

  let i: int = 0;
  while (i < rest.length && (rest.charAt(i) == " " || rest.charAt(i) == ":"
      || rest.charAt(i) == "\n" || rest.charAt(i) == "\t" || rest.charAt(i) == "\r")) {
    i = i + 1;
  }
  if (i >= rest.length || rest.charAt(i) != "\"") {
    return "";
  }

  let value = rest.substring(i + 1, rest.length);
  let close = value.indexOf("\"");
  if (close < 0) {
    return "";
  }
  return value.substring(0, close);
}

export function createFault(db: Db, repo: DbRepository, document: string): string {
  if (document == "") {
    return "a body is required";
  }
  let id = jsonId(document);
  if (id == "") {
    return "an \"id\" is required";
  }
  // countWhere rather than existsById, because existsById answers false both
  // for "no such row" and for "the query did not run", and this guard is the
  // only thing standing between a POST and persist's upsert. Unreadable, it
  // used to report no clash and the create would overwrite the row it was
  // meant to refuse.
  let held = countWhere(db, repo, repo.idColumn + " = " + db.placeholder, [id]);
  if (held < 0) {
    return "could not check whether \"" + id + "\" already exists";
  }
  if (held > 0) {
    return "\"" + id + "\" already exists; a POST creates, and changing a row is a PUT";
  }
  return "";
}

export function backendOr(name: string): string {
  if (name == "") {
    return "langfuse";
  }
  return name;
}

export function knownBackend(name: string): bool {
  return name == "langfuse" || name == "otlp" || name == "phoenix"
    || name == "braintrust" || name == "langsmith" || name == "arize";
}

type ScopeView = {
  path: string,
  documents: int,
  total: int,
};

function scopeView(node: ScopeNode): ScopeView {
  let view: ScopeView = { path: node.path, documents: node.documents, total: node.total };
  return view;
}

export function scopesJson(nodes: ScopeNode[]): string {
  return JSON.stringify(nodes.map(scopeView));
}

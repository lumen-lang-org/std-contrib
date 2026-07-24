// Loading documents from text and from the filesystem.
//
// Loaders are plain functions, not a class hierarchy with an overridable
// `parse` step: a format's loader is its own function, so a CSV row's index is
// named for what it is rather than inheriting a field called `line` from the
// text loader, which is the leak LangChain's shared base produced.
//
// Reading is synchronous, because Lumen's filesystem calls are.

import { makeDocument, withMetadata, AiDocument } from "./document.ts";

// A load that may have failed. `ok` false leaves `docs` empty and puts the
// reason in `error` — an unreadable file is reported rather than quietly
// contributing nothing to an index.
export type AiLoadResult = {
  ok: bool,
  docs: AiDocument[],
  error: string,
};

function loadOk(docs: AiDocument[]): AiLoadResult {
  let r: AiLoadResult = { ok: true, docs: docs, error: "" };
  return r;
}

function loadErr(message: string): AiLoadResult {
  let none: AiDocument[] = [];
  let r: AiLoadResult = { ok: false, docs: none, error: message };
  return r;
}

// The last path segment, for a readable document id.
function baseName(path: string): string {
  let cut: int = -1;
  let i: int = 0;
  while (i < path.length) {
    if (path.charAt(i) == "/") { cut = i; }
    i = i + 1;
  }
  if (cut < 0) { return path; }
  return path.slice(cut + 1, path.length);
}

// The extension including its dot, or "" when there is none. Matching is by
// extension only; there is no globbing.
export function fileExtension(path: string): string {
  let name = baseName(path);
  let cut: int = -1;
  let i: int = 0;
  while (i < name.length) {
    if (name.charAt(i) == ".") { cut = i; }
    i = i + 1;
  }
  if (cut <= 0) { return ""; }
  return name.slice(cut, name.length);
}

// A document from text already in hand. The trivial case, here so that a caller
// assembling one does not hand-roll the metadata every example otherwise
// repeats.
export function loadText(text: string, source: string): AiDocument {
  return makeDocument(source, text, source, "");
}

// A document from a file, recording its path as the source. A missing or
// unreadable path is reported.
export function loadFile(path: string): AiLoadResult {
  if (!fs.existsSync(path)) {
    return loadErr("no such file: " + path);
  }
  let text = fs.readFileSync(path);
  let doc = makeDocument(path, text, path, "");
  doc = withMetadata(doc, "name", baseName(path));
  let ext = fileExtension(path);
  if (ext != "") { doc = withMetadata(doc, "ext", ext); }
  let docs: AiDocument[] = [doc];
  return loadOk(docs);
}

function extensionAllowed(path: string, extensions: string[]): bool {
  if (extensions.length == 0) { return true; }
  let ext = fileExtension(path);
  let i: int = 0;
  while (i < extensions.length) {
    if (extensions[i] == ext) { return true; }
    i = i + 1;
  }
  return false;
}

function joinPath(dir: string, name: string): string {
  if (dir == "") { return name; }
  if (dir.endsWith("/")) { return dir + name; }
  return dir + "/" + name;
}

// One document per matching file. `extensions` filters by extension, including
// the dot (`[".md", ".txt"]`); an empty list takes every file. `recursive`
// descends into subdirectories.
//
// A file that cannot be read stops the load and is reported, rather than
// leaving a silent hole in an index that will later look merely incomplete.
export function loadDirectory(path: string, extensions: string[], recursive: bool): AiLoadResult {
  if (!fs.existsSync(path)) {
    return loadErr("no such directory: " + path);
  }
  let st = fs.statSync(path);
  if (!st.isDirectory) {
    return loadErr("not a directory: " + path);
  }
  let out: AiDocument[] = [];
  let names = fs.readdirSync(path);
  let i: int = 0;
  while (i < names.length) {
    let full = joinPath(path, names[i]);
    let entry = fs.statSync(full);
    if (entry.isDirectory) {
      if (recursive) {
        let sub = loadDirectory(full, extensions, recursive);
        if (!sub.ok) { return sub; }
        out = [...out, ...sub.docs];
      }
    } else {
      if (extensionAllowed(full, extensions)) {
        let one = loadFile(full);
        if (!one.ok) { return one; }
        out = [...out, ...one.docs];
      }
    }
    i = i + 1;
  }
  return loadOk(out);
}

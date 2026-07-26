// The files a conversation is working on.
//
//   putFile(db, threadId, "notes.md", "text/markdown", "uploaded", body, "");
//   ... the agent reads, writes and lists them with built-in tools ...
//   promoteFile(db, model, threadId, "notes.md", "/specs/notes", key);
//
// A file is current state with a name — unlike a turn, which is history, and
// unlike a document, which is chunks under an embedding. Three origins:
//
//   uploaded    the user brought it
//   generated   the model wrote it, with the write_file tool
//   retrieved   pulled in from the corpus; a pointer, not a copy
//
// Files are read whole. What makes them useful to an agent is not this table
// but the three tools the run offers when a thread has a workspace — the same
// mechanism that offers a child agent, so a file write is a tool span in the
// trace and a checkable expectation in an eval.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, asc, persist, findById, listOrdered, executeWith, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { ModelRow } from "./schema.ts";
import { Upload, uploadDocument } from "./knowledge.ts";

export type WorkspaceFileRow = {
  id: string,
  threadId: string,
  fileName: string,
  mime: string,
  // "uploaded" | "generated" | "retrieved"
  origin: string,
  body: string,
  // For a retrieved file: which document it points at. The body is still
  // stored — a pointer alone would break when the corpus re-indexes — but the
  // id says where it came from, which is what "why does the model think this"
  // needs.
  documentId: string,
  updatedAt: string,
};

export function workspaceFilesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("threadId", "thread_id", "text"),
    field("fileName", "file_name", "text"),
    field("mime", "mime", "text"),
    field("origin", "origin", "text"),
    field("body", "body", "text"),
    field("documentId", "document_id", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("workspace_files", "id", "id", fs);
}

export function workspacePlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("22", "workspace files", createTableSql(db, workspaceFilesMapping())),
    migration("23", "files by thread",
      "CREATE INDEX IF NOT EXISTS files_by_thread ON workspace_files (thread_id, file_name)"),
  ];
  return plan;
}

// --- reading and writing -----------------------------------------------------------

// A name a file may have. Rejecting separators is not fussiness: these names
// come from the model as tool arguments, and "../etc/passwd" as a file name
// should die here, not be filtered by everything that later touches one.
export function fileNameOk(name: string): bool {
  if (name == "" || name.length > 200) { return false; }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c == 95 || c == 45 || c == 46 || c == 32;
    if (!ok) { return false; }
    i = i + 1;
  }
  // Dots are for extensions, not for climbing.
  if (name.startsWith(".") || name.indexOf("..") >= 0) { return false; }
  return true;
}

// One row per (thread, name): writing a name that exists replaces it. Files
// are current state — nothing points at a workspace file, which is what made
// versioning prompts necessary and makes it dead weight here.
export function putFile(db: Db, threadId: string, fileName: string, mime: string, origin: string, body: string, documentId: string, now: string): string {
  if (!fileNameOk(fileName)) {
    return "a file name is letters, digits, dot, dash, underscore and space — not \"" + fileName + "\"";
  }
  if (origin != "uploaded" && origin != "generated" && origin != "retrieved") {
    return "origin must be uploaded, generated or retrieved";
  }
  let row: WorkspaceFileRow = {
    id: threadId + ":" + fileName,
    threadId: threadId,
    fileName: fileName,
    mime: mime,
    origin: origin,
    body: body,
    documentId: documentId,
    updatedAt: now,
  };
  let written = persist(db, workspaceFilesMapping(), JSON.stringify(row));
  if (!written.ok) { return written.error; }
  return "";
}

export function getFile(db: Db, threadId: string, fileName: string): WorkspaceFileRow {
  let absent: WorkspaceFileRow = {
    id: "", threadId: threadId, fileName: fileName, mime: "", origin: "",
    body: "", documentId: "", updatedAt: "",
  };
  let document = findById(db, workspaceFilesMapping(), threadId + ":" + fileName);
  if (document == "") { return absent; }
  return JSON.parse<WorkspaceFileRow>(document);
}

export function listFiles(db: Db, threadId: string): WorkspaceFileRow[] {
  let none: WorkspaceFileRow[] = [];
  let keys: DbOrder[] = [asc("file_name")];
  let listed = listOrdered(db, workspaceFilesMapping(), "thread_id = " + placeholderAt(db, 1), [threadId], keys);
  if (listed == "" || listed == "[]") { return none; }
  return JSON.parse<WorkspaceFileRow[]>(listed);
}

export function deleteFile(db: Db, threadId: string, fileName: string): string {
  let gone = executeWith(db, "DELETE FROM workspace_files WHERE id = " + placeholderAt(db, 1),
    [threadId + ":" + fileName]);
  if (!gone.ok) { return gone.error; }
  return "";
}

// --- promotion ----------------------------------------------------------------------

// Make a file part of the corpus: split, embedded and filed under a scope,
// where every agent granted that scope can retrieve it.
//
// Explicit, never a side effect of saving. The moment a conversation's
// artifact becomes team knowledge is a decision, and this row's document_id is
// the audit trail of it.
export function promoteFile(db: Db, model: ModelRow, threadId: string, fileName: string, scope: string, apiKey: string, now: string): Upload {
  let file = getFile(db, threadId, fileName);
  if (file.id == "") {
    let missing: Upload = { ok: false, chunks: 0, error: "no file \"" + fileName + "\" in this thread" };
    return missing;
  }
  // The document source is derived from the file name: dots become
  // underscores because a source must be a plain name.
  let source = sourceOf(fileName);
  let stored = uploadDocument(db, model, source, scope, file.body, apiKey);
  if (!stored.ok) { return stored; }
  // The file remembers where it went.
  putFile(db, threadId, fileName, file.mime, file.origin, file.body, source, now);
  return stored;
}

// A file name as a document source: the safe characters, with the rest
// underscored.
export function sourceOf(fileName: string): string {
  let out = "";
  let i: int = 0;
  while (i < fileName.length) {
    let c = fileName.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 45;
    if (ok) { out = out + fileName.charAt(i); } else { out = out + "_"; }
    i = i + 1;
  }
  return out;
}

// --- the tools a workspace offers ---------------------------------------------------

// The three file tools, described for the model. Offered by the run when it is
// in a thread — a bare runAgent has no workspace, and offering tools that
// answer "no thread" would be noise.
export type WorkspaceTool = {
  name: string,
  description: string,
  schema: string,
};

export function workspaceTools(): WorkspaceTool[] {
  let out: WorkspaceTool[] = [
    {
      name: "list_files",
      description: "List the files in this conversation's workspace: name, size, origin and type.",
      schema: "{\"type\":\"object\",\"properties\":{}}",
    },
    {
      name: "read_file",
      description: "Read a file from this conversation's workspace, whole.",
      schema: "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\",\"description\":\"The file name, exactly as listed.\"}},\"required\":[\"name\"]}",
    },
    {
      name: "write_file",
      description: "Write a file into this conversation's workspace. Overwrites a file of the same name.",
      schema: "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}},\"required\":[\"name\",\"content\"]}",
    },
  ];
  return out;
}

// Dispatch one of the three. `answeredOk` distinguishes "the tool failed" from
// "the tool answered no", same as an MCP call.
export type FileToolResult = {
  handled: bool,
  ok: bool,
  text: string,
};

export function callWorkspaceTool(db: Db, threadId: string, name: string, argsName: string, argsContent: string, now: string): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "" };
  if (threadId == "") { return not; }

  if (name == "list_files") {
    let files = listFiles(db, threadId);
    if (files.length == 0) {
      let empty: FileToolResult = { handled: true, ok: true, text: "The workspace is empty." };
      return empty;
    }
    let out = "";
    let i: int = 0;
    while (i < files.length) {
      if (i > 0) { out = out + "\n"; }
      out = out + files[i].fileName + "  (" + `${files[i].body.length}` + " bytes, " + files[i].origin + ", " + files[i].mime + ")";
      i = i + 1;
    }
    let listed: FileToolResult = { handled: true, ok: true, text: out };
    return listed;
  }

  if (name == "read_file") {
    let file = getFile(db, threadId, argsName);
    if (file.id == "") {
      let missing: FileToolResult = { handled: true, ok: false, text: "There is no file named \"" + argsName + "\". Use list_files to see what is here." };
      return missing;
    }
    let read: FileToolResult = { handled: true, ok: true, text: file.body };
    return read;
  }

  if (name == "write_file") {
    let problem = putFile(db, threadId, argsName, mimeOf(argsName), "generated", argsContent, "", now);
    if (problem != "") {
      let refused: FileToolResult = { handled: true, ok: false, text: problem };
      return refused;
    }
    let wrote: FileToolResult = { handled: true, ok: true, text: "Wrote " + argsName + " (" + `${argsContent.length}` + " bytes)." };
    return wrote;
  }

  return not;
}

// A type from a name, for the common cases. "text/plain" otherwise: the body
// is text whatever the name claims.
export function mimeOf(fileName: string): string {
  if (fileName.endsWith(".md")) { return "text/markdown"; }
  if (fileName.endsWith(".json")) { return "application/json"; }
  if (fileName.endsWith(".csv")) { return "text/csv"; }
  if (fileName.endsWith(".html")) { return "text/html"; }
  if (fileName.endsWith(".ts") || fileName.endsWith(".js") || fileName.endsWith(".py") || fileName.endsWith(".sql")) { return "text/x-source"; }
  return "text/plain";
}

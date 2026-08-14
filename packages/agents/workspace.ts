import { Db } from "../plume/driver.ts";
import { DbOrder, DbRepository, persist, findById, listOrdered, executeWith, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { binaryKind, getArtifact, getVersion, kindOf, listArtifacts, utf8Length } from "./artifacts.ts";
import { uploadBytesMax } from "./caps.ts";
import { ModelRow } from "./schema.ts";
import { Upload, uploadDocument } from "./knowledge.ts";
import { workspaceFileRepository } from "./routes/threads-files/entities/workspace-file.entity.ts";

export const UPLOAD_MAX: int = uploadBytesMax();

export type WorkspaceFileRow = {
  id: string,
  threadId: string,
  fileName: string,
  mime: string,
  origin: string,
  body: string,
  documentId: string,
  updatedAt: string,
};

export function workspaceFilesMapping(): DbRepository {
  return workspaceFileRepository();
}

export function workspacePlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("22", "workspace files", createTableSql(db, workspaceFilesMapping())),
    migration("23", "files by thread",
      "CREATE INDEX IF NOT EXISTS files_by_thread ON workspace_files (thread_id, file_name)"),
  ];
  return plan;
}

export function fileNameOk(name: string): bool {
  if (name == "" || name.length > 200) {
    return false;
  }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c == 95 || c == 45 || c == 46 || c == 32;
    if (!ok) {
      return false;
    }
    i = i + 1;
  }
  if (name.startsWith(".") || name.indexOf("..") >= 0) {
    return false;
  }
  return true;
}

export type FileWrite = {
  threadId: string,
  fileName: string,
  mime: string,
  origin: string,
  body: string,
  documentId: string,
  now: string,
};

export function putFile(db: Db, write: FileWrite): string {
  let threadId = write.threadId;
  let fileName = write.fileName;
  let mime = write.mime;
  let origin = write.origin;
  let body = write.body;
  let documentId = write.documentId;
  let now = write.now;
  if (!fileNameOk(fileName)) {
    return "a file name is letters, digits, dot, dash, underscore and space — not \"" + fileName + "\"";
  }
  if (origin != "uploaded" && origin != "generated" && origin != "retrieved") {
    return "origin must be uploaded, generated or retrieved";
  }
  let bytes = utf8Length(body);
  if (bytes > UPLOAD_MAX) {
    return "a file is at most " + `${UPLOAD_MAX}` + " bytes; \"" + fileName + "\" is " + `${bytes}`;
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
  if (!written.ok) {
    return written.error;
  }
  return "";
}

export function getFile(db: Db, threadId: string, fileName: string): WorkspaceFileRow {
  let absent: WorkspaceFileRow = {
    id: "", threadId: threadId, fileName: fileName, mime: "", origin: "",
    body: "", documentId: "", updatedAt: "",
  };
  let document = findById(db, workspaceFilesMapping(), threadId + ":" + fileName);
  if (document == "") {
    return absent;
  }
  return JSON.parse<WorkspaceFileRow>(document);
}

export function listFiles(db: Db, threadId: string): WorkspaceFileRow[] {
  let none: WorkspaceFileRow[] = [];
  let keys: DbOrder[] = [{ column: "file_name" }];
  let listed = listOrdered(db, workspaceFilesMapping(), {
    where: "thread_id = " + placeholderAt(db, 1),
    args: [threadId],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    return none;
  }
  return JSON.parse<WorkspaceFileRow[]>(listed);
}

export function deleteFile(db: Db, threadId: string, fileName: string): string {
  let gone = executeWith(db, "DELETE FROM workspace_files WHERE id = " + placeholderAt(db, 1),
    [threadId + ":" + fileName]);
  if (!gone.ok) {
    return gone.error;
  }
  return "";
}

export function promoteFile(db: Db, model: ModelRow, threadId: string, fileName: string, scope: string, apiKey: string, now: string): Upload {
  let file = getFile(db, threadId, fileName);
  if (file.id == "") {
    let missing: Upload = {
      ok: false,
      chunks: 0,
      error: "no file \"" + fileName + "\" in this thread",
    };
    return missing;
  }
  let source = sourceOf(fileName);
  let stored = uploadDocument(db, model, source, scope, file.body, apiKey);
  if (!stored.ok) {
    return stored;
  }
  putFile(db, {
    threadId: threadId,
    fileName: fileName,
    mime: file.mime,
    origin: file.origin,
    body: file.body,
    documentId: source,
    now: now,
  });
  return stored;
}

export function sourceOf(fileName: string): string {
  let out = "";
  let i: int = 0;
  while (i < fileName.length) {
    let c = fileName.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 45;
    if (ok) {
      out = out + fileName.charAt(i);
    } else {
      out = out + "_";
    }
    i = i + 1;
  }
  return out;
}

export type WorkspaceTool = {
  name: string,
  description: string,
  schema: string,
};

export function workspaceTools(): WorkspaceTool[] {
  let out: WorkspaceTool[] = [
    {
      name: "list_files",
      description: "List this conversation's files, all of them: the artifacts the reader can open (documents, sheets, pages) and the scratch files. One list — there is no other store to check.",
      schema: "{\"type\":\"object\",\"properties\":{}}",
    },
    {
      name: "read_file",
      description: "Read one of this conversation's files, whole — a scratch file or a text artifact, by its listed name.",
      schema: "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\",\"description\":\"The file name, exactly as listed.\"}},\"required\":[\"name\"]}",
    },
    {
      name: "write_file",
      description: "Write a scratch file — notes, intermediate data. A file the READER should get is not this: use write_artifact, which versions it and gives them a download card.",
      schema: "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}},\"required\":[\"name\",\"content\"]}",
    },
  ];
  return out;
}

export type FileToolResult = {
  handled: bool,
  ok: bool,
  text: string,
  line: int,
  changed: string,
};

export function callWorkspaceTool(db: Db, threadId: string, name: string, argsName: string, argsContent: string, now: string): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (threadId == "") {
    return not;
  }

  if (name == "list_files") {
    let arts = listArtifacts(db, threadId);
    let files = listFiles(db, threadId);
    if (arts.length == 0 && files.length == 0) {
      let empty: FileToolResult = { handled: true, ok: true,
        text: "This conversation has no files yet.", line: 0, changed: "" };
      return empty;
    }
    let out = "";
    let a: int = 0;
    while (a < arts.length) {
      if (out != "") {
        out = out + "\n";
      }
      out = out + arts[a].path + "  (" + arts[a].kind + " v" + `${arts[a].currentVersion}` + ", artifact — the reader can open this)";
      a = a + 1;
    }
    let i: int = 0;
    while (i < files.length) {
      if (out != "") {
        out = out + "\n";
      }
      out = out + files[i].fileName + "  (" + `${files[i].body.length}` + " bytes, scratch, " + files[i].origin + ")";
      i = i + 1;
    }
    let listed: FileToolResult = { handled: true, ok: true, text: out, line: 0, changed: "" };
    return listed;
  }

  if (name == "read_file") {
    let file = getFile(db, threadId, argsName);
    if (file.id != "") {
      let read: FileToolResult = { handled: true, ok: true, text: file.body, line: 0, changed: "" };
      return read;
    }
    let artifact = getArtifact(db, threadId, argsName);
    if (artifact.id != "") {
      if (binaryKind(kindOf(argsName))) {
        let binary: FileToolResult = { handled: true, ok: false,
          text: argsName + " is a binary document — read it with run_script in the office environment"
            + " (read-docx for .docx), naming it in paths.", line: 0, changed: "" };
        return binary;
      }
      let current = getVersion(db, artifact.id, artifact.currentVersion);
      if (current.id != "") {
        let read: FileToolResult = {
          handled: true,
          ok: true,
          text: current.body,
          line: 0,
          changed: "",
        };
        return read;
      }
    }
    let missing: FileToolResult = {
      handled: true,
      ok: false,
      text: "There is no file named \"" + argsName + "\". Use list_files to see what is here.",
      line: 0,
      changed: "",
    };
    return missing;
  }

  if (name == "write_file") {
    let fault = putFile(db, {
      threadId: threadId,
      fileName: argsName,
      mime: mimeOf(argsName),
      origin: "generated",
      body: argsContent,
      documentId: "",
      now: now,
    });
    if (fault != "") {
      let refused: FileToolResult = {
        handled: true,
        ok: false,
        text: fault,
        line: 0,
        changed: "",
      };
      return refused;
    }
    let wrote: FileToolResult = {
      handled: true,
      ok: true,
      text: "Wrote " + argsName + " (" + `${argsContent.length}` + " bytes).",
      line: 0,
      changed: "",
    };
    return wrote;
  }

  return not;
}

export function mimeOf(fileName: string): string {
  if (fileName.endsWith(".md")) {
    return "text/markdown";
  }
  if (fileName.endsWith(".json")) {
    return "application/json";
  }
  if (fileName.endsWith(".csv")) {
    return "text/csv";
  }
  if (fileName.endsWith(".html")) {
    return "text/html";
  }
  if (fileName.endsWith(".ts") || fileName.endsWith(".js") || fileName.endsWith(".py") || fileName.endsWith(".sql")) {
    return "text/x-source";
  }
  return "text/plain";
}

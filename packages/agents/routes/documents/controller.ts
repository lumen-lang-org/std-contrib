import { Db } from "../../../plume/driver.ts";
import { executeWith, persist, safeIdentifier } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, badRequest, jsonOf, noContent, notFound, okJson } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { pgOnly } from "../../guards.ts";
import { credentialFor } from "../../credentials.ts";
import { DocumentFileRow, FILE_BASE64_MAX, documentFileId, documentFilesMapping, findDocumentFile, forgetDocumentFiles, holdsSource, sourcesWithFiles } from "../../document-files.ts";
import { JOB_QUEUED, enqueue, pendingJobs } from "../../indexing.ts";
import { createDocuments, embeddingModel, listSources, normalScope } from "../../knowledge.ts";
import { DocumentFileUpload, DocumentFileView, DocumentQueued, DocumentStored, DocumentSummary, DocumentUpload } from "./types.ts";

function sourceProblem(source: string, body: string): string {
  if (source.trim() == "") { return "a document needs a source to be filed under"; }
  if (!safeIdentifier(source)) {
    return "a source must be a plain name: letters, digits, _ and -";
  }
  if (body.trim() == "") { return "an empty document has nothing to retrieve"; }
  return "";
}

function firstText(said: string, fallback: string): string {
  let text = said.trim();
  if (text == "") { return fallback; }
  return text;
}

export function decodedSize(base64: string): int {
  let text = base64.trim();
  if (text.length == 0) { return 0; }
  let padding: int = 0;
  if (text.endsWith("==")) {
    padding = 2;
  } else if (text.endsWith("=")) {
    padding = 1;
  }
  let whole = (text.length / 4) * 3;
  return whole - padding;
}

@controller("/documents")
export class DocumentApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  needsPg(): Guarded {
    return pgOnly(this.db, "documents need PostgreSQL (pgvector); this runs on " + this.db.name);
  }

  @get("/")
  @Guard(needsPg)
  list(@RequestParam("scope", "/") asked: string): Reply {
    let scope = normalScope(asked);

    let originals = sourcesWithFiles(this.db, scope);

    let waiting = pendingJobs(this.db, scope);
    let out: DocumentSummary[] = [];
    let w: int = 0;
    while (w < waiting.length) {
      let queued: DocumentSummary = {
        source: waiting[w].source,
        scope: waiting[w].scope,
        chunks: 0,
        bytes: 0,
        status: waiting[w].status,
        error: waiting[w].error,
        hasFile: holdsSource(originals, waiting[w].source),
      };
      out.push(queued);
      w = w + 1;
    }

    let rows = listSources(this.db, scope);
    let i: int = 0;
    while (i < rows.length) {
      let one: DocumentSummary = {
        source: rows[i].source,
        scope: rows[i].scope,
        chunks: rows[i].chunks,
        bytes: rows[i].bytes,
        status: "indexed",
        error: "",
        hasFile: holdsSource(originals, rows[i].source),
      };
      out.push(one);
      i = i + 1;
    }
    return okJson(out);
  }

  @post("/")
  @Guard(needsPg)
  upload(req: Request, @RequestParam("model", "") modelId: string): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let body: DocumentUpload = JSON.parse<DocumentUpload>(req.body);
    if (body.scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }

    if (modelId == "") { return badRequest("name the embedding model: ?model=e1"); }
    let embedder = embeddingModel(this.db, modelId);
    if (embedder.id == "") { return badRequest("no usable embedding model " + modelId); }
    let key = credentialFor(this.db, embedder.provider, this.master);
    if (key == "") { return badRequest("no credential for " + embedder.provider); }

    let badName = sourceProblem(body.source, body.body);
    if (badName != "") { return badRequest(badName); }

    let ready = createDocuments(this.db, embedder);
    if (ready != "") { return badRequest(ready); }

    let jobId = enqueue(this.db, body.source, normalScope(body.scope), embedder.id, body.body, `${Date.now()}`);
    if (jobId == "") { return badRequest("the document could not be queued"); }
    let v: DocumentQueued = {
      job: jobId,
      source: body.source,
      scope: normalScope(body.scope),
      status: JOB_QUEUED,
    };
    return jsonOf(202, v);
  }

  @put("/file")
  @Guard(needsPg)
  keepFile(req: Request): Reply {
    if (req.body == "") {
      return badRequest("a body is required: {\"source\":\"...\",\"scope\":\"...\",\"filename\":\"...\",\"mime\":\"...\",\"contentBase64\":\"...\"}");
    }
    let ask: DocumentFileUpload = JSON.parse<DocumentFileUpload>(req.body);
    let source = (ask.source ?? "").trim();
    if (source == "") { return badRequest("a document needs a source to be filed under"); }
    let scope = (ask.scope ?? "").trim();
    if (scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }
    let content = ask.contentBase64 ?? "";
    if (content == "") { return badRequest("there are no bytes to keep"); }
    if (content.length > FILE_BASE64_MAX) {
      return badRequest("that file is too large to keep");
    }
    let filed = normalScope(scope);
    let row: DocumentFileRow = {
      id: documentFileId(filed, source),
      source: source,
      scope: filed,
      filename: firstText(ask.filename ?? "", source),
      mime: firstText(ask.mime ?? "", "application/octet-stream"),
      bytes: content,
      size: decodedSize(content),
      createdAt: stamp(),
    };
    let written = persist(this.db, documentFilesMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    let v: DocumentStored = { stored: true };
    return okJson(v);
  }

  @get("/file")
  @Guard(needsPg)
  file(@RequestParam("source", "") source: string,
       @RequestParam("scope", "/") scope: string): Reply {
    if (source == "") { return badRequest("name the document: ?source=notes&scope=/specs"); }
    let kept = findDocumentFile(this.db, scope, source);
    if (kept.id == "") { return notFound("no kept file for " + source); }
    let v: DocumentFileView = {
      filename: kept.filename,
      mime: kept.mime,
      size: kept.size,
      contentBase64: kept.bytes,
    };
    return okJson(v);
  }

  @del("/:source")
  @Guard(needsPg)
  remove(@PathVariable("source") source: string): Reply {
    executeWith(this.db, "DELETE FROM documents WHERE source = " + this.db.placeholder, [source]);
    forgetDocumentFiles(this.db, source);
    return noContent();
  }
}

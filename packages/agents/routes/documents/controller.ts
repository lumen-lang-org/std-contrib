import { Db } from "../../../plume/driver.ts";
import { executeWith, persist, safeIdentifier } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, accepted, badRequest, noContent, notFound, ok, param, queryParam } from "../../../rest/server.ts";
import { boolJson, stamp } from "../../api-core.ts";
import { credentialFor } from "../../credentials.ts";
import { DocumentFileRow, FILE_BASE64_MAX, documentFileId, documentFilesMapping, findDocumentFile, forgetDocumentFiles, holdsSource, sourcesWithFiles } from "../../document-files.ts";
import { JOB_QUEUED, enqueue, pendingJobs } from "../../indexing.ts";
import { createDocuments, embeddingModel, listSources, normalScope } from "../../knowledge.ts";
import { jsonText } from "../../scan.ts";
import { DocumentUpload } from "./types.ts";

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

  @get("/")
  list(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let scope = normalScope(queryParam(req, "scope", "/"));

    let originals = sourcesWithFiles(this.db, scope);

    let waiting = pendingJobs(this.db, scope);
    let out = "[";
    let w: int = 0;
    while (w < waiting.length) {
      if (w > 0) { out = out + ","; }
      out = out + "{\"source\":" + JSON.stringify(waiting[w].source)
        + ",\"scope\":" + JSON.stringify(waiting[w].scope)
        + ",\"chunks\":0,\"bytes\":0"
        + ",\"status\":" + JSON.stringify(waiting[w].status)
        + ",\"error\":" + JSON.stringify(waiting[w].error)
        + ",\"hasFile\":" + boolJson(holdsSource(originals, waiting[w].source)) + "}";
      w = w + 1;
    }

    let rows = listSources(this.db, scope);
    let i: int = 0;
    while (i < rows.length) {
      if (w + i > 0) { out = out + ","; }
      out = out + "{\"source\":" + JSON.stringify(rows[i].source)
        + ",\"scope\":" + JSON.stringify(rows[i].scope)
        + ",\"chunks\":" + `${rows[i].chunks}`
        + ",\"bytes\":" + `${rows[i].bytes}`
        + ",\"status\":\"indexed\",\"error\":\"\""
        + ",\"hasFile\":" + boolJson(holdsSource(originals, rows[i].source)) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  @post("/")
  upload(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: DocumentUpload = JSON.parse<DocumentUpload>(req.body);
    if (body.scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }

    let modelId = queryParam(req, "model", "");
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
    return accepted("{\"job\":" + JSON.stringify(jobId)
      + ",\"source\":" + JSON.stringify(body.source)
      + ",\"scope\":" + JSON.stringify(normalScope(body.scope))
      + ",\"status\":" + JSON.stringify(JOB_QUEUED) + "}");
  }

  @put("/file")
  keepFile(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"source\":\"...\",\"scope\":\"...\",\"filename\":\"...\",\"mime\":\"...\",\"contentBase64\":\"...\"}");
    }
    let source = jsonText(req.body, "source").trim();
    if (source == "") { return badRequest("a document needs a source to be filed under"); }
    let scope = jsonText(req.body, "scope").trim();
    if (scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }
    let content = jsonText(req.body, "contentBase64");
    if (content == "") { return badRequest("there are no bytes to keep"); }
    if (content.length > FILE_BASE64_MAX) {
      return badRequest("that file is too large to keep");
    }
    let filed = normalScope(scope);
    let row: DocumentFileRow = {
      id: documentFileId(filed, source),
      source: source,
      scope: filed,
      filename: firstText(jsonText(req.body, "filename"), source),
      mime: firstText(jsonText(req.body, "mime"), "application/octet-stream"),
      bytes: content,
      size: decodedSize(content),
      createdAt: stamp(),
    };
    let written = persist(this.db, documentFilesMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok("{\"stored\":true}");
  }

  @get("/file")
  file(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let source = queryParam(req, "source", "");
    let scope = queryParam(req, "scope", "/");
    if (source == "") { return badRequest("name the document: ?source=notes&scope=/specs"); }
    let kept = findDocumentFile(this.db, scope, source);
    if (kept.id == "") { return notFound("no kept file for " + source); }
    return ok("{\"filename\":" + JSON.stringify(kept.filename)
      + ",\"mime\":" + JSON.stringify(kept.mime)
      + ",\"size\":" + `${kept.size}`
      + ",\"contentBase64\":" + JSON.stringify(kept.bytes) + "}");
  }

  @del("/:source")
  remove(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let source = param(req, "source");
    executeWith(this.db, "DELETE FROM documents WHERE source = " + this.db.placeholder, [source]);
    forgetDocumentFiles(this.db, source);
    return noContent();
  }
}

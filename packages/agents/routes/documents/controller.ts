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

// The /documents routes.

// The document checks that used to happen inside the request, kept there now
// that the indexing itself does not. These are the ones knowable without a
// model: everything else is the worker's to report on the job.
function sourceProblem(source: string, body: string): string {
  if (source.trim() == "") { return "a document needs a source to be filed under"; }
  if (!safeIdentifier(source)) {
    return "a source must be a plain name: letters, digits, _ and -";
  }
  if (body.trim() == "") { return "an empty document has nothing to retrieve"; }
  return "";
}

// The first of two spellings that is not blank. For the kept-file door, where
// a missing filename or mime is a caller that did not bother rather than a
// caller that means "none" — and storing "" would put an empty name on a
// download.
function firstText(said: string, fallback: string): string {
  let text = said.trim();
  if (text == "") { return fallback; }
  return text;
}

// How many bytes a base64 string stands for, without decoding it.
//
// Four characters carry three bytes; each "=" at the end is a byte that is not
// there. Computed rather than measured because the whole point of keeping the
// bytes as base64 is never having to hold a decoded copy — decoding eighteen
// megabytes to learn a number the arithmetic already knows would double the
// memory of every upload.
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

// Documents and the folders they live in.
//
// Retrieval is PostgreSQL only — pgvector has no SQLite equivalent — so every
// route here reports that rather than failing at the query. A deployment on
// SQLite is not misconfigured; it just cannot do this.
@controller("/documents")
export class DocumentApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  // What one folder holds: the sources, with how many chunks and how many
  // bytes each. Chunks are grouped here rather than listed — a reader manages
  // documents, and the chunking is the index's business.
  @get("/")
  list(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let scope = normalScope(queryParam(req, "scope", "/"));

    // Which of them kept their original bytes, in one query for the folder
    // rather than one per row — document-files.ts says why. Read before either
    // loop so a queued document and an indexed one answer the same way: the
    // file is stored at upload, before the indexer has looked at it, so a row
    // that is still waiting can already have one to preview.
    let originals = sourcesWithFiles(this.db, scope);

    // Waiting and failed jobs first, then what is actually indexed. A file
    // uploaded a second ago has no chunks and no size yet, and saying so is
    // the point — otherwise it simply is not in the list and looks lost.
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
        // Appended, never in place of anything above: the console reads every
        // member that was already here.
        + ",\"hasFile\":" + boolJson(holdsSource(originals, rows[i].source)) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Upload a document: split, embedded and filed under one scope. Re-uploading
  // the same source replaces its chunks.
  @post("/")
  upload(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: DocumentUpload = JSON.parse<DocumentUpload>(req.body);
    if (body.scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }

    // Which model embeds is a row, and it has to be named — a document
    // embedded by the wrong model is invisible to every agent reading that
    // folder, silently.
    let modelId = queryParam(req, "model", "");
    if (modelId == "") { return badRequest("name the embedding model: ?model=e1"); }
    let embedder = embeddingModel(this.db, modelId);
    if (embedder.id == "") { return badRequest("no usable embedding model " + modelId); }
    let key = credentialFor(this.db, embedder.provider, this.master);
    if (key == "") { return badRequest("no credential for " + embedder.provider); }

    // What the worker would refuse, refused here. Moving indexing onto a
    // queue moved these checks into the worker with it, so a name that can
    // never be filed — chunk ids are built from it and must be plain — was
    // accepted with a 202 and failed minutes later in a job row. A caller
    // should learn at the moment of asking.
    let badName = sourceProblem(body.source, body.body);
    if (badName != "") { return badRequest(badName); }

    // The corpus table is made on demand, from the embedder's own width. It
    // was only ever created by an example, so a fresh deployment could queue a
    // document and watch the worker fail on a table nobody had made.
    let ready = createDocuments(this.db, embedder);
    if (ready != "") { return badRequest(ready); }

    // Queued, not indexed here. Embedding a document is one model call per
    // chunk: a large file would hold this connection past any proxy's timeout,
    // and a browser would show nothing until it finished. The worker drains
    // the queue; the job row is what the console watches.
    let jobId = enqueue(this.db, body.source, normalScope(body.scope), embedder.id, body.body, `${Date.now()}`);
    if (jobId == "") { return badRequest("the document could not be queued"); }
    return accepted("{\"job\":" + JSON.stringify(jobId)
      + ",\"source\":" + JSON.stringify(body.source)
      + ",\"scope\":" + JSON.stringify(normalScope(body.scope))
      + ",\"status\":" + JSON.stringify(JOB_QUEUED) + "}");
  }

  // Keep the file itself, not just what was read out of it.
  //
  // A second door rather than a field on the upload above, and the two are
  // independent on purpose: indexing is queued and can fail on a provider,
  // storing bytes is one row and cannot. Sending them together would mean a
  // failed embedding lost the original as well, which is the exact loss this
  // table exists to stop. The console PUTs both and neither waits on the
  // other.
  //
  // Idempotent: the id is derived from (scope, source), so re-uploading the
  // same document REPLACES its kept copy. A second attempt after a browser
  // retry leaves one row, not two.
  //
  // Before "/:source" — the router matches literals first, and a PUT is not a
  // DELETE, but the house rule is the ordering and it costs nothing to keep.
  @put("/file")
  keepFile(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"source\":\"...\",\"scope\":\"...\",\"filename\":\"...\",\"mime\":\"...\",\"contentBase64\":\"...\"}");
    }
    // Member by member, never JSON.parse<T> of a request body: a record type
    // refuses a key it does not name, so a console that sends one extra field
    // — or the same field spelled for a later build — would have the whole
    // upload rejected over something nobody reads.
    let source = jsonText(req.body, "source").trim();
    if (source == "") { return badRequest("a document needs a source to be filed under"); }
    let scope = jsonText(req.body, "scope").trim();
    if (scope == "") { return badRequest("a document needs a scope: \"/specs/plume\""); }
    let content = jsonText(req.body, "contentBase64");
    if (content == "") { return badRequest("there are no bytes to keep"); }
    if (content.length > FILE_BASE64_MAX) {
      return badRequest("that file is too large to keep");
    }
    // No allowlist of types. This is the owner's own corpus and their own
    // file; the engine never opens it, and hands it back exactly as it
    // arrived. What is refused is size, above, and nothing else.
    let filed = normalScope(scope);
    let row: DocumentFileRow = {
      id: documentFileId(filed, source),
      source: source,
      scope: filed,
      // The name to hand back. Falls back to the source, so a caller that
      // omits it still gets something to put on a download rather than a
      // browser inventing "download".
      filename: firstText(jsonText(req.body, "filename"), source),
      mime: firstText(jsonText(req.body, "mime"), "application/octet-stream"),
      bytes: content,
      // Decoded length, computed from the base64 rather than decoded to be
      // measured: four characters carry three bytes, and the one or two "="
      // at the end each stand for one byte that is not there.
      size: decodedSize(content),
      createdAt: stamp(),
    };
    let written = persist(this.db, documentFilesMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return ok("{\"stored\":true}");
  }

  // Hand the original back, as JSON with the bytes base64 inside it.
  //
  // JSON and not the raw bytes with a content type: the console builds a blob
  // URL from this to show in a viewer, so it wants the bytes in hand rather
  // than a navigation, and one shape covers every type without the response
  // path having to carry binary at all. The cost is the third that base64 adds
  // to the wire, paid once per preview.
  @get("/file")
  file(req: Request): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let source = queryParam(req, "source", "");
    let scope = queryParam(req, "scope", "/");
    if (source == "") { return badRequest("name the document: ?source=notes&scope=/specs"); }
    let kept = findDocumentFile(this.db, scope, source);
    // A document indexed before this table existed has text and no original,
    // and so does one uploaded by anything that does not PUT here. Absent, not
    // broken — the listing's `hasFile` is what a caller checks first.
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
    // And the original with it. A file whose text is gone is unreachable —
    // nothing lists it, nothing can ask for it, and nothing would ever delete
    // it — so leaving it behind is not caution, it is a leak that grows by the
    // size of every document anybody removes.
    forgetDocumentFiles(this.db, source);
    return noContent();
  }
}

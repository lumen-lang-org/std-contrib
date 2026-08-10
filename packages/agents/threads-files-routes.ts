// The /threads/:id/files routes.

import { Db } from "../plume/driver.ts";
import { findById } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../rest/server.ts";
import { callerTags, stamp } from "./api-core.ts";
import { credentialFor } from "./credentials.ts";
import { documentsMapping, embeddingModel, normalScope } from "./knowledge.ts";
import { jsonText } from "./scan.ts";
import { ownedThread } from "./threads.ts";
import { deleteFile, getFile, listFiles, mimeOf, promoteFile, putFile } from "./workspace.ts";

type FileUpload = { name: string, content: string };

type FilePromote = { scope: string, modelId: string };

type FilePull = { name: string, documentId: string };

// The files a conversation is working on: uploaded by the user, written by
// the model with its write_file tool, or pulled in from the corpus.
//
// Every route here opens with `ownedThread`, before it looks at a name or a
// body. Three of them used to resolve the file straight out of
// `workspace_files` by (thread, name) — correct about which row, silent about
// whose — so a conversation id was the whole of the authorisation to read,
// delete or publish somebody else's upload.
@controller("/threads/:id/files")
export class WorkspaceApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @get("/")
  list(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let files = listFiles(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < files.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"name\":" + JSON.stringify(files[i].fileName)
        + ",\"mime\":" + JSON.stringify(files[i].mime)
        + ",\"origin\":" + JSON.stringify(files[i].origin)
        + ",\"bytes\":" + `${files[i].body.length}`
        + ",\"documentId\":" + JSON.stringify(files[i].documentId) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Upload. The body is JSON text; a binary file needs base64 at this edge and
  // is not pretended to work.
  @post("/")
  upload(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"name\":\"notes.md\",\"content\":\"...\"}"); }
    let body: FileUpload = JSON.parse<FileUpload>(req.body);
    let problem = putFile(this.db, { threadId: param(req, "id"), fileName: body.name, mime: mimeOf(body.name), origin: "uploaded", body: body.content, documentId: "", now: stamp() });
    if (problem != "") { return badRequest(problem); }
    return created("{\"name\":" + JSON.stringify(body.name) + ",\"bytes\":" + `${body.content.length}` + "}");
  }

  @get("/:name")
  read(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let file = getFile(this.db, param(req, "id"), param(req, "name"));
    if (file.id == "") { return notFound("file " + param(req, "name")); }
    return ok("{\"name\":" + JSON.stringify(file.fileName)
      + ",\"mime\":" + JSON.stringify(file.mime)
      + ",\"origin\":" + JSON.stringify(file.origin)
      + ",\"content\":" + JSON.stringify(file.body) + "}");
  }

  @del("/:name")
  remove(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (getFile(this.db, param(req, "id"), param(req, "name")).id == "") {
      return notFound("file " + param(req, "name"));
    }
    deleteFile(this.db, param(req, "id"), param(req, "name"));
    return noContent();
  }

  // Pull a corpus document into the workspace, as a pointer with its body. The
  // agent can then read it whole, which retrieval never offers.
  @post("/pull")
  pull(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (this.db.name != "postgres") {
      return badRequest("the corpus needs PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let body: FilePull = JSON.parse<FilePull>(req.body);
    let document = findById(this.db, documentsMapping(), body.documentId);
    if (document == "") { return badRequest("no document " + body.documentId); }
    let content = jsonText(document, "body");
    let problem = putFile(this.db, { threadId: param(req, "id"), fileName: body.name, mime: mimeOf(body.name), origin: "retrieved", body: content, documentId: body.documentId, now: stamp() });
    if (problem != "") { return badRequest(problem); }
    return created("{\"name\":" + JSON.stringify(body.name) + ",\"documentId\":" + JSON.stringify(body.documentId) + "}");
  }

  // Make a file part of the corpus, under a scope. Explicit, never a side
  // effect of saving: this is the moment a conversation's artifact becomes
  // team knowledge, and the file's documentId is the audit trail.
  @post("/:name/promote")
  promote(req: Request): Reply {
    // Ownership first, even before the dialect check: which database this runs
    // on is not something a caller with no business here needs told.
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (this.db.name != "postgres") {
      return badRequest("the corpus needs PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    if (req.body == "") { return badRequest("a body is required: {\"scope\":\"/specs\",\"modelId\":\"e1\"}"); }
    let body: FilePromote = JSON.parse<FilePromote>(req.body);
    let embedder = embeddingModel(this.db, body.modelId);
    if (embedder.id == "") { return badRequest("no usable embedding model " + body.modelId); }
    let key = credentialFor(this.db, embedder.provider, this.master);
    if (key == "") { return badRequest("no credential for " + embedder.provider); }

    let stored = promoteFile(this.db, embedder, param(req, "id"), param(req, "name"), body.scope, key, stamp());
    if (!stored.ok) { return badRequest(stored.error); }
    return ok("{\"name\":" + JSON.stringify(param(req, "name"))
      + ",\"scope\":" + JSON.stringify(normalScope(body.scope))
      + ",\"chunks\":" + `${stored.chunks}` + "}");
  }
}

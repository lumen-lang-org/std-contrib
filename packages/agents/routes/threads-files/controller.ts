import { Db } from "../../../plume/driver.ts";
import { findById } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, createdJson, noContent, notFound, okJson, param, problem } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { credentialFor } from "../../credentials.ts";
import { documentsMapping, embeddingModel, normalScope } from "../../knowledge.ts";
import { jsonText } from "../../scan.ts";
import { ownedThread } from "../../threads.ts";
import { deleteFile, getFile, listFiles, mimeOf, promoteFile, putFile } from "../../workspace.ts";
import { FileContent, FilePromote, FilePromoted, FilePull, FilePulled, FileUpload, FileUploaded, FileView } from "./types.ts";

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
    let out: FileView[] = [];
    let i: int = 0;
    while (i < files.length) {
      let v: FileView = {
        name: files[i].fileName,
        mime: files[i].mime,
        origin: files[i].origin,
        bytes: files[i].body.length,
        documentId: files[i].documentId,
      };
      out.push(v);
      i = i + 1;
    }
    return okJson(out);
  }

  @post("/")
  upload(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required: {\"name\":\"notes.md\",\"content\":\"...\"}"); }
    let body: FileUpload = JSON.parse<FileUpload>(req.body);
    let problem = putFile(this.db, { threadId: param(req, "id"), fileName: body.name, mime: mimeOf(body.name), origin: "uploaded", body: body.content, documentId: "", now: stamp() });
    if (problem != "") { return badRequest(problem); }
    let v: FileUploaded = { name: body.name, bytes: body.content.length };
    return createdJson(v);
  }

  @get("/:name")
  read(req: Request): Reply {
    if (ownedThread(this.db, param(req, "id"), callerTags(req)) == "") {
      return notFound("thread " + param(req, "id"));
    }
    let file = getFile(this.db, param(req, "id"), param(req, "name"));
    if (file.id == "") { return notFound("file " + param(req, "name")); }
    let v: FileContent = {
      name: file.fileName,
      mime: file.mime,
      origin: file.origin,
      content: file.body,
    };
    return okJson(v);
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
    let v: FilePulled = { name: body.name, documentId: body.documentId };
    return createdJson(v);
  }

  @post("/:name/promote")
  promote(req: Request): Reply {
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
    let v: FilePromoted = {
      name: param(req, "name"),
      scope: normalScope(body.scope),
      chunks: stored.chunks,
    };
    return okJson(v);
  }
}

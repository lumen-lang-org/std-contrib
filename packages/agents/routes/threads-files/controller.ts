import { Db } from "../../../plume/driver.ts";
import { findById } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, BadRequest, CreatedJson, NoContent, NotFound, OkJson, Refused } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { credentialFor } from "../../credentials.ts";
import { pgOnly } from "../../guards.ts";
import { documentsMapping, embeddingModel, normalScope } from "../../knowledge.ts";
import { jsonText } from "../../scan.ts";
import { ownedThread } from "../../threads.ts";
import { deleteFile, getFile, listFiles, mimeOf, promoteFile, putFile } from "../../workspace.ts";
import { FileContent, FilePromote, FilePromoted, FilePull, FilePulled, FileUpload, FileUploaded, FileView } from "./types.ts";

@controller("/threads/:id/files")
@bindings
export class WorkspaceApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  needsPg(): Guarded {
    return pgOnly(this.db, "the corpus needs PostgreSQL (pgvector); this runs on " + this.db.name);
  }

  @Get("/")
  list(req: Request, @PathVariable("id") id: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    let files = listFiles(this.db, id);
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
    return OkJson(out);
  }

  @Post("/")
  upload(req: Request, @PathVariable("id") id: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required: {\"name\":\"notes.md\",\"content\":\"...\"}");
    }
    let body: FileUpload = JSON.parse<FileUpload>(req.body);
    let problem = putFile(this.db, { threadId: id, fileName: body.name, mime: mimeOf(body.name), origin: "uploaded", body: body.content, documentId: "", now: stamp() });
    if (problem != "") {
      return BadRequest(problem);
    }
    let v: FileUploaded = { name: body.name, bytes: body.content.length };
    return CreatedJson(v);
  }

  @Get("/:name")
  read(req: Request,
       @PathVariable("id") id: string,
       @PathVariable("name") name: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    let file = getFile(this.db, id, name);
    if (file.id == "") {
      return NotFound("file " + name);
    }
    let v: FileContent = {
      name: file.fileName,
      mime: file.mime,
      origin: file.origin,
      content: file.body,
    };
    return OkJson(v);
  }

  @Delete("/:name")
  remove(req: Request,
         @PathVariable("id") id: string,
         @PathVariable("name") name: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    if (getFile(this.db, id, name).id == "") {
      return NotFound("file " + name);
    }
    deleteFile(this.db, id, name);
    return NoContent();
  }

  @Post("/pull")
  @Guard(needsPg)
  pull(req: Request, @PathVariable("id") id: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    let body: FilePull = JSON.parse<FilePull>(req.body);
    let document = findById(this.db, documentsMapping(), body.documentId);
    if (document == "") {
      return BadRequest("no document " + body.documentId);
    }
    let content = jsonText(document, "body");
    let problem = putFile(this.db, { threadId: id, fileName: body.name, mime: mimeOf(body.name), origin: "retrieved", body: content, documentId: body.documentId, now: stamp() });
    if (problem != "") {
      return BadRequest(problem);
    }
    let v: FilePulled = { name: body.name, documentId: body.documentId };
    return CreatedJson(v);
  }

  @Post("/:name/promote")
  @Guard(needsPg)
  promote(req: Request,
          @PathVariable("id") id: string,
          @PathVariable("name") name: string): Reply {
    if (ownedThread(this.db, id, callerTags(req)) == "") {
      return NotFound("thread " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required: {\"scope\":\"/specs\",\"modelId\":\"e1\"}");
    }
    let body: FilePromote = JSON.parse<FilePromote>(req.body);
    let embedder = embeddingModel(this.db, body.modelId);
    if (embedder.id == "") {
      return BadRequest("no usable embedding model " + body.modelId);
    }
    let key = credentialFor(this.db, embedder.provider, this.master);
    if (key == "") {
      return BadRequest("no credential for " + embedder.provider);
    }

    let stored = promoteFile(this.db, embedder, id, name, body.scope, key, stamp());
    if (!stored.ok) {
      return BadRequest(stored.error);
    }
    let v: FilePromoted = {
      name: name,
      scope: normalScope(body.scope),
      chunks: stored.chunks,
    };
    return OkJson(v);
  }
}

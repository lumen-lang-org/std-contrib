import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { normalScope } from "../../../knowledge.ts";
import { jsonText } from "../../../scan.ts";
import { mimeOf } from "../../../workspace.ts";
import { FileContent } from "./dtos/file-content.dto.ts";
import { FilePromote } from "./dtos/file-promote.dto.ts";
import { FilePromoted } from "./dtos/file-promoted.dto.ts";
import { FilePull } from "./dtos/file-pull.dto.ts";
import { FilePulled } from "./dtos/file-pulled.dto.ts";
import { FileUpload } from "./dtos/file-upload.dto.ts";
import { FileUploaded } from "./dtos/file-uploaded.dto.ts";
import { FileView } from "./dtos/file-view.dto.ts";
import { FileRepository } from "./file.repository.ts";
import { PROMOTE_BODY_HELP, UPLOAD_BODY_HELP, fileContent, fileView } from "./file.utils.ts";

export class FileService {
  repository: FileRepository;

  constructor(database: Db, master: string) {
    this.repository = new FileRepository(database, master);
  }

  threadIsOwned(threadId: string, tags: string[]): bool {
    return this.repository.threadOwner(threadId, tags) != "";
  }

  has(threadId: string, fileName: string): bool {
    return this.repository.one(threadId, fileName).id != "";
  }

  listing(threadId: string): FileView[] {
    let rows = this.repository.listing(threadId);
    let out: FileView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      out.push(fileView(rows[i]));
      i = i + 1;
    }
    return out;
  }

  one(threadId: string, fileName: string): FileContent {
    return fileContent(this.repository.one(threadId, fileName));
  }

  upload(threadId: string, sent: string): Outcome {
    if (sent == "") {
      return refusing(UPLOAD_BODY_HELP);
    }
    let body: FileUpload = JSON.parse<FileUpload>(sent);
    let fault = this.repository.save({
      threadId: threadId,
      fileName: body.name,
      mime: mimeOf(body.name),
      origin: "uploaded",
      body: body.content,
      documentId: "",
      now: stamp(),
    });
    if (fault != "") {
      return refusing(fault);
    }
    let view: FileUploaded = { name: body.name, bytes: body.content.length };
    return produced(JSON.stringify(view));
  }

  pull(threadId: string, body: FilePull): Outcome {
    let document = this.repository.document(body.documentId);
    if (document == "") {
      return refusing("no document " + body.documentId);
    }
    let content = jsonText(document, "body");
    let fault = this.repository.save({
      threadId: threadId,
      fileName: body.name,
      mime: mimeOf(body.name),
      origin: "retrieved",
      body: content,
      documentId: body.documentId,
      now: stamp(),
    });
    if (fault != "") {
      return refusing(fault);
    }
    let view: FilePulled = { name: body.name, documentId: body.documentId };
    return produced(JSON.stringify(view));
  }

  promote(owner: string, threadId: string, fileName: string, sent: string): Outcome {
    if (sent == "") {
      return refusing(PROMOTE_BODY_HELP);
    }
    let body: FilePromote = JSON.parse<FilePromote>(sent);
    if (!this.repository.embeddingUsable(body.modelId)) {
      return refusing("no usable embedding model " + body.modelId);
    }
    let provider = this.repository.embeddingProvider(body.modelId);
    let key = this.repository.credential(provider);
    if (key == "") {
      return refusing("no credential for " + provider);
    }

    let stored = this.repository.promote(owner, threadId, fileName, body.scope, body.modelId, key, stamp());
    if (!stored.ok) {
      return refusing(stored.error);
    }
    let view: FilePromoted = {
      name: fileName,
      scope: normalScope(body.scope),
      chunks: stored.chunks,
    };
    return produced(JSON.stringify(view));
  }

  forget(threadId: string, fileName: string): string {
    return this.repository.forget(threadId, fileName);
  }
}

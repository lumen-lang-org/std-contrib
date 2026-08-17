import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { JOB_QUEUED } from "../jobs/entities/index-job.entity.ts";
import { normalScope } from "../../../knowledge.ts";
import { DocumentFileUpload } from "./dtos/document-file-upload.dto.ts";
import { DocumentQueued } from "./dtos/document-queued.dto.ts";
import { DocumentStored } from "./dtos/document-stored.dto.ts";
import { DocumentSummary } from "./dtos/document-summary.dto.ts";
import { DocumentUpload } from "./dtos/document-upload.dto.ts";
import { DocumentAnswer, DocumentPassage } from "./dtos/document-passage.dto.ts";
import { DocumentRepository } from "./document.repository.ts";
import { DocumentFileRow, FILE_BASE64_MAX, decodedSize, documentFileId, firstText, holdsSource, indexedSummary, queuedSummary, sourceFault } from "./document.utils.ts";

export class DocumentService {
  repository: DocumentRepository;

  constructor(database: Db, master: string) {
    this.repository = new DocumentRepository(database, master);
  }

  listing(asked: string): DocumentSummary[] {
    let scope = normalScope(asked);
    let originals = this.repository.filedSources(scope);

    let waiting = this.repository.waitingJobs(scope);
    let out: DocumentSummary[] = [];
    let w: int = 0;
    while (w < waiting.length) {
      out.push(queuedSummary(waiting[w], holdsSource(originals, waiting[w].source)));
      w = w + 1;
    }

    let rows = this.repository.indexedSources(scope);
    let i: int = 0;
    while (i < rows.length) {
      out.push(indexedSummary(rows[i], holdsSource(originals, rows[i].source)));
      i = i + 1;
    }
    return out;
  }

  upload(modelId: string, sent: string): Outcome {
    if (sent == "") {
      return refusing("a body is required");
    }
    let body: DocumentUpload = JSON.parse<DocumentUpload>(sent);
    if (body.scope == "") {
      return refusing("a document needs a scope: \"/specs/plume\"");
    }
    if (modelId == "") {
      return refusing("name the embedding model: ?model=e1");
    }
    let embedderId = this.repository.embeddingId(modelId);
    if (embedderId == "") {
      return refusing("no usable embedding model " + modelId);
    }
    let provider = this.repository.embeddingProvider(modelId);
    let key = this.repository.credential(provider);
    if (key == "") {
      return refusing("no credential for " + provider);
    }
    let badName = sourceFault(body.source, body.body);
    if (badName != "") {
      return refusing(badName);
    }
    let ready = this.repository.prepareVectorTable(modelId);
    if (ready != "") {
      return refusing(ready);
    }
    let jobId = this.repository.queueUpload(body.source, normalScope(body.scope), embedderId, body.body, stamp());
    if (jobId == "") {
      return refusing("the document could not be queued");
    }
    let v: DocumentQueued = {
      job: jobId,
      source: body.source,
      scope: normalScope(body.scope),
      status: JOB_QUEUED,
    };
    return produced(JSON.stringify(v));
  }

  keepFile(sent: string): Outcome {
    if (sent == "") {
      return refusing("a body is required: {\"source\":\"...\",\"scope\":\"...\",\"filename\":\"...\",\"mime\":\"...\",\"contentBase64\":\"...\"}");
    }
    let ask: DocumentFileUpload = JSON.parse<DocumentFileUpload>(sent);
    let source = (ask.source ?? "").trim();
    if (source == "") {
      return refusing("a document needs a source to be filed under");
    }
    let scope = (ask.scope ?? "").trim();
    if (scope == "") {
      return refusing("a document needs a scope: \"/specs/plume\"");
    }
    let content = ask.contentBase64 ?? "";
    if (content == "") {
      return refusing("there are no bytes to keep");
    }
    if (content.length > FILE_BASE64_MAX) {
      return refusing("that file is too large to keep");
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
    let written = this.repository.saveFile(row);
    if (!written.ok) {
      return refusing(written.error);
    }
    let v: DocumentStored = { stored: true };
    return produced(JSON.stringify(v));
  }

  file(scope: string, source: string): DocumentFileRow {
    return this.repository.fileFor(scope, source);
  }

  /** What a question pulls back from the corpus.
   *
   *  The same retrieval an agent runs, offered directly so a person can see
   *  what their documents answer before wiring an agent to them. */
  passagesFor(modelId: string, scope: string, question: string, k: int): Outcome {
    if (question.trim() == "") {
      return refusing("ask something: ?q=how%20do%20refunds%20work");
    }
    if (k < 1 || k > 50) {
      return refusing("k is between 1 and 50");
    }
    let model = modelId == "" ? this.repository.firstEmbedder() : this.repository.embedder(modelId);
    if (model.id == "") {
      return refusing(modelId == ""
        ? "no embedding model is switched on — enable one under Settings, Models"
        : "no usable embedding model " + modelId);
    }
    let key = this.repository.credential(model.provider);
    if (key == "") {
      return refusing("no credential for " + model.provider);
    }
    let got = this.repository.nearest(model, scope, question, k, key);
    if (!got.ok) {
      return refusing(got.error);
    }
    let passages: DocumentPassage[] = [];
    let i: int = 0;
    while (i < got.found.length) {
      let one: DocumentPassage = {
        id: got.found[i].id,
        source: got.found[i].source,
        scope: got.found[i].scope,
        body: got.found[i].body,
        distance: got.found[i].distance,
      };
      passages.push(one);
      i = i + 1;
    }
    let answer: DocumentAnswer = {
      question: question,
      scope: normalScope(scope),
      model: model.apiName == "" ? model.id : model.apiName,
      found: passages,
    };
    return produced(JSON.stringify(answer));
  }

  remove(source: string): Outcome {
    let gone = this.repository.deleteBySource(source);
    if (!gone.ok) {
      return refusing("\"" + source + "\" is still in the corpus — the delete failed, so agents keep retrieving it.");
    }
    let filed = this.repository.forgetFiles(source);
    if (!filed.ok) {
      return refusing("\"" + source + "\" left the corpus, but its kept file could not be deleted.");
    }
    return produced("");
  }
}

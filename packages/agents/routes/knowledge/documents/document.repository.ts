import { Db } from "../../../../plume/driver.ts";
import { DbResult, deleteWhere, findById, listWhere, persist, placeholderAt } from "../../../../plume/plume.ts";
import { credentialFor } from "../../../credentials.ts";
import { DocumentFileRow, documentFileId, emptyDocumentFile } from "./document.utils.ts";
import { Retrieval, SourceListing, createDocuments, embeddingModel, listSources, normalScope, retrieve } from "../../../knowledge.ts";
import { ModelRow, modelsMapping, officeRendersMapping } from "../../../schema.ts";
import { OfficeRenderAsk, OfficeTexted, officeText } from "../../../office-render.ts";
import { documentRepository } from "./entities/document.entity.ts";
import { documentFileRepository } from "./entities/document-file.entity.ts";
import { JobRepository } from "../jobs/job.repository.ts";
import { IndexJobRow } from "../jobs/entities/index-job.entity.ts";

export class DocumentRepository {
  database: Db;
  master: string;

  constructor(database: Db, master: string) {
    this.database = database;
    this.master = master;
  }

  filedSources(scope: string): string[] {
    let out: string[] = [];
    let sql = "SELECT source FROM document_files WHERE scope = " + placeholderAt(this.database, 1);
    if (!this.database.query(sql, [normalScope(scope)])) {
      return out;
    }
    let i: int = 0;
    while (i < this.database.rows()) {
      out.push(this.database.value(i, 0));
      i = i + 1;
    }
    return out;
  }

  waitingJobs(scope: string): IndexJobRow[] {
    return new JobRepository(this.database).pending(scope);
  }

  indexedSources(scope: string): SourceListing[] {
    return listSources(this.database, scope);
  }

  embeddingId(modelId: string): string {
    return embeddingModel(this.database, modelId).id;
  }

  embeddingProvider(modelId: string): string {
    return embeddingModel(this.database, modelId).provider;
  }

  credential(provider: string): string {
    return credentialFor(this.database, provider, this.master);
  }

  embedder(modelId: string): ModelRow {
    return embeddingModel(this.database, modelId);
  }

  /** The first embedding model an operator has switched on, for callers that
   *  did not name one — the same choice the Knowledge page makes. */
  firstEmbedder(): ModelRow {
    let none = embeddingModel(this.database, "");
    let listed = listWhere(this.database, modelsMapping(),
      "kind = " + placeholderAt(this.database, 1), ["embedding"]);
    if (listed == "" || listed == "[]") {
      return none;
    }
    let rows = JSON.parse<ModelRow[]>(listed);
    let i: int = 0;
    while (i < rows.length) {
      if (rows[i].enabled) {
        return rows[i];
      }
      i = i + 1;
    }
    return none;
  }

  nearest(model: ModelRow, scope: string, question: string, k: int, key: string): Retrieval {
    let scopes: string[] = [normalScope(scope)];
    return retrieve(this.database, model, scopes, question, k, key);
  }

  prepareVectorTable(modelId: string): string {
    let embedder = embeddingModel(this.database, modelId);
    return createDocuments(this.database, embedder);
  }

  queueUpload(source: string, scope: string, modelId: string, body: string, now: string): string {
    return new JobRepository(this.database).enqueue(source, scope, modelId, body, now);
  }

  saveFile(row: DocumentFileRow): DbResult {
    return persist(this.database, documentFileRepository(), JSON.stringify(row));
  }

  /** What the document says, read by the platform rather than guessed at.
   *
   *  Keyed on the file's own id so a document previewed and a document
   *  indexed do not convert twice; version 1 because a kept file has no
   *  history, which is why forgetWords runs before every save. */
  readWords(row: DocumentFileRow, now: string): OfficeTexted {
    let ask: OfficeRenderAsk = {
      artifactId: "file:" + row.id,
      version: 1,
      path: row.filename,
      body: row.bytes,
      now: now,
    };
    return officeText(this.database, ask);
  }

  /** A file replaced under a name it already had is a different document, so
   *  nothing converted from the old bytes may outlive it. */
  forgetWords(fileId: string): DbResult {
    return deleteWhere(this.database, officeRendersMapping(),
      "artifact_id = " + placeholderAt(this.database, 1), ["file:" + fileId]);
  }

  fileFor(scope: string, source: string): DocumentFileRow {
    let document = findById(this.database, documentFileRepository(), documentFileId(scope, source));
    if (document == "") {
      return emptyDocumentFile();
    }
    let row: DocumentFileRow = JSON.parse<DocumentFileRow>(document);
    return row;
  }

  deleteBySource(source: string): DbResult {
    return deleteWhere(this.database, documentRepository(), "source = " + placeholderAt(this.database, 1), [source]);
  }

  forgetFiles(source: string): DbResult {
    return deleteWhere(this.database, documentFileRepository(), "source = " + placeholderAt(this.database, 1), [source]);
  }
}

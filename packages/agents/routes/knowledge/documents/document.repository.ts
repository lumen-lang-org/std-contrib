import { Db } from "../../../../plume/driver.ts";
import { DbResult, deleteWhere, findById, persist, placeholderAt } from "../../../../plume/plume.ts";
import { credentialFor } from "../../../credentials.ts";
import { DocumentFileRow, documentFileId, emptyDocumentFile } from "./document.utils.ts";
import { SourceListing, createDocuments, embeddingModel, listSources, normalScope } from "../../../knowledge.ts";
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

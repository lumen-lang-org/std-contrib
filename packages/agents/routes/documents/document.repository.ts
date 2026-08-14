import { Db } from "../../../plume/driver.ts";
import { DbResult, deleteWhere, findById, persist, placeholderAt } from "../../../plume/plume.ts";
import { credentialFor } from "../../credentials.ts";
import { DocumentFileRow, documentFileId, emptyDocumentFile, sourcesWithFiles } from "../../document-files.ts";
import { IndexJobRow, enqueue, pendingJobs } from "../../indexing.ts";
import { SourceListing, createDocuments, embeddingModel, listSources } from "../../knowledge.ts";
import { documentRepository } from "./entities/document.entity.ts";
import { documentFileRepository } from "./entities/document-file.entity.ts";

export class DocumentRepository {
  database: Db;
  master: string;

  constructor(database: Db, master: string) {
    this.database = database;
    this.master = master;
  }

  filedSources(scope: string): string[] {
    return sourcesWithFiles(this.database, scope);
  }

  waitingJobs(scope: string): IndexJobRow[] {
    return pendingJobs(this.database, scope);
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
    return enqueue(this.database, source, scope, modelId, body, now);
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

  forgetFiles(source: string): void {
    deleteWhere(this.database, documentFileRepository(), "source = " + placeholderAt(this.database, 1), [source]);
  }
}

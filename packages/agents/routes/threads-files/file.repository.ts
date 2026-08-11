import { Db } from "../../../plume/driver.ts";
import { findById } from "../../../plume/plume.ts";
import { credentialFor } from "../../credentials.ts";
import { Upload, documentsMapping, embeddingModel } from "../../knowledge.ts";
import { ownedThread } from "../../threads.ts";
import { FileWrite, WorkspaceFileRow, deleteFile, getFile, listFiles, promoteFile, putFile } from "../../workspace.ts";

export class FileRepository {
  database: Db;
  master: string;

  constructor(database: Db, master: string) {
    this.database = database;
    this.master = master;
  }

  threadOwner(threadId: string, tags: string[]): string {
    return ownedThread(this.database, threadId, tags);
  }

  listing(threadId: string): WorkspaceFileRow[] {
    return listFiles(this.database, threadId);
  }

  one(threadId: string, fileName: string): WorkspaceFileRow {
    return getFile(this.database, threadId, fileName);
  }

  save(write: FileWrite): string {
    return putFile(this.database, write);
  }

  document(documentId: string): string {
    return findById(this.database, documentsMapping(), documentId);
  }

  embeddingUsable(modelId: string): bool {
    return embeddingModel(this.database, modelId).id != "";
  }

  embeddingProvider(modelId: string): string {
    return embeddingModel(this.database, modelId).provider;
  }

  credential(provider: string): string {
    return credentialFor(this.database, provider, this.master);
  }

  promote(threadId: string, fileName: string, scope: string, modelId: string, key: string, now: string): Upload {
    let embedder = embeddingModel(this.database, modelId);
    return promoteFile(this.database, embedder, threadId, fileName, scope, key, now);
  }

  forget(threadId: string, fileName: string): string {
    return deleteFile(this.database, threadId, fileName);
  }
}

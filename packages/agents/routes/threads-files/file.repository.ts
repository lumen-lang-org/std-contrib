import { Db } from "../../../plume/driver.ts";
import { DbOrder, deleteById, findById, listOrdered, placeholderAt } from "../../../plume/plume.ts";
import { credentialFor } from "../../credentials.ts";
import { Upload, embeddingModel } from "../../knowledge.ts";
import { documentRepository } from "../documents/entities/document.entity.ts";
import { ownedThread } from "../../threads.ts";
import { workspaceFileRepository } from "./entities/workspace-file.entity.ts";
import { FileWrite, WorkspaceFileRow, getFile, promoteFile, putFile } from "../../workspace.ts";

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
    let none: WorkspaceFileRow[] = [];
    let keys: DbOrder[] = [{ column: "file_name" }];
    let listed = listOrdered(this.database, workspaceFileRepository(), {
      where: "thread_id = " + placeholderAt(this.database, 1),
      args: [threadId],
      order: keys,
    });
    if (listed == "" || listed == "[]") {
      return none;
    }
    return JSON.parse<WorkspaceFileRow[]>(listed);
  }

  one(threadId: string, fileName: string): WorkspaceFileRow {
    return getFile(this.database, threadId, fileName);
  }

  save(write: FileWrite): string {
    return putFile(this.database, write);
  }

  document(documentId: string): string {
    return findById(this.database, documentRepository(), documentId);
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
    let gone = deleteById(this.database, workspaceFileRepository(), threadId + ":" + fileName);
    if (!gone.ok) {
      return gone.error;
    }
    return "";
  }
}

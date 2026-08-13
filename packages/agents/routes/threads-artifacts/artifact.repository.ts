import { Db } from "../../../plume/driver.ts";
import { DbAssignment, DbRepository, DbResult, findById, listWhere, placeholderAt, setOn } from "../../../plume/plume.ts";
import { ArtifactRow, ArtifactVersionRow, ArtifactWrite, ArtifactWritten, TurnArtifact, artifactsByTurn, artifactsForTurn, deleteArtifact, getVersion, listArtifacts, putArtifact } from "../../artifacts.ts";
import { artifactRepository } from "./entities/artifact.entity.ts";
import { OfficeRenderAsk, OfficeRendered, officeRender } from "../../office-render.ts";
import { jsonList } from "../../scan.ts";
import { ownedThread, readableThread } from "../../threads.ts";

export class ArtifactRepository {
  database: Db;
  artifacts: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.artifacts = artifactRepository();
  }

  threadOwner(threadId: string, tags: string[]): string {
    return ownedThread(this.database, threadId, tags);
  }

  threadReader(threadId: string, tags: string[]): string {
    return readableThread(this.database, threadId, tags);
  }

  listing(threadId: string): ArtifactRow[] {
    return listArtifacts(this.database, threadId);
  }

  ofThread(threadId: string): string[] {
    let where = "thread_id = " + placeholderAt(this.database, 1);
    return jsonList(listWhere(this.database, this.artifacts, where, [threadId]));
  }

  save(write: ArtifactWrite): ArtifactWritten {
    return putArtifact(this.database, write);
  }

  template(templateId: string): string {
    return findById(this.database, templatesMapping(), templateId);
  }

  templateFiles(templateId: string): string {
    let where = "template_id = " + placeholderAt(this.database, 1);
    return listWhere(this.database, templateFilesMapping(), where, [templateId]);
  }

  everyTurn(threadId: string): TurnArtifact[] {
    return artifactsByTurn(this.database, threadId);
  }

  oneTurn(threadId: string, turnSeq: int): TurnArtifact[] {
    return artifactsForTurn(this.database, threadId, turnSeq);
  }

  version(artifactId: string, wanted: int): ArtifactVersionRow {
    return getVersion(this.database, artifactId, wanted);
  }

  render(ask: OfficeRenderAsk): OfficeRendered {
    return officeRender(this.database, ask);
  }

  setPreviewToken(id: string, token: string, now: string): DbResult {
    let values: DbAssignment[] = [
      { column: "preview_token", value: token },
      { column: "updated_at", value: now },
    ];
    return setOn(this.database, this.artifacts, { id: id, values: values });
  }

  forget(threadId: string, path: string): string {
    return deleteArtifact(this.database, threadId, path);
  }
}

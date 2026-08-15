import { Db } from "../../../../plume/driver.ts";
import { findById, placeholderAt } from "../../../../plume/plume.ts";
import { ArtifactRow, ArtifactVersionRow, findByToken, getArtifact, noArtifactVersion, nextVersion } from "../../../artifacts.ts";
import { artifactVersionRepository } from "../threads-artifacts/entities/artifact-version.entity.ts";

export class PreviewRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  byToken(token: string): ArtifactRow {
    return findByToken(this.database, token);
  }

  bySiblingPath(threadId: string, path: string): ArtifactRow {
    return getArtifact(this.database, threadId, path);
  }

  version(artifactId: string, at: int): ArtifactVersionRow {
    let document = findById(this.database, artifactVersionRepository(), artifactId + ":" + `${at}`);
    if (document == "") {
      return noArtifactVersion(artifactId);
    }
    return JSON.parse<ArtifactVersionRow>(document);
  }

  newestVersion(artifactId: string): int {
    return nextVersion(this.database, artifactId) - 1;
  }

  versionCount(threadId: string): string {
    let sql = "SELECT COUNT(*) FROM artifact_versions"
      + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
      + " WHERE artifacts.thread_id = " + placeholderAt(this.database, 1);
    if (!this.database.query(sql, [threadId])) {
      return "0";
    }
    if (this.database.rows() == 0) {
      return "0";
    }
    return this.database.value(0, 0);
  }
}

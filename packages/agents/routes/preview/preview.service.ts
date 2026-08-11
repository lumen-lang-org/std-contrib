import { Db } from "../../../plume/driver.ts";
import { Reply, Respond } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { ArtifactRow, ArtifactVersionRow } from "../../artifacts.ts";
import { officeRender, officeRenderExt } from "../../office-render.ts";
import { PreviewRepository } from "./preview.repository.ts";
import { previewBytes, previewChrome, previewIsHtml, previewImagePage, previewPresentable, previewReply } from "./preview.utils.ts";

export class PreviewService {
  database: Db;
  repository: PreviewRepository;

  constructor(database: Db) {
    this.database = database;
    this.repository = new PreviewRepository(database);
  }

  artifactByToken(token: string): ArtifactRow {
    return this.repository.byToken(token);
  }

  siblingArtifact(threadId: string, path: string): ArtifactRow {
    return this.repository.bySiblingPath(threadId, path);
  }

  version(artifactId: string, at: int): ArtifactVersionRow {
    return this.repository.version(artifactId, at);
  }

  currentVersion(artifact: ArtifactRow): ArtifactVersionRow {
    let newest = this.repository.newestVersion(artifact.id);
    let current = this.repository.version(artifact.id, newest);
    if (current.id != "") {
      return current;
    }
    return this.repository.version(artifact.id, artifact.currentVersion);
  }

  versionReply(threadId: string): Reply {
    let reply = Respond(200, this.repository.versionCount(threadId), "text/plain; charset=utf-8");
    reply.headers.set("access-control-allow-origin", "*");
    reply.headers.set("cache-control", "no-store");
    return reply;
  }

  liveReply(token: string, facing: bool, artifact: ArtifactRow, body: string): Reply {
    let cache = "no-store";
    if (facing) {
      if (artifact.kind == "pdf") {
        return previewBytes(facing, crypto.base64Decode(body), "application/pdf", cache);
      }
      if (artifact.kind == "office" && officeRenderExt(artifact.path) != "") {
        let made = officeRender(this.database, { artifactId: artifact.id, version: artifact.currentVersion,
          path: artifact.path, body: body, now: stamp() });
        if (made.ok) {
          return previewBytes(facing, crypto.base64Decode(made.body), "application/pdf", cache);
        }
        return previewBytes(facing, made.fault, "text/plain; charset=utf-8", cache);
      }
    }
    let row = previewPresentable(facing, artifact);
    let served = body;
    if (row.kind == "image" && row.mime.startsWith("text/html")) {
      served = previewImagePage(row, body);
    }
    if (previewIsHtml(row.mime) && facing) {
      served = served + previewChrome(token, this.repository.versionCount(row.threadId));
    }
    return previewReply(facing, row, served, cache);
  }
}

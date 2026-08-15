import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, NotFound } from "../../../../rest/server.ts";
import { artifactExists } from "./preview.guard.ts";
import { PreviewService } from "./preview.service.ts";
import { previewFacing, previewPinnedReply } from "./preview.utils.ts";

@controller("/preview")
@bindings
export class PreviewApi {
  service: PreviewService;

  constructor(database: Db) {
    this.service = new PreviewService(database);
  }

  theArtifact(request: Request): Guarded {
    return artifactExists(this.service, request);
  }

  @Get("/:token")
  @Guard(theArtifact)
  preview(@PathVariable("token") token: string, @RequestParam("v", "") asked: int,
          @From(previewFacing) facing: bool): Reply {
    let artifact = this.service.artifactByToken(token);
    if (asked < 1) {
      let current = this.service.currentVersion(artifact);
      if (current.id == "") {
        return NotFound("artifact");
      }
      return this.service.liveReply(token, facing, artifact, current.body);
    }
    let row = this.service.version(artifact.id, asked);
    if (row.id == "") {
      return NotFound("artifact");
    }
    return previewPinnedReply(facing, artifact, row.body);
  }

  @Get("/:token/*path")
  @Guard(theArtifact)
  sibling(@PathVariable("token") token: string, @PathVariable("path") path: string,
          @From(previewFacing) facing: bool): Reply {
    let artifact = this.service.artifactByToken(token);
    if (path == "__version") {
      return this.service.versionReply(artifact.threadId);
    }
    let found = this.service.siblingArtifact(artifact.threadId, path);
    if (found.id == "") {
      return NotFound("artifact");
    }
    let row = this.service.version(found.id, found.currentVersion);
    if (row.id == "") {
      return NotFound("artifact");
    }
    return this.service.liveReply(token, facing, found, row.body);
  }
}

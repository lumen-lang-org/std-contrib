import { Db } from "../../../plume/driver.ts";
import { deleteById, existsById, findById, persist } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, NoContent, NotFound, Ok, OkJson, param } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { PROJECT_FILES_KEY, ProjectRow, emptyProject, projectsMapping, projectsOf, releaseThreads, rememberFilesThread } from "../../projects.ts";
import { jsonText } from "../../scan.ts";
import { openThread, rememberRouteKey, threadsMapping } from "../../threads.ts";
import { FilesThreadView } from "./types.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";

@controller("/projects")
@bindings
export class ProjectApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return Ok(projectsOf(this.db, owningTag(tags)));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a project yours"))
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (req.body == "") {
      return BadRequest("a body is required: {\"name\":\"...\",\"instructions\":\"...\"}");
    }
    let name = jsonText(req.body, "name");
    if (name == "") {
      return BadRequest("a project needs a name");
    }
    let row: ProjectRow = {
      id: crypto.randomUUID(),
      owner: owner,
      name: name,
      instructions: jsonText(req.body, "instructions"),
      filesThreadId: "",
      createdAt: stamp(),
    };
    let written = persist(this.db, projectsMapping(), JSON.stringify(row));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, projectsMapping(), row.id));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("project " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let name = jsonText(req.body, "name");
    let edited: ProjectRow = {
      id: mine.id, owner: mine.owner,
      name: name == "" ? mine.name : name,
      instructions: jsonText(req.body, "instructions"),
      filesThreadId: mine.filesThreadId,
      createdAt: mine.createdAt,
    };
    let written = persist(this.db, projectsMapping(), JSON.stringify(edited));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, projectsMapping(), mine.id));
  }

  @Delete("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("project " + id);
    }
    releaseThreads(this.db, mine.id);
    let gone = deleteById(this.db, projectsMapping(), mine.id);
    if (!gone.ok) {
      return BadRequest(gone.error);
    }
    return NoContent();
  }

  @Post("/:id/files-thread")
  filesThread(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("project " + id);
    }
    if (mine.filesThreadId != "") {
      if (existsById(this.db, threadsMapping(), mine.filesThreadId)) {
        let held: FilesThreadView = { threadId: mine.filesThreadId };
        return OkJson(held);
      }
    }
    let opened = openThread(this.db, { agentId: PROJECT_FILES_KEY, owner: mine.owner, now: stamp() });
    if (opened == "") {
      return BadRequest("the files thread could not be opened");
    }
    let stamped = rememberRouteKey(this.db, opened, PROJECT_FILES_KEY);
    if (stamped != "") {
      return BadRequest(stamped);
    }
    let noted = rememberFilesThread(this.db, mine.id, opened);
    if (noted != "") {
      return BadRequest(noted);
    }
    let v: FilesThreadView = { threadId: opened };
    return OkJson(v);
  }

  private owned(req: Request): ProjectRow {
    let document = findById(this.db, projectsMapping(), param(req, "id"));
    if (document == "") {
      return emptyProject();
    }
    let row: ProjectRow = JSON.parse<ProjectRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) {
      return emptyProject();
    }
    return row;
  }
}

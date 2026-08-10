import { Db } from "../../../plume/driver.ts";
import { deleteById, existsById, findById, persist } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { PROJECT_FILES_KEY, ProjectRow, emptyProject, projectsMapping, projectsOf, releaseThreads, rememberFilesThread } from "../../projects.ts";
import { jsonText } from "../../scan.ts";
import { openThread, rememberRouteKey, threadsMapping } from "../../threads.ts";

@controller("/projects")
export class ProjectApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(projectsOf(this.db, owningTag(tags)));
  }

  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a project yours");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"instructions\":\"...\"}");
    }
    let name = jsonText(req.body, "name");
    if (name == "") { return badRequest("a project needs a name"); }
    let row: ProjectRow = {
      id: crypto.randomUUID(),
      owner: owner,
      name: name,
      instructions: jsonText(req.body, "instructions"),
      filesThreadId: "",
      createdAt: stamp(),
    };
    let written = persist(this.db, projectsMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, projectsMapping(), row.id));
  }

  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("project " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    let name = jsonText(req.body, "name");
    let edited: ProjectRow = {
      id: mine.id, owner: mine.owner,
      name: name == "" ? mine.name : name,
      instructions: jsonText(req.body, "instructions"),
      filesThreadId: mine.filesThreadId,
      createdAt: mine.createdAt,
    };
    let written = persist(this.db, projectsMapping(), JSON.stringify(edited));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, projectsMapping(), mine.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("project " + param(req, "id")); }
    releaseThreads(this.db, mine.id);
    let gone = deleteById(this.db, projectsMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  @post("/:id/files-thread")
  filesThread(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("project " + param(req, "id")); }
    if (mine.filesThreadId != "") {
      if (existsById(this.db, threadsMapping(), mine.filesThreadId)) {
        return ok("{\"threadId\":" + JSON.stringify(mine.filesThreadId) + "}");
      }
    }
    let id = openThread(this.db, { agentId: PROJECT_FILES_KEY, owner: mine.owner, now: stamp() });
    if (id == "") { return badRequest("the files thread could not be opened"); }
    let stamped = rememberRouteKey(this.db, id, PROJECT_FILES_KEY);
    if (stamped != "") { return badRequest(stamped); }
    let noted = rememberFilesThread(this.db, mine.id, id);
    if (noted != "") { return badRequest(noted); }
    return ok("{\"threadId\":" + JSON.stringify(id) + "}");
  }

  private owned(req: Request): ProjectRow {
    let document = findById(this.db, projectsMapping(), param(req, "id"));
    if (document == "") { return emptyProject(); }
    let row: ProjectRow = JSON.parse<ProjectRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyProject(); }
    return row;
  }
}

import { Db } from "../../../plume/driver.ts";
import { deleteById, existsById, findById, persist } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { PROJECT_FILES_KEY, ProjectRow, emptyProject, projectsMapping, projectsOf, releaseThreads, rememberFilesThread } from "../../projects.ts";
import { jsonText } from "../../scan.ts";
import { openThread, rememberRouteKey, threadsMapping } from "../../threads.ts";

// The /projects routes.

// Projects: conversations grouped under one name and one set of standing
// instructions (projects.ts).
//
// The rows only, on TaskApi's posture throughout: lists scoped by owner so a
// stranger's project is absent rather than forbidden, creation refused to
// callers nobody can name, and every write through one private `owned` that
// answers strangers and missing ids identically. The instructions themselves
// reach the model in run.ts (`projectBriefing`), never through this class.
@controller("/projects")
export class ProjectApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  // This caller's projects, newest first — scoped for the reason TaskApi's
  // list is: a project's instructions are what somebody standing-orders every
  // conversation in it, and a list that leaked would be a list of those.
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
    // The task rule, for the task reason: a project is a standing instruction
    // block that rides every conversation filed under it, and it has to
    // belong to somebody. Both spellings of "not signed in" refused —
    // TaskApi.create records how testing only one waved guests through.
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
      // No workspace thread yet — `POST /:id/files-thread` opens it on the
      // first ask, so a project that only groups pays for no thread row.
      filesThreadId: "",
      createdAt: stamp(),
    };
    let written = persist(this.db, projectsMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, projectsMapping(), row.id));
  }

  // Rename, or rewrite the instructions. Both fields are read verbatim from
  // the body: an empty `name` keeps the old one — a project with no name
  // cannot be told apart in a sidebar — while `instructions` is taken as
  // sent, because "" is a meaningful value here (a project that only groups)
  // and a keep-on-empty rule would make the instructions impossible to clear.
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
      // Never editable from a body: which hidden thread holds the files is
      // the engine's fact, and a caller who could write it could point a
      // project at any thread whose artifacts would then brief every round.
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
    // The threads first, so they fall back to "no project" rather than
    // pointing at a row that is gone; projects.ts says what a dangling stamp
    // would cost. The conversations themselves are untouched — deleting the
    // folder is not deleting the letters.
    releaseThreads(this.db, mine.id);
    // The workspace thread, when there is one, stays behind as an orphan —
    // deliberately, not as an oversight. Nothing in the engine deletes a
    // thread row (the sweep only takes EMPTY ones, and a workspace with files
    // is not empty), and building a thread-delete for this one caller would
    // be a bigger change than the junk it clears. The orphan is invisible:
    // its route_key is 'project-files', which `listThreads` excludes.
    let gone = deleteById(this.db, projectsMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  // The project's files, or rather where they live: the id of the hidden
  // workspace thread whose artifacts they are. Opens the thread on the first
  // ask and answers the same id ever after, so the console can PUT files
  // through the ordinary `/threads/:id/artifacts` door without a second
  // wire shape for "a project file".
  //
  // No ordering worry with the "/:id" routes above: the router matches on
  // segment count, and nothing else in this class is two segments deep.
  @post("/:id/files-thread")
  filesThread(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("project " + param(req, "id")); }
    if (mine.filesThreadId != "") {
      // Answered from the row, but only while the thread is really there: an
      // operator's sweep could have taken a workspace opened and never
      // uploaded to (it is exactly the "empty thread" the sweep collects),
      // and answering a dead id would 404 every upload after.
      if (existsById(this.db, threadsMapping(), mine.filesThreadId)) {
        return ok("{\"threadId\":" + JSON.stringify(mine.filesThreadId) + "}");
      }
    }
    // The owner is the project's, never the caller's whole tag set — the same
    // one-owner rule `POST /threads` records. PROJECT_FILES_KEY as the agent
    // id because `ownedThread` reads an empty agent id as "no such thread";
    // projects.ts says so where the constant lives. No round ever runs here.
    let id = openThread(this.db, { agentId: PROJECT_FILES_KEY, owner: mine.owner, now: stamp() });
    if (id == "") { return badRequest("the files thread could not be opened"); }
    // The stamp that keeps it out of every sidebar (`listThreads` excludes
    // this key). Written before the project row points at the thread: a
    // half-done state must fail invisible, not visible.
    let stamped = rememberRouteKey(this.db, id, PROJECT_FILES_KEY);
    if (stamped != "") { return badRequest(stamped); }
    let noted = rememberFilesThread(this.db, mine.id, id);
    if (noted != "") { return badRequest(noted); }
    return ok("{\"threadId\":" + JSON.stringify(id) + "}");
  }

  // The row this caller may touch, or an empty one — TaskApi's helper, for
  // TaskApi's reason: every write goes through here rather than checking the
  // owner per route, and a stranger's project 404s exactly as a missing one.
  private owned(req: Request): ProjectRow {
    let document = findById(this.db, projectsMapping(), param(req, "id"));
    if (document == "") { return emptyProject(); }
    let row: ProjectRow = JSON.parse<ProjectRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyProject(); }
    return row;
  }
}

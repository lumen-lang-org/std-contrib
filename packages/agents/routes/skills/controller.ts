import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, countWhere, executeWith, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem, queryParam } from "../../../rest/server.ts";
import { utf8Length } from "../../artifacts.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { scriptEnvNameProblem } from "../../run-script.ts";
import { SkillFileRow, SkillRow, skillFilesMapping, skillsMapping } from "../../schema.ts";

export const SKILL_DESCRIPTION_MAX: int = 200;

export const SKILL_MAX: int = 16384;

export function skillProblem(row: SkillRow): string {
  if (row.skillName.trim() == "") { return "a skill needs a name — it is what use_skill is called with"; }
  if (row.visibility != "private" && row.visibility != "public") {
    return "visibility is 'private' or 'public' — nothing else";
  }
  if (row.featuredRank > 0 && row.visibility != "public") {
    return "a featured skill must be public — featured is promotion, not access, and a featured private skill is a button most users cannot press";
  }
  if (row.featuredRank < 0) { return "featuredRank is 0 (not featured) or a positive position"; }
  if (row.source != "local" && row.source != "repo") {
    return "source is 'local' (written here) or 'repo' (a copy of one a repository owns)";
  }
  if (row.source == "repo" && row.sourceUrl.trim() == "") {
    return "a skill from a repository has to say which one — sourceUrl is empty";
  }
  if (row.source == "local" && row.sourceUrl.trim() != "") {
    return "a local skill has no sourceUrl — set source to 'repo' if it came from one";
  }
  let named = scriptEnvNameProblem(row.skillName);
  if (named != "") { return "a skill name becomes a container path: " + named; }
  if (row.description.trim() == "") { return "a skill without a description cannot be chosen"; }
  if (utf8Length(row.description) > SKILL_DESCRIPTION_MAX) {
    return "a skill description is at most " + `${SKILL_DESCRIPTION_MAX}` + " bytes of UTF-8 — it is a line in every turn's briefing";
  }
  if (row.description.indexOf("\n") >= 0) { return "a skill description is one line"; }
  if (row.body.trim() == "") { return "an empty skill is not an instruction"; }
  if (utf8Length(row.body) > SKILL_MAX) {
    return "a skill body is at most " + `${SKILL_MAX}` + " bytes of UTF-8; ship the bulk as files";
  }
  return "";
}

export function skillFileProblem(row: SkillFileRow): string {
  if (row.path.trim() == "") { return "a skill file needs a name, such as enums.py"; }
  if (row.path.indexOf("/") >= 0 || row.path.indexOf("..") >= 0) {
    return "a skill file is a plain name inside its skill's directory — no slash, no dot-dot";
  }
  if (row.body == "") { return "an empty skill file carries nothing worth staging"; }
  if (utf8Length(row.body) > SKILL_MAX) {
    return "a skill file is at most " + `${SKILL_MAX}` + " bytes of UTF-8";
  }
  return "";
}

@controller("/skills")
export class SkillApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    if (queryParam(req, "featured", "") == "1") {
      let ranked: DbOrder[] = [asc("featured_rank")];
      return ok(listOrdered(this.db, skillsMapping(),
        "visibility = 'public' AND featured_rank > 0", [], ranked));
    }
    let keys: DbOrder[] = [asc("skill_name")];
    return ok(listOrdered(this.db, skillsMapping(), "", [], keys));
  }

  @get("/:id")
  find(req: Request): Reply {
    let held = findById(this.db, skillsMapping(), param(req, "id"));
    if (held == "") { return notFound("skill " + param(req, "id")); }
    return ok(held);
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, skillsMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: SkillRow = JSON.parse<SkillRow>(req.body);
    let named = skillProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, skillsMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    let row: SkillRow = JSON.parse<SkillRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let before: SkillRow = JSON.parse<SkillRow>(findById(this.db, skillsMapping(), param(req, "id")));
    if (before.source == "repo") {
      return badRequest("this skill comes from " + before.sourceUrl
        + " and is edited there; copy it to a local skill to change it here");
    }
    let named = skillProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, skillsMapping(), param(req, "id")));
  }

  @post("/:id/copy")
  copyLocal(req: Request): Reply {
    let held = findById(this.db, skillsMapping(), param(req, "id"));
    if (held == "") { return notFound("skill " + param(req, "id")); }
    let from: SkillRow = JSON.parse<SkillRow>(held);
    if (from.source != "repo") {
      return badRequest("this skill is already yours to edit — copying it would only make a second name for the same instructions");
    }
    let base = from.skillName + "-local";
    let name = base;
    let n: int = 2;
    while (countWhere(this.db, skillsMapping(), "skill_name = " + placeholderAt(this.db, 1), [name]) > 0) {
      name = base + "-" + `${n}`;
      n = n + 1;
    }
    let made: SkillRow = {
      id: crypto.randomUUID(),
      skillName: name,
      description: from.description,
      body: from.body,
      updatedAt: `${Date.now()}`,
      visibility: "private",
      featuredRank: 0,
      source: "local",
      sourceUrl: "",
    };
    let written = persist(this.db, skillsMapping(), JSON.stringify(made));
    if (!written.ok) { return badRequest(written.error); }
    let listed = listWhere(this.db, skillFilesMapping(),
      "skill_id = " + placeholderAt(this.db, 1), [from.id]);
    let files: SkillFileRow[] = listed == "" || listed == "[]"
      ? [] : JSON.parse<SkillFileRow[]>(listed);
    let f: int = 0;
    while (f < files.length) {
      let copy: SkillFileRow = {
        id: crypto.randomUUID(),
        skillId: made.id,
        path: files[f].path,
        body: files[f].body,
      };
      let fileWritten = persist(this.db, skillFilesMapping(), JSON.stringify(copy));
      if (!fileWritten.ok) { return badRequest(fileWritten.error); }
      f = f + 1;
    }
    return created(findById(this.db, skillsMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    executeWith(this.db, "DELETE FROM agent_skills WHERE skill_id = " + this.db.placeholder, [param(req, "id")]);
    deleteWhere(this.db, skillFilesMapping(), "skill_id = " + placeholderAt(this.db, 1), [param(req, "id")]);
    deleteWhere(this.db, skillsMapping(), "id = " + placeholderAt(this.db, 1), [param(req, "id")]);
    return noContent();
  }

  @get("/:id/files")
  files(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    let keys: DbOrder[] = [asc("path")];
    return ok(listOrdered(this.db, skillFilesMapping(), "skill_id = " + placeholderAt(this.db, 1), [param(req, "id")], keys));
  }

  @post("/:id/files")
  addFile(req: Request): Reply {
    if (!existsById(this.db, skillsMapping(), param(req, "id"))) {
      return notFound("skill " + param(req, "id"));
    }
    let problem = createProblem(this.db, skillFilesMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: SkillFileRow = JSON.parse<SkillFileRow>(req.body);
    if (row.skillId != param(req, "id")) {
      return badRequest("the skillId in the body must match the path");
    }
    let named = skillFileProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, skillFilesMapping(), jsonId(req.body)));
  }

  @put("/:id/files/:fileId")
  updateFile(req: Request): Reply {
    if (!existsById(this.db, skillFilesMapping(), param(req, "fileId"))) {
      return notFound("skill file " + param(req, "fileId"));
    }
    let row: SkillFileRow = JSON.parse<SkillFileRow>(req.body);
    if (row.id != param(req, "fileId")) {
      return badRequest("the id in the body must match the path");
    }
    if (row.skillId != param(req, "id")) {
      return badRequest("the skillId in the body must match the path");
    }
    let named = skillFileProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, skillFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, skillFilesMapping(), param(req, "fileId")));
  }

  @del("/:id/files/:fileId")
  removeFile(req: Request): Reply {
    if (!existsById(this.db, skillFilesMapping(), param(req, "fileId"))) {
      return notFound("skill file " + param(req, "fileId"));
    }
    deleteWhere(this.db, skillFilesMapping(), "id = " + placeholderAt(this.db, 1), [param(req, "fileId")]);
    return noContent();
  }
}

// The /skills routes.

import { Db } from "../plume/driver.ts";
import { DbOrder, asc, countWhere, executeWith, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem, queryParam } from "../rest/server.ts";
import { utf8Length } from "./artifacts.ts";
import { createProblem, jsonId } from "./payload.ts";
import { scriptEnvNameProblem } from "./run-script.ts";
import { SkillFileRow, SkillRow, skillFilesMapping, skillsMapping } from "./schema.ts";

// The caps a skill is held to at the door. The description is a line in the
// system prompt of every turn of every conversation its agent has, so one
// bloated description taxes everything — 200 bytes, one line. The body and
// each file arrive only on use, but a runaway one would lean on the tool
// output cap every call, so 16 KB names the mistake earlier and better.
export const SKILL_DESCRIPTION_MAX: int = 200;

export const SKILL_MAX: int = 16384;

// Why a skill row will not be written. The name is held to the environment
// name rule because it becomes a container path segment — /skills/<name>/ —
// and the file rule below keeps a path inside that directory.
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
    // The chips row asks with ?featured=1: public, ranked, in rank order.
    // Everything else (the settings tab) gets the whole list by name.
    if (queryParam(req, "featured", "") == "1") {
      let ranked: DbOrder[] = [asc("featured_rank")];
      return ok(listOrdered(this.db, skillsMapping(),
        "visibility = 'public' AND featured_rank > 0", [], ranked));
    }
    let keys: DbOrder[] = [asc("skill_name")];
    return ok(listOrdered(this.db, skillsMapping(), "", [], keys));
  }

  // One row whole, body included — the edit form wants it. The full-agent
  // view is the one place bodies are excluded, because it is read per run.
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
    // A skill a repository owns is read here and changed there. Refused at the
    // door and not merely hidden in the console: the console is one caller,
    // and a rule that only one caller keeps is not a rule. What a person wants
    // when they reach this is almost always their own copy, so the message
    // says so rather than only saying no.
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

  // Your own copy of a skill a repository owns.
  //
  // The other half of read-only, and without it 'repo' is a one-way door: the
  // update route refuses the write and there is nothing else to do, so a
  // person who wants to change one word has no move at all. This is the move.
  //
  // A new name, not the same one. use_skill resolves by name against the
  // agent's attached skills and takes the first match, so two rows sharing a
  // name attached to one agent is a coin toss over which body answers —
  // "-local" says where this one came from and the suffix keeps counting if
  // that is taken too.
  //
  // Private and unfeatured whatever the original was: featuring is the
  // operator's curation of a shelf, and a copy quietly inheriting a place on
  // it would promote something nobody chose to promote. Files come across,
  // because a skill whose body says "run report.py" and whose report.py did
  // not follow is a copy that cannot do the thing it describes.
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
    // Read here rather than through tools.ts's skillFiles: this module does
    // not import that one, and reaching for a helper across that line to save
    // three statements is how a cycle starts.
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

  // Deleting a skill clears its links and files in the same route: there is
  // no fallback for a dangling link the way a script image has a deployment
  // default — it would just be a skill the console shows attached that the
  // run never offers.
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

  // The files a skill ships. Listed with the skill, replaced one by one; a
  // file's id is its own, so two skills can both ship an enums.py.
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

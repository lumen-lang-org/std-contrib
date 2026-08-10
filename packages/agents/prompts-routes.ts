// The /prompts routes.

import { Db } from "../plume/driver.ts";
import { DbOrder, asc, desc, existsById, findById, listOrdered, pageOrdered, persist } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, ok, queryParam } from "../rest/server.ts";
import { PromptRow, promptsMapping } from "./schema.ts";

// The highest version a prompt name has, 0 when it has none.
function maxVersion(db: Db, name: string): int {
  let newest: DbOrder[] = [desc("version")];
  let page = pageOrdered(db, promptsMapping(), "prompt_name = " + db.placeholder, [name], newest, 1, 0);
  if (page == "" || page == "[]") { return 0; }
  let rows: PromptRow[] = JSON.parse<PromptRow[]>(page);
  if (rows.length == 0) { return 0; }
  return rows[0].version;
}

@controller("/prompts")
export class PromptApi {
  db: Db;
  constructor(db: Db) { this.db = db; }

  // All versions, or one name's versions newest first — the roll-back view.
  @get("/")
  list(req: Request): Reply {
    let name = queryParam(req, "name", "");
    if (name == "") {
      let keys: DbOrder[] = [asc("prompt_name"), asc("version")];
      return ok(listOrdered(this.db, promptsMapping(), "", [], keys));
    }
    let newest: DbOrder[] = [desc("version")];
    return ok(listOrdered(this.db, promptsMapping(), "prompt_name = " + this.db.placeholder, [name], newest));
  }

  // A prompt row is never edited, so the only write is a new version. Both
  // the version and the id are assigned here rather than taken from the
  // caller:
  //
  // - the version, because letting a caller pick one is how two writers both
  //   create version 4;
  // - the id, because a caller with no id to hand reaches for one it already
  //   knows, and an id that is already a row turns a create into an edit. A
  //   POST that reused an id was observed replacing version 3's text in place
  //   while every agent pointing at it silently changed behaviour. An id it
  //   sends is still honoured, and still refused if taken.
  @post("/")
  create(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let body: PromptRow = JSON.parse<PromptRow>(req.body);
    if (body.promptName == "") { return badRequest("promptName is required"); }
    if (body.body == "") { return badRequest("an empty prompt is not a version"); }
    let id = body.id;
    if (id == "") { id = crypto.randomUUID(); }
    if (existsById(this.db, promptsMapping(), id)) {
      return badRequest("prompt \"" + id + "\" already exists; a new version is a new row, so leave \"id\" out or send an unused one");
    }
    let next = 1 + maxVersion(this.db, body.promptName);
    let row: PromptRow = { id: id, promptName: body.promptName, version: next, body: body.body, createdAt: body.createdAt };
    let written = persist(this.db, promptsMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, promptsMapping(), id));
  }
}

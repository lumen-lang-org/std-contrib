// The /script-images routes.

import { Db } from "../plume/driver.ts";
import { DbOrder, asc, existsById, findById, listOrdered, persist, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../rest/server.ts";
import { createProblem, jsonId } from "./payload.ts";
import { ScriptImageRow, scriptImagesMapping } from "./schema.ts";

// Why an image row will not be written. A label to pick it by, and an image
// reference that is one word with no shell metacharacters — it becomes an
// argv entry to docker, never a shell string, but a reference carrying a
// space or a quote is a mistake worth naming at the door.
export function scriptImageProblem(row: ScriptImageRow): string {
  if (row.label.trim() == "") { return "an image needs a label to pick it by"; }
  if (row.image.trim() == "") { return "an image needs a reference, such as agents-runtime:1"; }
  let i: int = 0;
  while (i < row.image.length) {
    let c = row.image.charCodeAt(i);
    if (c <= 32 || c == 34 || c == 39 || c == 96 || c == 36 || c == 59) {
      return "an image reference is one word: \"" + row.image + "\" carries a space or a shell character";
    }
    i = i + 1;
  }
  return "";
}

// The images an operator will run scripts in.
//
// Curated, and by an operator rather than by a model: run_script builds a
// conversation's container from the agent's chosen row, and a model that
// could name its own image could make this server pull anything off the
// internet and execute it. So the set lives here, an agent points at one, and
// nothing on the model's side of the wire names an image at all.
@controller("/script-images")
export class ScriptImageApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("label")];
    return ok(listOrdered(this.db, scriptImagesMapping(), "", [], keys));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, scriptImagesMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: ScriptImageRow = JSON.parse<ScriptImageRow>(req.body);
    let named = scriptImageProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, scriptImagesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, scriptImagesMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, scriptImagesMapping(), param(req, "id"))) {
      return notFound("script image " + param(req, "id"));
    }
    let row: ScriptImageRow = JSON.parse<ScriptImageRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let named = scriptImageProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, scriptImagesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, scriptImagesMapping(), param(req, "id")));
  }

  // Removing an image leaves the agents that pointed at it alone: their
  // environments fall back to the deployment default, which is a working
  // image by definition. Rewriting other rows from a delete would be a
  // surprise larger than the one it prevents.
  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, scriptImagesMapping(), param(req, "id"))) {
      return notFound("script image " + param(req, "id"));
    }
    deleteWhere(this.db, scriptImagesMapping(), "id = " + placeholderAt(this.db, 1), [param(req, "id")]);
    return noContent();
  }
}

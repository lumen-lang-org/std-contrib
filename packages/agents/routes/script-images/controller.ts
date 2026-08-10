import { Db } from "../../../plume/driver.ts";
import { DbOrder, existsById, findById, listOrdered, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, problem } from "../../../rest/server.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { ScriptImageRow, scriptImagesMapping } from "../../schema.ts";

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

@controller("/script-images")
@bindings
export class ScriptImageApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(): Reply {
    let keys: DbOrder[] = [{ column: "label" }];
    return ok(listOrdered(this.db, scriptImagesMapping(), { order: keys }));
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
  update(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, scriptImagesMapping(), id)) {
      return notFound("script image " + id);
    }
    let row: ScriptImageRow = JSON.parse<ScriptImageRow>(req.body);
    if (row.id != id) {
      return badRequest("the id in the body must match the path");
    }
    let named = scriptImageProblem(row);
    if (named != "") { return badRequest(named); }
    let written = persist(this.db, scriptImagesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, scriptImagesMapping(), id));
  }

  @del("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, scriptImagesMapping(), id)) {
      return notFound("script image " + id);
    }
    deleteWhere(this.db, scriptImagesMapping(), "id = " + placeholderAt(this.db, 1), [id]);
    return noContent();
  }
}

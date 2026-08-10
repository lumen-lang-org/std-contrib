import { Db } from "../../../plume/driver.ts";
import { DbOrder, existsById, findById, listOrdered, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, NoContent, NotFound, Ok, Refused } from "../../../rest/server.ts";
import { createFault, jsonId } from "../../payload.ts";
import { ScriptImageRow, scriptImagesMapping } from "../../schema.ts";

export function scriptImageFault(row: ScriptImageRow): string {
  if (row.label.trim() == "") {
    return "an image needs a label to pick it by";
  }
  if (row.image.trim() == "") {
    return "an image needs a reference, such as agents-runtime:1";
  }
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

  @Get("/")
  list(): Reply {
    let keys: DbOrder[] = [{ column: "label" }];
    return Ok(listOrdered(this.db, scriptImagesMapping(), { order: keys }));
  }

  @Post("/")
  create(req: Request): Reply {
    let fault = createFault(this.db, scriptImagesMapping(), req.body);
    if (fault != "") {
      return BadRequest(fault);
    }
    let row: ScriptImageRow = JSON.parse<ScriptImageRow>(req.body);
    let named = scriptImageFault(row);
    if (named != "") {
      return BadRequest(named);
    }
    let written = persist(this.db, scriptImagesMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, scriptImagesMapping(), jsonId(req.body)));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, scriptImagesMapping(), id)) {
      return NotFound("script image " + id);
    }
    let row: ScriptImageRow = JSON.parse<ScriptImageRow>(req.body);
    if (row.id != id) {
      return BadRequest("the id in the body must match the path");
    }
    let named = scriptImageFault(row);
    if (named != "") {
      return BadRequest(named);
    }
    let written = persist(this.db, scriptImagesMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, scriptImagesMapping(), id));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, scriptImagesMapping(), id)) {
      return NotFound("script image " + id);
    }
    deleteWhere(this.db, scriptImagesMapping(), "id = " + placeholderAt(this.db, 1), [id]);
    return NoContent();
  }
}

import { Db } from "../../../plume/driver.ts";
import { DbOrder, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, NoContent, NotFound, Ok, OkJson, Refused } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { OfficeRenderAsk, officeRender, officeRenderExt } from "../../office-render.ts";
import { createFault, jsonId } from "../../payload.ts";
import { putFile } from "../../workspace.ts";
import { TemplatePdfView } from "./types.ts";

@controller("/templates")
@bindings
export class TemplateApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  list(@RequestParam("kind", "") kind: string): Reply {
    let keys: DbOrder[] = [{ column: "featured_rank" }, { column: "label" }];
    if (kind != "") {
      return Ok(listOrdered(this.db, templatesMapping(), {
        where: "visibility = 'public' AND kind = " + placeholderAt(this.db, 1),
        args: [kind],
        order: keys,
      }));
    }
    return Ok(listOrdered(this.db, templatesMapping(), {
      where: "visibility = 'public'",
      order: keys,
    }));
  }

  @Get("/:id")
  find(@PathVariable("id") id: string): Reply {
    let held = findById(this.db, templatesMapping(), id);
    if (held == "") {
      return NotFound("template " + id);
    }
    return Ok(held);
  }

  @Post("/")
  create(req: Request): Reply {
    let fault = createFault(this.db, templatesMapping(), req.body);
    if (fault != "") {
      return BadRequest(fault);
    }
    let written = persist(this.db, templatesMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, templatesMapping(), jsonId(req.body)));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, templatesMapping(), id)) {
      return NotFound("template " + id);
    }
    let written = persist(this.db, templatesMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, templatesMapping(), id));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, templatesMapping(), id)) {
      return NotFound("template " + id);
    }
    deleteWhere(this.db, templateFilesMapping(), "template_id = " + placeholderAt(this.db, 1),
      [id]);
    deleteById(this.db, templatesMapping(), id);
    return NoContent();
  }

  @Get("/:id/files")
  files(@PathVariable("id") id: string): Reply {
    let keys: DbOrder[] = [{ column: "path" }];
    return Ok(listOrdered(this.db, templateFilesMapping(), {
      where: "template_id = " + placeholderAt(this.db, 1),
      args: [id],
      order: keys,
    }));
  }

  @Post("/:id/files")
  addFile(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, templatesMapping(), id)) {
      return NotFound("template " + id);
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, templateFilesMapping(), jsonId(req.body)));
  }

  @Put("/:id/files/:fileId")
  putFile(req: Request, @PathVariable("fileId") fileId: string): Reply {
    if (!existsById(this.db, templateFilesMapping(), fileId)) {
      return NotFound("template file " + fileId);
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, templateFilesMapping(), fileId));
  }

  @Delete("/:id/files/:fileId")
  removeFile(@PathVariable("fileId") fileId: string): Reply {
    if (!existsById(this.db, templateFilesMapping(), fileId)) {
      return NotFound("template file " + fileId);
    }
    deleteById(this.db, templateFilesMapping(), fileId);
    return NoContent();
  }

  @Get("/:id/pdf")
  pdf(@PathVariable("id") id: string): Reply {
    let held = findById(this.db, templatesMapping(), id);
    if (held == "") {
      return NotFound("template " + id);
    }
    let tpl: TemplateRow = JSON.parse<TemplateRow>(held);
    if (tpl.visibility != "public") {
      return NotFound("template " + id);
    }

    let listed = listWhere(this.db, templateFilesMapping(),
      "template_id = " + placeholderAt(this.db, 1), [id]);
    let files: TemplateFileRow[] = listed == "" ? [] : JSON.parse<TemplateFileRow[]>(listed);
    let i: int = 0;
    while (i < files.length && officeRenderExt(files[i].path) == "") {
      i = i + 1;
    }
    if (i >= files.length) {
      return BadRequest("template " + tpl.label + " holds no document a PDF can be made of");
    }

    let ask: OfficeRenderAsk = {
      artifactId: "tpl:" + files[i].id, version: files[i].body.length,
      path: files[i].path, body: files[i].body, now: stamp(),
    };
    let made = officeRender(this.db, ask);
    if (!made.ok) {
      return BadRequest(made.fault);
    }
    let v: TemplatePdfView = { template: tpl.id, path: files[i].path,
      cached: made.cached, pdf: made.body };
    let out = OkJson(v);
    out.headers.set("cache-control", "public, max-age=3600");
    return out;
  }
}

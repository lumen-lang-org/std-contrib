import { Db } from "../../../plume/driver.ts";
import { DbOrder, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, okJson, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { OfficeRenderAsk, officeRender, officeRenderExt } from "../../office-render.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { putFile } from "../../workspace.ts";
import { TemplatePdfView } from "./types.ts";

@controller("/templates")
@bindings
export class TemplateApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(@RequestParam("kind", "") kind: string): Reply {
    let keys: DbOrder[] = [{ column: "featured_rank" }, { column: "label" }];
    if (kind != "") {
      return ok(listOrdered(this.db, templatesMapping(), { where: "visibility = 'public' AND kind = " + placeholderAt(this.db, 1), args: [kind], order: keys }));
    }
    return ok(listOrdered(this.db, templatesMapping(), { where: "visibility = 'public'", order: keys }));
  }

  @get("/:id")
  find(@PathVariable("id") id: string): Reply {
    let held = findById(this.db, templatesMapping(), id);
    if (held == "") { return notFound("template " + id); }
    return ok(held);
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, templatesMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let written = persist(this.db, templatesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, templatesMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, templatesMapping(), id)) {
      return notFound("template " + id);
    }
    let written = persist(this.db, templatesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, templatesMapping(), id));
  }

  @del("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, templatesMapping(), id)) {
      return notFound("template " + id);
    }
    deleteWhere(this.db, templateFilesMapping(), "template_id = " + placeholderAt(this.db, 1),
      [id]);
    deleteById(this.db, templatesMapping(), id);
    return noContent();
  }

  @get("/:id/files")
  files(@PathVariable("id") id: string): Reply {
    let keys: DbOrder[] = [{ column: "path" }];
    return ok(listOrdered(this.db, templateFilesMapping(), { where: "template_id = " + placeholderAt(this.db, 1), args: [id], order: keys }));
  }

  @post("/:id/files")
  addFile(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, templatesMapping(), id)) {
      return notFound("template " + id);
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, templateFilesMapping(), jsonId(req.body)));
  }

  @put("/:id/files/:fileId")
  putFile(req: Request, @PathVariable("fileId") fileId: string): Reply {
    if (!existsById(this.db, templateFilesMapping(), fileId)) {
      return notFound("template file " + fileId);
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, templateFilesMapping(), fileId));
  }

  @del("/:id/files/:fileId")
  removeFile(@PathVariable("fileId") fileId: string): Reply {
    if (!existsById(this.db, templateFilesMapping(), fileId)) {
      return notFound("template file " + fileId);
    }
    deleteById(this.db, templateFilesMapping(), fileId);
    return noContent();
  }

  @get("/:id/pdf")
  pdf(@PathVariable("id") id: string): Reply {
    let held = findById(this.db, templatesMapping(), id);
    if (held == "") { return notFound("template " + id); }
    let tpl: TemplateRow = JSON.parse<TemplateRow>(held);
    if (tpl.visibility != "public") { return notFound("template " + id); }

    let listed = listWhere(this.db, templateFilesMapping(),
      "template_id = " + placeholderAt(this.db, 1), [id]);
    let files: TemplateFileRow[] = listed == "" ? [] : JSON.parse<TemplateFileRow[]>(listed);
    let i: int = 0;
    while (i < files.length && officeRenderExt(files[i].path) == "") { i = i + 1; }
    if (i >= files.length) {
      return badRequest("template " + tpl.label + " holds no document a PDF can be made of");
    }

    let ask: OfficeRenderAsk = {
      artifactId: "tpl:" + files[i].id, version: files[i].body.length,
      path: files[i].path, body: files[i].body, now: stamp(),
    };
    let made = officeRender(this.db, ask);
    if (!made.ok) { return badRequest(made.problem); }
    let v: TemplatePdfView = { template: tpl.id, path: files[i].path,
      cached: made.cached, pdf: made.body };
    let out = okJson(v);
    out.headers.set("cache-control", "public, max-age=3600");
    return out;
  }
}

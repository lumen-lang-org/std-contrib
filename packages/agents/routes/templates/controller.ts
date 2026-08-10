import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem, queryParam } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { OfficeRenderAsk, officeRender, officeRenderExt } from "../../office-render.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { putFile } from "../../workspace.ts";

@controller("/templates")
export class TemplateApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("featured_rank"), asc("label")];
    let kind = queryParam(req, "kind", "");
    if (kind != "") {
      return ok(listOrdered(this.db, templatesMapping(),
        "visibility = 'public' AND kind = " + placeholderAt(this.db, 1), [kind], keys));
    }
    return ok(listOrdered(this.db, templatesMapping(), "visibility = 'public'", [], keys));
  }

  @get("/:id")
  find(req: Request): Reply {
    let held = findById(this.db, templatesMapping(), param(req, "id"));
    if (held == "") { return notFound("template " + param(req, "id")); }
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
  update(req: Request): Reply {
    if (!existsById(this.db, templatesMapping(), param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    let written = persist(this.db, templatesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, templatesMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, templatesMapping(), param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    deleteWhere(this.db, templateFilesMapping(), "template_id = " + placeholderAt(this.db, 1),
      [param(req, "id")]);
    deleteById(this.db, templatesMapping(), param(req, "id"));
    return noContent();
  }

  @get("/:id/files")
  files(req: Request): Reply {
    let keys: DbOrder[] = [asc("path")];
    return ok(listOrdered(this.db, templateFilesMapping(),
      "template_id = " + placeholderAt(this.db, 1), [param(req, "id")], keys));
  }

  @post("/:id/files")
  addFile(req: Request): Reply {
    if (!existsById(this.db, templatesMapping(), param(req, "id"))) {
      return notFound("template " + param(req, "id"));
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, templateFilesMapping(), jsonId(req.body)));
  }

  @put("/:id/files/:fileId")
  putFile(req: Request): Reply {
    if (!existsById(this.db, templateFilesMapping(), param(req, "fileId"))) {
      return notFound("template file " + param(req, "fileId"));
    }
    let written = persist(this.db, templateFilesMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, templateFilesMapping(), param(req, "fileId")));
  }

  @del("/:id/files/:fileId")
  removeFile(req: Request): Reply {
    if (!existsById(this.db, templateFilesMapping(), param(req, "fileId"))) {
      return notFound("template file " + param(req, "fileId"));
    }
    deleteById(this.db, templateFilesMapping(), param(req, "fileId"));
    return noContent();
  }

  @get("/:id/pdf")
  pdf(req: Request): Reply {
    let held = findById(this.db, templatesMapping(), param(req, "id"));
    if (held == "") { return notFound("template " + param(req, "id")); }
    let tpl: TemplateRow = JSON.parse<TemplateRow>(held);
    if (tpl.visibility != "public") { return notFound("template " + param(req, "id")); }

    let listed = listWhere(this.db, templateFilesMapping(),
      "template_id = " + placeholderAt(this.db, 1), [param(req, "id")]);
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
    let out = ok("{\"template\":" + JSON.stringify(tpl.id)
      + ",\"path\":" + JSON.stringify(files[i].path)
      + ",\"cached\":" + (made.cached ? "true" : "false")
      + ",\"pdf\":" + JSON.stringify(made.body) + "}");
    out.headers.set("cache-control", "public, max-age=3600");
    return out;
  }
}

import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, existsById, findById, listOrdered } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { Manifest, fetchManifest, install, installProblem, itemsOf, manifestFrom, manifestUrl, uninstall } from "../../plugins.ts";
import { jsonText } from "../../scan.ts";
import { McpServerRow, SkillRow, mcpServersMapping, pluginsMapping, skillsMapping } from "../../schema.ts";

function manifestJson(m: Manifest, clash: string): string {
  let out = "{\"name\":" + JSON.stringify(m.pluginName)
    + ",\"description\":" + JSON.stringify(m.description)
    + ",\"version\":" + JSON.stringify(m.version)
    + ",\"problem\":" + JSON.stringify(clash)
    + ",\"skills\":[";
  let i: int = 0;
  while (i < m.skills.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"name\":" + JSON.stringify(m.skills[i].skillName)
      + ",\"description\":" + JSON.stringify(m.skills[i].description)
      + ",\"files\":" + `${m.skills[i].files.length}` + "}";
    i = i + 1;
  }
  out = out + "],\"connectors\":[";
  let c: int = 0;
  while (c < m.connectors.length) {
    if (c > 0) { out = out + ","; }
    out = out + "{\"name\":" + JSON.stringify(m.connectors[c].serverName)
      + ",\"endpoint\":" + JSON.stringify(m.connectors[c].endpoint)
      + ",\"authKind\":" + JSON.stringify(m.connectors[c].authKind) + "}";
    c = c + 1;
  }
  return out + "]}";
}

@controller("/plugins")
export class PluginApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("plugin_name")];
    return ok(listOrdered(this.db, pluginsMapping(), "", [], keys));
  }

  @get("/:id/items")
  items(req: Request): Reply {
    if (!existsById(this.db, pluginsMapping(), param(req, "id"))) {
      return notFound("plugin " + param(req, "id"));
    }
    let rows = itemsOf(this.db, param(req, "id"));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      let name = "";
      if (rows[i].kind == "skill") {
        let held = findById(this.db, skillsMapping(), rows[i].itemId);
        if (held != "") { name = JSON.parse<SkillRow>(held).skillName; }
      } else {
        let held = findById(this.db, mcpServersMapping(), rows[i].itemId);
        if (held != "") { name = JSON.parse<McpServerRow>(held).serverName; }
      }
      out = out + "{\"kind\":" + JSON.stringify(rows[i].kind)
        + ",\"itemId\":" + JSON.stringify(rows[i].itemId)
        + ",\"name\":" + JSON.stringify(name) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  @post("/inspect")
  inspect(req: Request): Reply {
    let url = jsonText(req.body, "sourceUrl");
    if (url.trim() == "") { return badRequest("a plugin is installed from a manifest URL"); }
    let got = fetchManifest(url);
    if (got.problem != "") { return badRequest(got.problem); }
    let m = manifestFrom(got.body);
    if (m.problem != "") { return badRequest(m.problem); }
    return ok(manifestJson(m, installProblem(this.db, m)));
  }

  @post("/install")
  add(req: Request): Reply {
    let url = jsonText(req.body, "sourceUrl");
    if (url.trim() == "") { return badRequest("a plugin is installed from a manifest URL"); }
    let got = fetchManifest(url);
    if (got.problem != "") { return badRequest(got.problem); }
    let m = manifestFrom(got.body);
    if (m.problem != "") { return badRequest(m.problem); }
    let clash = installProblem(this.db, m);
    if (clash != "") { return badRequest(clash); }
    let made = install(this.db, m, manifestUrl(url), stamp());
    return created(findById(this.db, pluginsMapping(), made.id));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, pluginsMapping(), param(req, "id"))) {
      return notFound("plugin " + param(req, "id"));
    }
    uninstall(this.db, param(req, "id"));
    return noContent();
  }
}

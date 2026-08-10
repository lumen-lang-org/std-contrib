import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, existsById, findById, listOrdered } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, okJson, param, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { Manifest, fetchManifest, install, installProblem, itemsOf, manifestFrom, manifestUrl, uninstall } from "../../plugins.ts";
import { jsonText } from "../../scan.ts";
import { McpServerRow, SkillRow, mcpServersMapping, pluginsMapping, skillsMapping } from "../../schema.ts";
import { ManifestConnectorView, ManifestSkillView, ManifestView, PluginItemView } from "./types.ts";

function manifestView(m: Manifest, clash: string): ManifestView {
  let skills: ManifestSkillView[] = [];
  let i: int = 0;
  while (i < m.skills.length) {
    let one: ManifestSkillView = {
      name: m.skills[i].skillName,
      description: m.skills[i].description,
      files: m.skills[i].files.length,
    };
    skills.push(one);
    i = i + 1;
  }
  let connectors: ManifestConnectorView[] = [];
  let c: int = 0;
  while (c < m.connectors.length) {
    let link: ManifestConnectorView = {
      name: m.connectors[c].serverName,
      endpoint: m.connectors[c].endpoint,
      authKind: m.connectors[c].authKind,
    };
    connectors.push(link);
    c = c + 1;
  }
  let v: ManifestView = {
    name: m.pluginName,
    description: m.description,
    version: m.version,
    problem: clash,
    skills: skills,
    connectors: connectors,
  };
  return v;
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
    let out: PluginItemView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let name = "";
      if (rows[i].kind == "skill") {
        let held = findById(this.db, skillsMapping(), rows[i].itemId);
        if (held != "") { name = JSON.parse<SkillRow>(held).skillName; }
      } else {
        let held = findById(this.db, mcpServersMapping(), rows[i].itemId);
        if (held != "") { name = JSON.parse<McpServerRow>(held).serverName; }
      }
      let one: PluginItemView = {
        kind: rows[i].kind,
        itemId: rows[i].itemId,
        name: name,
      };
      out.push(one);
      i = i + 1;
    }
    return okJson(out);
  }

  @post("/inspect")
  inspect(req: Request): Reply {
    let url = jsonText(req.body, "sourceUrl");
    if (url.trim() == "") { return badRequest("a plugin is installed from a manifest URL"); }
    let got = fetchManifest(url);
    if (got.problem != "") { return badRequest(got.problem); }
    let m = manifestFrom(got.body);
    if (m.problem != "") { return badRequest(m.problem); }
    let v: ManifestView = manifestView(m, installProblem(this.db, m));
    return okJson(v);
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

import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, existsById, findById, listOrdered } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { Manifest, fetchManifest, install, installProblem, itemsOf, manifestFrom, manifestUrl, uninstall } from "../../plugins.ts";
import { jsonText } from "../../scan.ts";
import { McpServerRow, SkillRow, mcpServersMapping, pluginsMapping, skillsMapping } from "../../schema.ts";

// The /plugins routes.

// A read manifest, as the console reads it back.
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

// Bundles, installed from a manifest somebody else publishes.
//
// Four routes and no editing: a plugin is not a form. Its skills and its
// connectors are ordinary rows the moment they land, and they are edited —
// or refused, in the case of a skill a repository owns — through the routes
// that already own those tables. What is here is the acquisition: what is
// installed, install one, look before you install, take it back out.
@controller("/plugins")
export class PluginApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("plugin_name")];
    return ok(listOrdered(this.db, pluginsMapping(), "", [], keys));
  }

  // What a plugin brought, by id, so the console can say "3 skills, 1
  // connector" without joining anything itself and can name them on the way
  // to a delete that will remove them.
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
      // A receipt whose row is gone reads as "" and is still listed: it is
      // the honest answer to "what did this bring", and hiding it would make
      // a plugin look smaller than the mess it left.
      out = out + "{\"kind\":" + JSON.stringify(rows[i].kind)
        + ",\"itemId\":" + JSON.stringify(rows[i].itemId)
        + ",\"name\":" + JSON.stringify(name) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Read a manifest and say what installing it would do — without doing it.
  //
  // The confirm step exists because a manifest is somebody else's code path
  // into this deployment's skill table, and "install" with no preview is a
  // button that does an unknown number of unknown things. It is also where a
  // name collision surfaces while it is still cheap.
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
    // Checked here and not only in the console: the console is one caller.
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

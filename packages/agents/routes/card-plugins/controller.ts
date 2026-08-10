import { Db } from "../../../plume/driver.ts";
import { asc, deleteById, findById, listOrdered, persist } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, notFound, ok, problem } from "../../../rest/server.ts";
import { stamp, toolCardProblem } from "../../api-core.ts";
import { CardCaseRow, CardPluginRow, cardCasesMapping, cardPluginsMapping } from "../../plugincards.ts";
import { install } from "../../plugins.ts";
import { jsonFlag, jsonRaw, jsonText } from "../../scan.ts";
import { ToolCardRow, toolCardsMapping } from "../../toolcards.ts";
import { CardInput, CaseInput } from "./types.ts";

// The /card-plugins routes.

function rawListOr(body: string, member: string): string {
  let raw = jsonRaw(body, member);
  if (raw == "") { return "[]"; }
  return raw;
}

// Card plugins: install, list, disable, remove.
//
// A plugin is the unit somebody actually manages — it owns its cards
// (/tool-cards, plugin_id) and its cases (below), so switching one off makes
// its markers stop being taught and its lines stop being briefed without
// deleting anything. See plugincards.ts for why that is a table rather than
// three unrelated rows.
//
// Install is deliberately one POST carrying the whole plugin: a plugin that
// arrives as four requests can half-arrive, and a half-installed plugin is a
// model told to emit a marker nothing draws.
@controller("/card-plugins")
export class CardPluginApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    return ok(listOrdered(this.db, cardPluginsMapping(), "", [], [asc("plugin_name")]));
  }

  // Everything the plugin is, in one body:
  //   {"id","pluginName","description","sourceUrl","version",
  //    "cards":[{"toolName","marker","payload","hint"}],
  //    "cases":[{"when","then"}]}
  @post("/")
  install(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let id = jsonText(req.body, "id");
    let name = jsonText(req.body, "pluginName");
    if (id == "") { return badRequest("a plugin needs an id"); }
    if (name == "") { return badRequest("a plugin needs a name"); }
    if (findById(this.db, cardPluginsMapping(), id) != "") {
      return badRequest("plugin " + id + " is already installed");
    }

    let plugin: CardPluginRow = {
      id: id, pluginName: name,
      description: jsonText(req.body, "description"),
      sourceUrl: jsonText(req.body, "sourceUrl"),
      version: jsonText(req.body, "version"),
      rendererUrl: jsonText(req.body, "rendererUrl"),
      rendererSource: jsonText(req.body, "rendererSource"),
      enabled: true, installedAt: stamp(),
    };

    // The cards first, so a refused marker refuses the whole install rather
    // than leaving a plugin row with nothing under it.
    let cards = JSON.parse<CardInput[]>(rawListOr(req.body, "cards"));
    let c: int = 0;
    while (c < cards.length) {
      let card: ToolCardRow = {
        id: id + ":" + `${c}`, pluginId: id,
        toolName: cards[c].toolName, marker: cards[c].marker,
        payload: cards[c].payload, hint: cards[c].hint, enabled: true,
      };
      let problem = toolCardProblem(card);
      if (problem != "") { return badRequest(problem); }
      c = c + 1;
    }

    persist(this.db, cardPluginsMapping(), JSON.stringify(plugin));
    let w: int = 0;
    while (w < cards.length) {
      let card: ToolCardRow = {
        id: id + ":" + `${w}`, pluginId: id,
        toolName: cards[w].toolName, marker: cards[w].marker,
        payload: cards[w].payload, hint: cards[w].hint, enabled: true,
      };
      persist(this.db, toolCardsMapping(), JSON.stringify(card));
      w = w + 1;
    }
    let cases = JSON.parse<CaseInput[]>(rawListOr(req.body, "cases"));
    let k: int = 0;
    while (k < cases.length) {
      let one: CardCaseRow = {
        id: id + ":case:" + `${k}`, pluginId: id,
        when: cases[k].when, then: cases[k].then,
      };
      persist(this.db, cardCasesMapping(), JSON.stringify(one));
      k = k + 1;
    }
    return ok(JSON.stringify(plugin));
  }

  // Off rather than gone. The rows stay and nothing is briefed — the state
  // for working out whether a plugin is what is making a model behave oddly.
  @put("/:id")
  change(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    let held = findById(this.db, cardPluginsMapping(), id);
    if (held == "") { return notFound("no plugin " + id); }
    let row: CardPluginRow = JSON.parse<CardPluginRow>(held);
    let after: CardPluginRow = {
      id: row.id, pluginName: row.pluginName, description: row.description,
      sourceUrl: row.sourceUrl, version: row.version,
      rendererUrl: row.rendererUrl, rendererSource: row.rendererSource,
      // Same trap as the captcha row, one controller over: a JSON boolean
      // false read as "" through jsonText, and "" != "false" is true — so
      // switching a plugin off with {"enabled":false} switched it ON. The
      // default when the member is absent is unchanged.
      enabled: jsonFlag(req.body, "enabled", true),
      installedAt: row.installedAt,
    };
    persist(this.db, cardPluginsMapping(), JSON.stringify(after));
    return ok(JSON.stringify(after));
  }

  // Uninstall takes exactly what the install created, by plugin_id — a card
  // somebody added by hand carries no plugin and survives, which is what the
  // person who added it expects.
  @del("/:id")
  remove(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, cardPluginsMapping(), id) == "") {
      return notFound("no plugin " + id);
    }
    deleteWhere(this.db, toolCardsMapping(), "plugin_id = " + this.db.placeholder, [id]);
    deleteWhere(this.db, cardCasesMapping(), "plugin_id = " + this.db.placeholder, [id]);
    deleteById(this.db, cardPluginsMapping(), id);
    return ok("{\"uninstalled\":" + JSON.stringify(id) + "}");
  }

  // Install from where the plugin lives, rather than from a body somebody
  // pasted. The url is fetched, and what comes back is the same manifest the
  // POST above takes — so a plugin is publishable as one JSON file, and the
  // row records where it came from, which is the first question when a card
  // draws wrongly.
  //
  // Nothing executable is fetched, and that is deliberate rather than
  // unfinished. A manifest names markers and cases; the RENDERER stays in the
  // console, looked up by marker. A plugin that could ship its own drawing
  // code would be a way to put markup of somebody else's choosing inside a
  // transcript, and no amount of sandboxing makes that a good trade for a
  // cycle chart. A marker with no renderer degrades to the model's own line.
  @post("/from-source")
  fromSource(req: Request): Reply {
    let url = jsonText(req.body, "sourceUrl");
    if (url == "") { return badRequest("a sourceUrl is required"); }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      return badRequest("a plugin source is an http(s) url");
    }
    let res = http.request(url, "GET", "", new Map<string, string>());
    if (!res.ok) { return badRequest("could not reach " + url); }
    if (res.status != 200) {
      return badRequest(url + " answered " + `${res.status}`);
    }
    // The manifest decides everything except where it came from: that is this
    // deployment's record of the install, not the publisher's claim about it.
    let manifest = res.body;
    if (jsonText(manifest, "id") == "") {
      return badRequest("that url did not answer a plugin manifest (no id)");
    }

    // The renderer, snapshotted NOW — the whole reason installs go through
    // this route. "./renderer.js" resolves against the manifest's own url, so
    // a repo can hold many plugins as folders. An install whose renderer
    // cannot be fetched is refused whole: a plugin row whose markers nothing
    // will ever draw is exactly the half-install this route exists to
    // prevent. A manifest that names no renderer installs fine — its markers
    // may be ones the console already draws.
    let rendererUrl = "";
    let rendererSource = "";
    let renderer = jsonText(manifest, "renderer");
    if (renderer != "") {
      rendererUrl = resolveAgainst(url, renderer);
      let fetched = http.request(rendererUrl, "GET", "", new Map<string, string>());
      if (!fetched.ok || fetched.status != 200) {
        return badRequest("the manifest names a renderer at " + rendererUrl
          + " and it could not be fetched — refusing a half-install");
      }
      rendererSource = fetched.body;
    }

    let withSource = injectSource(manifest, url, rendererUrl, rendererSource);
    let forward: Request = {
      method: "POST", path: "/card-plugins", body: withSource,
      params: req.params, query: req.query, headers: req.headers,
    };
    return this.install(forward);
  }

  // The snapshot, as the module the console's sandbox imports. Served from
  // this database rather than from the CDN it came from — see rendererSource
  // in plugincards.ts for the three reasons in order.
  @get("/:id/renderer")
  renderer(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    let held = findById(this.db, cardPluginsMapping(), id);
    if (held == "") { return notFound("no plugin " + id); }
    let row: CardPluginRow = JSON.parse<CardPluginRow>(held);
    if (row.rendererSource == "") { return notFound("plugin " + id + " ships no renderer"); }
    let reply: Reply = {
      status: 200, body: row.rendererSource,
      headers: new Map<string, string>([["Content-Type", "text/javascript; charset=utf-8"]]),
    };
    return reply;
  }

  // The cases, listed and edited on their own — a plugin's behaviour is
  // mostly these lines, and tuning one should not be a reinstall.
  @get("/:id/cases")
  cases(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    return ok(listWhere(this.db, cardCasesMapping(), "plugin_id = " + this.db.placeholder, [id]));
  }
}

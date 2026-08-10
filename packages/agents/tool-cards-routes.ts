// The /tool-cards routes.

import { Db } from "../plume/driver.ts";
import { asc, deleteById, findById, listOrdered, persist } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, notFound, ok, problem } from "../rest/server.ts";
import { toolCardProblem } from "./api-core.ts";
import { ToolCardRow, toolCardsMapping } from "./toolcards.ts";

// Whether this process is worth sending a request to, and which build it is.
//
// The one route that answers without a bearer token (`bearerRefused` below)
// and the one the gateway leaves public, because a probe that needs the
// secret cannot tell "the engine is down" from "the secret is wrong" — and
// those are different pages of the runbook.
// The announcement banner: one sentence the operator can put above every
// visitor's page — maintenance tonight, a new capability, a holiday notice —
// and take down again, all without a deploy.
// Which tool results the console draws as cards, as rows anybody can add.
//
// The engine's half of a card plugin. A row names a tool, a marker and the
// short payload the model should emit; run.ts appends the hint to that tool's
// successful results and knows nothing else about it. The console's half is
// the renderer, looked up by marker — so adding a card for a connector this
// package has never heard of is a POST here plus a renderer the console can
// find, and no change to either codebase.
@controller("/tool-cards")
export class ToolCardApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Read by the console on load, so it knows which markers to expect and can
  // brief a prompt with them. Carries no secret and names no person.
  @get("/")
  list(req: Request): Reply {
    return ok(listOrdered(this.db, toolCardsMapping(), "", [], [asc("tool_name")]));
  }

  @post("/")
  add(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let row: ToolCardRow = JSON.parse<ToolCardRow>(req.body);
    let problem = toolCardProblem(row);
    if (problem != "") { return badRequest(problem); }
    if (findById(this.db, toolCardsMapping(), row.id) != "") {
      return badRequest("tool card " + row.id + " already exists; PUT it to change it");
    }
    persist(this.db, toolCardsMapping(), JSON.stringify(row));
    return ok(JSON.stringify(row));
  }

  @put("/:id")
  change(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, toolCardsMapping(), id) == "") {
      return notFound("no tool card " + id);
    }
    let row: ToolCardRow = JSON.parse<ToolCardRow>(req.body);
    let problem = toolCardProblem(row);
    if (problem != "") { return badRequest(problem); }
    if (row.id != id) { return badRequest("the body's id must match the path"); }
    persist(this.db, toolCardsMapping(), JSON.stringify(row));
    return ok(JSON.stringify(row));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, toolCardsMapping(), id) == "") {
      return notFound("no tool card " + id);
    }
    deleteById(this.db, toolCardsMapping(), id);
    return ok("{\"deleted\":" + JSON.stringify(id) + "}");
  }
}

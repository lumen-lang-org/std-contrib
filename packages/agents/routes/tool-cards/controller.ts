import { Db } from "../../../plume/driver.ts";
import { deleteById, findById, listOrdered, persist } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, badRequest, notFound, ok, okJson, problem } from "../../../rest/server.ts";
import { toolCardProblem } from "../../api-core.ts";
import { ToolCardRow, toolCardsMapping } from "../../toolcards.ts";
import { ToolCardDeleted } from "./types.ts";

@controller("/tool-cards")
@bindings
export class ToolCardApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  list(req: Request): Reply {
    return ok(listOrdered(this.db, toolCardsMapping(), { order: [{ column: "tool_name" }] }));
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
    let v: ToolCardDeleted = { deleted: id };
    return okJson(v);
  }
}

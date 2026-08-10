import { Db } from "../../../plume/driver.ts";
import { deleteById, findById, listOrdered, persist } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, BadRequest, NotFound, Ok, OkJson, Refused } from "../../../rest/server.ts";
import { toolCardFault } from "../../api-core.ts";
import { ToolCardRow, toolCardsMapping } from "../../toolcards.ts";
import { ToolCardDeleted } from "./types.ts";

@controller("/tool-cards")
@bindings
export class ToolCardApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  list(req: Request): Reply {
    return Ok(listOrdered(this.db, toolCardsMapping(), { order: [{ column: "tool_name" }] }));
  }

  @Post("/")
  add(req: Request): Reply {
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let row: ToolCardRow = JSON.parse<ToolCardRow>(req.body);
    let fault = toolCardFault(row);
    if (fault != "") {
      return BadRequest(fault);
    }
    if (findById(this.db, toolCardsMapping(), row.id) != "") {
      return BadRequest("tool card " + row.id + " already exists; PUT it to change it");
    }
    persist(this.db, toolCardsMapping(), JSON.stringify(row));
    return Ok(JSON.stringify(row));
  }

  @Put("/:id")
  change(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, toolCardsMapping(), id) == "") {
      return NotFound("no tool card " + id);
    }
    let row: ToolCardRow = JSON.parse<ToolCardRow>(req.body);
    let fault = toolCardFault(row);
    if (fault != "") {
      return BadRequest(fault);
    }
    if (row.id != id) {
      return BadRequest("the body's id must match the path");
    }
    persist(this.db, toolCardsMapping(), JSON.stringify(row));
    return Ok(JSON.stringify(row));
  }

  @Delete("/:id")
  remove(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    if (findById(this.db, toolCardsMapping(), id) == "") {
      return NotFound("no tool card " + id);
    }
    deleteById(this.db, toolCardsMapping(), id);
    let v: ToolCardDeleted = { deleted: id };
    return OkJson(v);
  }
}

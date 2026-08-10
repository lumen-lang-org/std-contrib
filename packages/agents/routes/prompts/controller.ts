import { Db } from "../../../plume/driver.ts";
import { DbOrder, existsById, findById, listOrdered, pageOrdered, persist } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, Ok } from "../../../rest/server.ts";
import { PromptRow, promptsMapping } from "../../schema.ts";

function maxVersion(db: Db, name: string): int {
  let newest: DbOrder[] = [{ column: "version", direction: "desc" }];
  let page = pageOrdered(db, promptsMapping(), { where: "prompt_name = " + db.placeholder, args: [name], order: newest, limit: 1, offset: 0 });
  if (page == "" || page == "[]") {
    return 0;
  }
  let rows: PromptRow[] = JSON.parse<PromptRow[]>(page);
  if (rows.length == 0) {
    return 0;
  }
  return rows[0].version;
}

@controller("/prompts")
@bindings
export class PromptApi {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  list(@RequestParam("name", "") name: string): Reply {
    if (name == "") {
      let keys: DbOrder[] = [{ column: "prompt_name" }, { column: "version" }];
      return Ok(listOrdered(this.db, promptsMapping(), { order: keys }));
    }
    let newest: DbOrder[] = [{ column: "version", direction: "desc" }];
    return Ok(listOrdered(this.db, promptsMapping(), { where: "prompt_name = " + this.db.placeholder, args: [name], order: newest }));
  }

  @Post("/")
  create(req: Request): Reply {
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let body: PromptRow = JSON.parse<PromptRow>(req.body);
    if (body.promptName == "") {
      return BadRequest("promptName is required");
    }
    if (body.body == "") {
      return BadRequest("an empty prompt is not a version");
    }
    let id = body.id;
    if (id == "") {
      id = crypto.randomUUID();
    }
    if (existsById(this.db, promptsMapping(), id)) {
      return BadRequest("prompt \"" + id + "\" already exists; a new version is a new row, so leave \"id\" out or send an unused one");
    }
    let next = 1 + maxVersion(this.db, body.promptName);
    let row: PromptRow = { id: id, promptName: body.promptName, version: next, body: body.body, createdAt: body.createdAt };
    let written = persist(this.db, promptsMapping(), JSON.stringify(row));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, promptsMapping(), id));
  }
}

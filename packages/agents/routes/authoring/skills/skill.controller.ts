import { Db } from "../../../../plume/driver.ts";
import { filingAs } from "../../../api-core.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../../rest/server.ts";
import { skillExists, skillFileExists, skillOwned } from "./skill.guard.ts";
import { SkillService } from "./skill.service.ts";

@controller("/skills")
@bindings
export class SkillApi {
  skills: SkillService;

  constructor(database: Db) {
    this.skills = new SkillService(database);
  }

  theSkill(request: Request): Guarded {
    return skillExists(this.skills, request);
  }

  mySkill(request: Request): Guarded {
    return skillOwned(this.skills, request);
  }

  theFile(request: Request): Guarded {
    return skillFileExists(this.skills, request);
  }

  @Get("/")
  list(@RequestParam("featured", "") featured: string,
       @RequestParam("mine", "") mine: string,
       @From(filingAs) owner: string): Reply {
    return Ok(this.skills.listing(owner, featured == "1", mine == "true"));
  }

  @Get("/:id")
  @Guard(theSkill)
  find(@PathVariable("id") id: string): Reply {
    return Ok(this.skills.one(id));
  }

  @Post("/")
  create(@RequestBody body: string, @From(filingAs) owner: string): Reply {
    let made = this.skills.create(owner, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(mySkill)
  update(@PathVariable("id") id: string, @RequestBody body: string): Reply {
    return answered(this.skills.update(id, body));
  }

  @Post("/:id/copy")
  @Guard(theSkill)
  copyLocal(@PathVariable("id") id: string, @From(filingAs) owner: string): Reply {
    let made = this.skills.copyLocal(owner, id);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Delete("/:id")
  @Guard(mySkill)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.skills.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }

  @Get("/:id/files")
  @Guard(theSkill)
  files(@PathVariable("id") id: string): Reply {
    return Ok(this.skills.files(id));
  }

  @Post("/:id/files")
  @Guard(mySkill)
  addFile(@PathVariable("id") id: string, @RequestBody body: string): Reply {
    let made = this.skills.addFile(id, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id/files/:fileId")
  @Guard(mySkill)
  @Guard(theFile)
  updateFile(@PathVariable("id") id: string, @PathVariable("fileId") fileId: string,
             @RequestBody body: string): Reply {
    return answered(this.skills.updateFile(id, fileId, body));
  }

  @Delete("/:id/files/:fileId")
  @Guard(mySkill)
  @Guard(theFile)
  removeFile(@PathVariable("fileId") fileId: string): Reply {
    let gone = this.skills.forgetFile(fileId);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}

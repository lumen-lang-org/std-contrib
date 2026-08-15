import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok } from "../../../rest/server.ts";
import { templateExists, templateFileExists, templateIsPublic } from "./template.guard.ts";
import { TemplateService } from "./template.service.ts";

@controller("/templates")
@bindings
export class TemplateApi {
  templates: TemplateService;

  constructor(database: Db) {
    this.templates = new TemplateService(database);
  }

  theTemplate(request: Request): Guarded {
    return templateExists(this.templates, request);
  }

  theFile(request: Request): Guarded {
    return templateFileExists(this.templates, request);
  }

  thePublicTemplate(request: Request): Guarded {
    return templateIsPublic(this.templates, request);
  }

  @Get("/")
  list(@RequestParam("kind", "") kind: string): Reply {
    return Ok(this.templates.listing(kind));
  }

  @Get("/:id")
  @Guard(theTemplate)
  find(@PathVariable("id") id: string): Reply {
    return Ok(this.templates.one(id));
  }

  @Post("/")
  create(@RequestBody document: string): Reply {
    let made = this.templates.create(document);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theTemplate)
  update(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return answered(this.templates.update(id, document));
  }

  @Delete("/:id")
  @Guard(theTemplate)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.templates.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }

  @Get("/:id/files")
  files(@PathVariable("id") id: string): Reply {
    return Ok(this.templates.files(id));
  }

  @Post("/:id/files")
  @Guard(theTemplate)
  addFile(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    let made = this.templates.addFile(id, document);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id/files/:fileId")
  @Guard(theFile)
  putFile(@PathVariable("fileId") fileId: string, @RequestBody document: string): Reply {
    return answered(this.templates.updateFile(fileId, document));
  }

  @Delete("/:id/files/:fileId")
  @Guard(theFile)
  removeFile(@PathVariable("fileId") fileId: string): Reply {
    let gone = this.templates.forgetFile(fileId);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }

  @Get("/:id/pdf")
  @Guard(thePublicTemplate)
  pdf(@PathVariable("id") id: string): Reply {
    let made = this.templates.pdf(id);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    let out = Ok(made.document);
    out.headers.set("cache-control", "public, max-age=3600");
    return out;
  }

  // Prepares the conversation this starting point is: the project running, the
  // request that asked for it, and the reply. Offered afterwards, so what
  // people choose from is a conversation and not a recipe.
  @Post("/:id/prepare")
  @Guard(theTemplate)
  prepare(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    let made = this.templates.prepare(id, owner);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Ok(made.document);
  }
}

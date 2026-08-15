import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, OkJson } from "../../../rest/server.ts";
import { FilePull } from "./dtos/file-pull.dto.ts";
import { corpusIsPostgres, fileNamed, threadOwned } from "./file.guard.ts";
import { FileService } from "./file.service.ts";

@controller("/threads/:id/files")
@bindings
export class WorkspaceApi {
  files: FileService;

  constructor(database: Db, master: string) {
    this.files = new FileService(database, master);
  }

  needsPg(): Guarded {
    return corpusIsPostgres(this.files);
  }

  theThread(request: Request): Guarded {
    return threadOwned(this.files, request);
  }

  theFile(request: Request): Guarded {
    return fileNamed(this.files, request);
  }

  @Get("/")
  @Guard(theThread)
  list(@PathVariable("id") id: string): Reply {
    return OkJson(this.files.listing(id));
  }

  @Post("/")
  @Guard(theThread)
  upload(@PathVariable("id") id: string, @RequestBody sent: string): Reply {
    let made = this.files.upload(id, sent);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Get("/:name")
  @Guard(theThread)
  @Guard(theFile)
  read(@PathVariable("id") id: string, @PathVariable("name") name: string): Reply {
    return OkJson(this.files.one(id, name));
  }

  @Delete("/:name")
  @Guard(theThread)
  @Guard(theFile)
  remove(@PathVariable("id") id: string, @PathVariable("name") name: string): Reply {
    let fault = this.files.forget(id, name);
    if (fault != "") {
      return BadRequest(fault);
    }
    return NoContent();
  }

  @Post("/pull")
  @Guard(needsPg)
  @Guard(theThread)
  pull(@PathVariable("id") id: string, @RequestBody body: FilePull): Reply {
    let made = this.files.pull(id, body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Post("/:name/promote")
  @Guard(needsPg)
  @Guard(theThread)
  promote(@PathVariable("id") id: string, @PathVariable("name") name: string,
          @RequestBody sent: string): Reply {
    return answered(this.files.promote(id, name, sent));
  }
}

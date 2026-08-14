import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Accepted, BadRequest, Guarded, NoContent, NotFound, OkJson, Reply, answered } from "../../../rest/server.ts";
import { corpusIsPostgres } from "./document.guard.ts";
import { DocumentService } from "./document.service.ts";
import { documentFileViewOf } from "./document.utils.ts";

@controller("/documents")
@bindings
export class DocumentApi {
  documents: DocumentService;

  constructor(database: Db, master: string) {
    this.documents = new DocumentService(database, master);
  }

  needsPg(): Guarded {
    return corpusIsPostgres(this.documents);
  }

  @Get("/")
  @Guard(needsPg)
  list(@RequestParam("scope", "/") asked: string): Reply {
    return OkJson(this.documents.listing(asked));
  }

  @Post("/")
  @Guard(needsPg)
  upload(@RequestParam("model", "") modelId: string, @RequestBody sent: string): Reply {
    let outcome = this.documents.upload(modelId, sent);
    if (outcome.fault != "") {
      return BadRequest(outcome.fault);
    }
    return Accepted(outcome.document);
  }

  @Put("/file")
  @Guard(needsPg)
  keepFile(@RequestBody sent: string): Reply {
    return answered(this.documents.keepFile(sent));
  }

  @Get("/file")
  @Guard(needsPg)
  file(@RequestParam("source", "") source: string,
       @RequestParam("scope", "/") scope: string): Reply {
    if (source == "") {
      return BadRequest("name the document: ?source=notes&scope=/specs");
    }
    let kept = this.documents.file(scope, source);
    if (kept.id == "") {
      return NotFound("no kept file for " + source);
    }
    return OkJson(documentFileViewOf(kept));
  }

  @Delete("/:source")
  @Guard(needsPg)
  remove(@PathVariable("source") source: string): Reply {
    let gone = this.documents.remove(source);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}

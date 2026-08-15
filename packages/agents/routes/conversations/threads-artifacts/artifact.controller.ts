import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, NotFound, Ok, OkJson } from "../../../../rest/server.ts";
import { artifactAtSlot, threadOwned, threadReadable } from "./artifact.guard.ts";
import { ArtifactService } from "./artifact.service.ts";
import { slotFromPath, versionFromPath } from "./artifact.utils.ts";

@controller("/threads/:id/artifacts")
@bindings
export class ArtifactApi {
  artifacts: ArtifactService;

  constructor(database: Db) {
    this.artifacts = new ArtifactService(database);
  }

  theThread(request: Request): Guarded {
    return threadOwned(this.artifacts, request);
  }

  theReadableThread(request: Request): Guarded {
    return threadReadable(this.artifacts, request);
  }

  theArtifact(request: Request): Guarded {
    return artifactAtSlot(this.artifacts, request);
  }

  @Get("/")
  @Guard(theReadableThread)
  list(@PathVariable("id") id: string): Reply {
    return OkJson(this.artifacts.listing(id));
  }

  @Post("/")
  @Guard(theThread)
  create(@PathVariable("id") id: string, @RequestBody sent: string): Reply {
    let made = this.artifacts.create(id, sent);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Post("/from-template")
  @Guard(theThread)
  fromTemplate(@PathVariable("id") id: string, @RequestBody sent: string): Reply {
    let started = this.artifacts.fromTemplate(id, sent);
    if (started.absent != "") {
      return NotFound(started.absent);
    }
    if (started.fault != "") {
      return BadRequest(started.fault);
    }
    return Created(started.document);
  }

  @Get("/by-turn")
  @Guard(theReadableThread)
  byTurn(@PathVariable("id") id: string, @RequestParam("turn", "") turn: string): Reply {
    return OkJson(this.artifacts.byTurn(id, turn));
  }

  @Get("/:slot")
  @Guard(theReadableThread)
  @Guard(theArtifact)
  find(@PathVariable("id") id: string, @PathVariable("slot") slot: string): Reply {
    return OkJson(this.artifacts.one(id, slotFromPath(slot)));
  }

  @Get("/:slot/versions/:n")
  @Guard(theReadableThread)
  @Guard(theArtifact)
  version(@PathVariable("id") id: string, @PathVariable("slot") slot: string,
          @PathVariable("n") wanted: string): Reply {
    let found = this.artifacts.version(id, slotFromPath(slot), versionFromPath(wanted));
    if (found == "") {
      return NotFound("version " + wanted);
    }
    return Ok(found);
  }

  @Get("/:slot/pdf")
  @Guard(theReadableThread)
  @Guard(theArtifact)
  pdf(@PathVariable("id") id: string, @PathVariable("slot") slot: string,
      @RequestParam("v", "") asked: int): Reply {
    let made = this.artifacts.pdf(id, slotFromPath(slot), asked);
    if (made.absent != "") {
      return NotFound(made.absent);
    }
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    let out = Ok(made.document);
    if (asked > 0) {
      out.headers.set("cache-control", "private, max-age=31536000, immutable");
    }
    return out;
  }

  @Post("/:slot/rotate")
  @Guard(theThread)
  @Guard(theArtifact)
  rotate(@PathVariable("id") id: string, @PathVariable("slot") slot: string): Reply {
    return answered(this.artifacts.rotate(id, slotFromPath(slot)));
  }

  @Delete("/:slot")
  @Guard(theThread)
  @Guard(theArtifact)
  remove(@PathVariable("id") id: string, @PathVariable("slot") slot: string): Reply {
    let gone = this.artifacts.forget(id, slotFromPath(slot));
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}

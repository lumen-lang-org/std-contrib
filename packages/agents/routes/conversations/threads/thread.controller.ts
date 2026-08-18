import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request, OkJson } from "../../../../rest/server.ts";
import { callerTags, owningCaller } from "../../../api-core.ts";
import { threadOwned, threadReadable } from "./thread.guard.ts";
import { ThreadService } from "./thread.service.ts";

@controller("/threads")
@bindings
export class ThreadApi {
  threads: ThreadService;

  constructor(database: Db, master: string) {
    this.threads = new ThreadService(database, master);
  }

  theThread(request: Request): Guarded {
    return threadOwned(this.threads, request);
  }

  theReadableThread(request: Request): Guarded {
    return threadReadable(this.threads, request);
  }

  @Get("/replayable")
  replayable(@RequestParam("limit", "50") asked: string): Reply {
    return OkJson(this.threads.replayable(parseInt(asked) ?? 50));
  }

  @Put("/:id/replayable")
  @Guard(theThread)
  offer(@PathVariable("id") id: string, @RequestBody document: string): Reply {
    return this.threads.offer(id, document);
  }

  @Post("/:id/remix")
  remix(@PathVariable("id") id: string, @From(owningCaller) owner: string): Reply {
    return this.threads.remix(id, owner);
  }

  @Get("/")
  list(@From(callerTags) tags: string[],
       @RequestParam("limit", "50") asked: string,
       @RequestParam("offset", "0") offset: int,
       @RequestParam("project", "") project: string): Reply {
    return OkJson(this.threads.listing(tags, parseInt(asked) ?? 50, offset, project));
  }

  @Post("/from-story")
  fromStory(@RequestBody document: string, @From(owningCaller) owner: string): Reply {
    return this.threads.fromStory(document, owner);
  }

  @Post("/")
  open(@RequestBody document: string, @From(callerTags) tags: string[]): Reply {
    return this.threads.open(document, tags);
  }

  @Get("/:id/steps")
  @Guard(theThread)
  steps(@PathVariable("id") id: string, @RequestParam("seq", "") asked: string): Reply {
    return OkJson(this.threads.steps(id, asked));
  }

  @Post("/:id/cancel")
  @Guard(theThread)
  cancel(@PathVariable("id") id: string): Reply {
    return this.threads.cancel(id);
  }

  @Post("/:id/title")
  @Guard(theThread)
  title(@PathVariable("id") id: string, @RequestBody document: string,
        @From(callerTags) tags: string[]): Reply {
    return this.threads.title(id, document, tags);
  }

  @Post("/:id/messages")
  @Guard(theThread)
  say(@PathVariable("id") id: string, @RequestBody document: string,
      @From(callerTags) tags: string[]): Reply {
    return this.threads.say(id, document, tags);
  }

  @Get("/:id")
  @Guard(theReadableThread)
  transcript(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return OkJson(this.threads.transcript(id, tags));
  }
}

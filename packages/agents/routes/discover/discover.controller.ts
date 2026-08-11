import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, Ok, OkJson } from "../../../rest/server.ts";
import { FeedAsk } from "./dtos/feed-ask.dto.ts";
import { storyStillOnItsFeed } from "./discover.guard.ts";
import { DiscoverService } from "./discover.service.ts";
import { askedPrompt } from "./discover.utils.ts";

@controller("/discover")
@bindings
export class DiscoverApi {
  discover: DiscoverService;

  constructor(database: Db) {
    this.discover = new DiscoverService(database);
  }

  theStory(request: Request): Guarded {
    return storyStillOnItsFeed(this.discover, request);
  }

  @Get("/prompt")
  readPrompt(): Reply {
    return OkJson(this.discover.prompt());
  }

  @Put("/prompt")
  writePrompt(@RequestBody body: string): Reply {
    return answered(this.discover.writePrompt(askedPrompt(body)));
  }

  @Get("/")
  read(@RequestParam("lang", "") lang: string, @RequestParam("all", "") all: string,
       @RequestParam("country", "") country: string): Reply {
    return OkJson(this.discover.reading(lang, country, all == "1"));
  }

  @Get("/story/:id")
  @Guard(theStory)
  story(@PathVariable("id") id: string): Reply {
    return OkJson(this.discover.story(id));
  }

  @Get("/feeds")
  feeds(): Reply {
    return Ok(this.discover.feeds());
  }

  @Get("/places")
  places(): Reply {
    return OkJson(this.discover.places());
  }

  @Post("/feeds")
  addFeed(@Valid @RequestBody ask: FeedAsk): Reply {
    return answered(this.discover.addFeed(ask));
  }

  @Delete("/feeds/:id")
  dropFeed(@PathVariable("id") id: string): Reply {
    return answered(this.discover.dropFeed(id));
  }
}

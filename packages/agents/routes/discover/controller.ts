import { Db } from "../../../plume/driver.ts";
import { deleteById, listOrdered, persist } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, notFound, ok, okJson } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { DiscoverFeed, allFeeds, discoverFeedsMapping, discoverStoriesMapping, discoverText, discoverTextMapping, ensureGeoFeed, feedById, geoCode, setDiscoverText, storiesFor, storyById } from "../../discover.ts";
import { jsonText } from "../../scan.ts";
import { DeletedView, DiscoverFeedView, DiscoverStoryView, FeedAsk, PlaceView, PromptView, StoryDetailView } from "./types.ts";

const PROMPT_CHARS_MAX: int = 20000;

@controller("/discover")
export class DiscoverApi {
  @get("/prompt")
  readPrompt(req: Request): Reply {
    let held = discoverText(this.db, "digest-prompt");
    let v: PromptView = { prompt: held, usingDefault: held.trim() == "" };
    return okJson(v);
  }

  @put("/prompt")
  writePrompt(req: Request): Reply {
    let asked = jsonText(req.body, "prompt");
    if (asked.trim() == "") {
      deleteById(this.db, discoverTextMapping(), "digest-prompt");
      let cleared: PromptView = { prompt: "", usingDefault: true };
      return okJson(cleared);
    }
    if (asked.length > PROMPT_CHARS_MAX) {
      return badRequest("a prompt over " + `${PROMPT_CHARS_MAX}` + " characters is refused");
    }
    let problem = setDiscoverText(this.db, "digest-prompt", asked, stamp());
    if (problem != "") { return badRequest(problem); }
    let v: PromptView = { prompt: asked, usingDefault: false };
    return okJson(v);
  }

  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  read(req: Request,
       @RequestParam("lang", "") lang: string,
       @RequestParam("all", "") all: string): Reply {
    let country = geoCode(req.query.get("country") ?? "");
    if (country != "") { ensureGeoFeed(this.db, country); }
    let feeds = allFeeds(this.db);

    let out: DiscoverFeedView[] = [];
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      let langOk = feed.lang == "" || lang == "" || feed.lang == lang;
      let placeOk = feed.country == "" || feed.country == country;
      let showAll = all == "1";
      if (feed.enabled && (showAll || (langOk && placeOk))) {
        let rows = storiesFor(this.db, feed.id);
        if (showAll || rows.length > 0) {
          let stories: DiscoverStoryView[] = [];
          let r: int = 0;
          while (r < rows.length) {
            let story: DiscoverStoryView = {
              id: rows[r].id,
              feedId: rows[r].feedId,
              rank: rows[r].rank,
              headline: rows[r].headline,
              summary: rows[r].summary,
              sources: rows[r].sources,
              sourceTitles: rows[r].sourceTitles,
              fetchedAt: rows[r].fetchedAt,
              why: rows[r].why,
              madeAt: rows[r].madeAt,
              image: rows[r].image,
              readMinutes: rows[r].readMinutes,
              hasBody: rows[r].body != "",
            };
            stories.push(story);
            r = r + 1;
          }
          let view: DiscoverFeedView = {
            id: feed.id,
            topic: feed.topic,
            query: feed.query,
            enabled: feed.enabled,
            lang: feed.lang,
            country: feed.country,
            digestedAt: feed.digestedAt,
            stories: stories,
          };
          out.push(view);
        }
      }
      i = i + 1;
    }
    return okJson(out);
  }

  @get("/story/:id")
  story(@PathVariable("id") id: string): Reply {
    let row = storyById(this.db, id);
    if (row.id == "") {
      return notFound("story " + id + " has rolled off its feed");
    }
    let feed = feedById(this.db, row.feedId);

    let v: StoryDetailView = { story: row, topic: feed.topic, feedId: feed.id };
    return okJson(v);
  }

  @get("/feeds")
  feeds(req: Request): Reply {
    return ok(listOrdered(this.db, discoverFeedsMapping(), { order: [{ column: "topic" }] }));
  }

  @get("/places")
  places(req: Request): Reply {
    let feeds = allFeeds(this.db);
    let out: PlaceView[] = [];
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      if (feed.enabled && feed.country != ""
          && storiesFor(this.db, feed.id).length > 0) {
        let place: PlaceView = { country: feed.country };
        out.push(place);
      }
      i = i + 1;
    }
    return okJson(out);
  }

  @post("/feeds")
  addFeed(@Valid @RequestBody ask: FeedAsk): Reply {
    let row: DiscoverFeed = {
      id: ask.id,
      topic: ask.topic,
      query: ask.query,
      lang: ask.lang,
      country: ask.country,
      enabled: ask.enabled,
      digestedAt: ask.digestedAt,
    };
    persist(this.db, discoverFeedsMapping(), JSON.stringify(row));
    return okJson(row);
  }

  @del("/feeds/:id")
  dropFeed(@PathVariable("id") id: string): Reply {
    deleteWhere(this.db, discoverStoriesMapping(), "feed_id = " + this.db.placeholder, [id]);
    deleteById(this.db, discoverFeedsMapping(), id);
    let v: DeletedView = { deleted: id };
    return okJson(v);
  }
}

import { Db } from "../../../plume/driver.ts";
import { asc, deleteById, listOrdered, persist } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, notFound, ok, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { DiscoverFeed, allFeeds, discoverFeedsMapping, discoverStoriesMapping, discoverText, discoverTextMapping, ensureGeoFeed, feedById, geoCode, setDiscoverText, storiesFor, storyById } from "../../discover.ts";
import { jsonText } from "../../scan.ts";

@controller("/discover")
export class DiscoverApi {
  @get("/prompt")
  readPrompt(req: Request): Reply {
    let held = discoverText(this.db, "digest-prompt");
    return ok("{\"prompt\":" + JSON.stringify(held)
      + ",\"usingDefault\":" + (held.trim() == "" ? "true" : "false") + "}");
  }

  @put("/prompt")
  writePrompt(req: Request): Reply {
    let asked = jsonText(req.body, "prompt");
    if (asked.trim() == "") {
      deleteById(this.db, discoverTextMapping(), "digest-prompt");
      return ok("{\"prompt\":\"\",\"usingDefault\":true}");
    }
    if (asked.length > 20000) { return badRequest("a prompt over 20000 characters is refused"); }
    let problem = setDiscoverText(this.db, "digest-prompt", asked, stamp());
    if (problem != "") { return badRequest(problem); }
    return ok("{\"prompt\":" + JSON.stringify(asked) + ",\"usingDefault\":false}");
  }

  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  read(req: Request): Reply {
    let lang = req.query.get("lang") ?? "";
    let country = geoCode(req.query.get("country") ?? "");
    if (country != "") { ensureGeoFeed(this.db, country); }
    let feeds = allFeeds(this.db);

    let out = "[";
    let wrote: int = 0;
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      let langOk = feed.lang == "" || lang == "" || feed.lang == lang;
      let placeOk = feed.country == "" || feed.country == country;
      let all = req.query.get("all") == "1";
      if (feed.enabled && (all || (langOk && placeOk))) {
        let rows = storiesFor(this.db, feed.id);
        if (all || rows.length > 0) {
          if (wrote > 0) { out = out + ","; }
          out = out + "{\"id\":" + JSON.stringify(feed.id)
            + ",\"topic\":" + JSON.stringify(feed.topic)
            + ",\"query\":" + JSON.stringify(feed.query)
            + ",\"enabled\":" + (feed.enabled ? "true" : "false")
            + ",\"lang\":" + JSON.stringify(feed.lang)
            + ",\"country\":" + JSON.stringify(feed.country)
            + ",\"digestedAt\":" + JSON.stringify(feed.digestedAt)
            + ",\"stories\":[";
          let r: int = 0;
          while (r < rows.length) {
            if (r > 0) { out = out + ","; }
            out = out + "{\"id\":" + JSON.stringify(rows[r].id)
              + ",\"feedId\":" + JSON.stringify(rows[r].feedId)
              + ",\"rank\":" + `${rows[r].rank}`
              + ",\"headline\":" + JSON.stringify(rows[r].headline)
              + ",\"summary\":" + JSON.stringify(rows[r].summary)
              + ",\"sources\":" + JSON.stringify(rows[r].sources)
              + ",\"sourceTitles\":" + JSON.stringify(rows[r].sourceTitles)
              + ",\"fetchedAt\":" + JSON.stringify(rows[r].fetchedAt)
              + ",\"why\":" + JSON.stringify(rows[r].why)
              + ",\"madeAt\":" + JSON.stringify(rows[r].madeAt)
              + ",\"image\":" + JSON.stringify(rows[r].image)
              + ",\"readMinutes\":" + `${rows[r].readMinutes}`
              + ",\"hasBody\":" + (rows[r].body == "" ? "false" : "true") + "}";
            r = r + 1;
          }
          out = out + "]}";
          wrote = wrote + 1;
        }
      }
      i = i + 1;
    }
    return ok(out + "]");
  }

  @get("/story/:id")
  story(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    let row = storyById(this.db, id);
    if (row.id == "") {
      return notFound("story " + id + " has rolled off its feed");
    }
    let feed = feedById(this.db, row.feedId);

    return ok("{\"story\":" + JSON.stringify(row)
      + ",\"topic\":" + JSON.stringify(feed.topic)
      + ",\"feedId\":" + JSON.stringify(feed.id) + "}");
  }

  @get("/feeds")
  feeds(req: Request): Reply {
    return ok(listOrdered(this.db, discoverFeedsMapping(), "", [], [asc("topic")]));
  }

  @get("/places")
  places(req: Request): Reply {
    let feeds = allFeeds(this.db);
    let out = "[";
    let wrote: int = 0;
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      if (feed.enabled && feed.country != ""
          && storiesFor(this.db, feed.id).length > 0) {
        if (wrote > 0) { out = out + ","; }
        out = out + "{\"country\":" + JSON.stringify(feed.country) + "}";
        wrote = wrote + 1;
      }
      i = i + 1;
    }
    return ok(out + "]");
  }

  @post("/feeds")
  addFeed(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let row: DiscoverFeed = JSON.parse<DiscoverFeed>(req.body);
    if (row.id == "" || row.topic == "" || row.query == "") {
      return badRequest("a feed needs an id, a topic and a query");
    }
    persist(this.db, discoverFeedsMapping(), JSON.stringify(row));
    return ok(JSON.stringify(row));
  }

  @del("/feeds/:id")
  dropFeed(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    deleteWhere(this.db, discoverStoriesMapping(), "feed_id = " + this.db.placeholder, [id]);
    deleteById(this.db, discoverFeedsMapping(), id);
    return ok("{\"deleted\":" + JSON.stringify(id) + "}");
  }
}

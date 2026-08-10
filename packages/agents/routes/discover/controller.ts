import { Db } from "../../../plume/driver.ts";
import { asc, deleteById, listOrdered, persist } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, notFound, ok, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { DiscoverFeed, allFeeds, discoverFeedsMapping, discoverStoriesMapping, discoverText, discoverTextMapping, ensureGeoFeed, feedById, geoCode, setDiscoverText, storiesFor, storyById } from "../../discover.ts";
import { jsonText } from "../../scan.ts";

// The /discover routes.

@controller("/discover")
export class DiscoverApi {
  /* The digest prompt, as text an operator may edit.
   *
   * Under /discover and operator-only: this wording decides what every reader of
   * every feed is shown, which is not a public control. GET answers the override
   * or "" when the compiled default stands; PUT replaces it; DELETE returns to
   * the built-in. The tokens {topic}, {count} and {language} are substituted.
   */
  @get("/prompt")
  readPrompt(req: Request): Reply {
    let held = discoverText(this.db, "digest-prompt");
    return ok("{\"prompt\":" + JSON.stringify(held)
      + ",\"usingDefault\":" + (held.trim() == "" ? "true" : "false") + "}");
  }

  /* Writes here are operator-only by the console's own middleware, which admits a
   * guest to exactly one write path (/api/threads) and refuses every write under
   * /api/discover — the same gate the feed editor beside this route trusts. */
  @put("/prompt")
  writePrompt(req: Request): Reply {
    let asked = jsonText(req.body, "prompt");
    // A prompt that names none of its tokens still works; one that is blank is a
    // request for the default, and is answered as one rather than as an empty prompt
    // — the digest must never run with nothing to follow.
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
    // The first reader from a place creates its feed; the digest job fills it
    // on its next pass, from the index filtered to that country. Until then
    // they read the worldwide feeds like everybody else.
    if (country != "") { ensureGeoFeed(this.db, country); }
    let feeds = allFeeds(this.db);

    let out = "[";
    let wrote: int = 0;
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      // A feed matches when it names the caller's language, or no language —
      // the worldwide fallback. A PLACE is stricter: a feed that names a
      // country is only for callers who reported that country, so a reader
      // who said nothing about where they are never gets somebody's local
      // feed mixed into worldwide news.
      let langOk = feed.lang == "" || lang == "" || feed.lang == lang;
      let placeOk = feed.country == "" || feed.country == country;
      // `?all=1` drops both filters and the has-stories rule.
      //
      // The filters above are right for a READER: a feed naming a country belongs to
      // callers from there, and an empty feed is not a page. They are exactly wrong for
      // whoever runs the thing, because the feeds that need attention are the empty ones
      // and the ones for places the operator is not sitting in. The admin panel read
      // this route and concluded there were three feeds and no countries, while six
      // existed.
      //
      // A flag on the existing route rather than a route of its own: adding a method to
      // this controller makes the built binary panic in plume's migrate at startup,
      // reproducibly and before any request is served, which is a code-generation
      // problem in the compiler this deployment builds with and not something to work
      // around by guessing. Nothing here is sensitive — a feed is a topic, a place and
      // a query — so the flag costs no secrecy.
      let all = req.query.get("all") == "1";
      if (feed.enabled && (all || (langOk && placeOk))) {
        let rows = storiesFor(this.db, feed.id);
        if (all || rows.length > 0) {
          if (wrote > 0) { out = out + ","; }
          out = out + "{\"id\":" + JSON.stringify(feed.id)
            + ",\"topic\":" + JSON.stringify(feed.topic)
            // The query and the enabled flag: what this feed ASKS the index for, which
            // is the one setting that decides whether it can find anything. A reader has
            // no use for it; an operator has nothing without it — the admin panel drew
            // an empty column and could not compute how many stories were available,
            // because that check re-sends the feed's own query.
            + ",\"query\":" + JSON.stringify(feed.query)
            + ",\"enabled\":" + (feed.enabled ? "true" : "false")
            + ",\"lang\":" + JSON.stringify(feed.lang)
            + ",\"country\":" + JSON.stringify(feed.country)
            + ",\"digestedAt\":" + JSON.stringify(feed.digestedAt)
            + ",\"stories\":[";
          let r: int = 0;
          while (r < rows.length) {
            if (r > 0) { out = out + ","; }
            /* Field by field, and NOT `JSON.stringify(rows[r])`, which is what
               stood here before a story had a body. The body is up to twelve
               thousand characters; the feed draws six of them per topic across
               every topic that matches, so shipping it here would put a
               megabyte of article text into a page that shows two-sentence
               summaries. It travels on `/discover/story/:id`, where it is the
               point. */
            out = out + "{\"id\":" + JSON.stringify(rows[r].id)
              + ",\"feedId\":" + JSON.stringify(rows[r].feedId)
              + ",\"rank\":" + `${rows[r].rank}`
              + ",\"headline\":" + JSON.stringify(rows[r].headline)
              + ",\"summary\":" + JSON.stringify(rows[r].summary)
              + ",\"sources\":" + JSON.stringify(rows[r].sources)
              // Beside `sources` and read by position against it: what each of those
              // outlets called the story. Small — a few headlines — and it travels here
              // rather than being fetched per card so the console can render it on the
              // server, which a browser lookup after mount cannot do.
              + ",\"sourceTitles\":" + JSON.stringify(rows[r].sourceTitles)
              + ",\"fetchedAt\":" + JSON.stringify(rows[r].fetchedAt)
              + ",\"why\":" + JSON.stringify(rows[r].why)
              + ",\"madeAt\":" + JSON.stringify(rows[r].madeAt)
              + ",\"image\":" + JSON.stringify(rows[r].image)
              + ",\"readMinutes\":" + `${rows[r].readMinutes}`
              // Whether there is anything to open. A card that links to an
              // empty article is worse than one that does not link.
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

  /* One story, in full, for its own page.
   *
   * Public, like the feed it came off: `GUEST_GETS` in the console's
   * middleware holds "/api/discover" and matches by prefix, so this needs no
   * entry of its own.
   *
   * A missing row is answered with a SENTENCE and a 404 rather than a bare
   * one, because a missing row is the ordinary case here and not a fault. A
   * refresh replaces a feed's stories, so a link somebody sent this morning
   * outlives what it points at by design; the page turns this into "that
   * story has rolled off the feed" and offers the feed, which is a true and
   * useful thing to say. A blank error screen would suggest the site broke.
   */
  @get("/story/:id")
  story(req: Request): Reply {
    let id = req.params.get("id") ?? "";
    let row = storyById(this.db, id);
    if (row.id == "") {
      return notFound("story " + id + " has rolled off its feed");
    }
    let feed = feedById(this.db, row.feedId);

    /* Made readable on first open, then kept.
     *
     * Once per story, not once per reader: the second visitor gets the stored
     * column and no model call at all. That is the same argument the digest
     * loop makes for working on a schedule rather than per request — an
     * identical answer for everyone, so paying for it more than once buys
     * nothing but a spinner.
     *
     * It is done HERE and not where the digest writes the story because the
     * digest is off wherever AGENTS_DISCOVER_EVERY_MS is unset, which is every
     * deployment serving this page today. A column filled by a job that does
     * not run is a column that stays empty.
     *
     * A failure is silent by design: `readable` answers "" and the article
     * falls back to the raw body, which is what it showed before this existed. */
    /* Whatever is stored, and no model call on this path.
     *
     * The reflowed body is written by the scheduler's pass (scheduler.ts),
     * not here. It was here first, filled on first open, and the measurement
     * is the reason it moved: the first reader of a story waited 53 seconds
     * for a page that already had text to show. Nobody waits for a
     * presentation improvement.
     *
     * So a story opened before the sweep reaches it shows the raw body — what
     * this page showed before the column existed — and reads cleanly a minute
     * later. */
    return ok("{\"story\":" + JSON.stringify(row)
      + ",\"topic\":" + JSON.stringify(feed.topic)
      + ",\"feedId\":" + JSON.stringify(feed.id) + "}");
  }

  /** The feeds themselves, for whoever maintains them. */
  @get("/feeds")
  feeds(req: Request): Reply {
    return ok(listOrdered(this.db, discoverFeedsMapping(), "", [], [asc("topic")]));
  }

  /** The places that have a local feed with stories on it — what a country
   *  picker can honestly offer. Public like the feed, and only countries
   *  whose digest has produced something: a menu entry that opens an empty
   *  page is a broken promise, so a feed still waiting on its first pass is
   *  not listed. */
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

  /** Add one. A feed is a deliberate "this topic, in this language, for this
   *  place, has enough material to be worth digesting" — never a cross
   *  product, which for fifty thousand domains would be tens of thousands of
   *  model calls an hour to fill feeds nobody reads. */
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

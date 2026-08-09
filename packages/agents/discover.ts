// Discover: what the crawl found today, as stories rather than as results.
//
// The index is re-crawled continuously, so it always holds fresh pages — what
// it does not hold is any notion of which of them MATTER. A search answers "
// pages about X"; a person opening a console wants "what happened in X". The
// gap between those two is a model reading a pile of snippets and grouping
// them, which is what this file arranges.
//
// Two properties of the index shape everything here, one now outgrown:
//
//   * RECENCY IS THE INDEX'S, since 2026-08-06: `sort=recent` orders by
//     `published_at` falling back to `fetched_at`, and `since=` filters on
//     the same effective date — so a 2020 archive page re-crawled this
//     morning no longer reaches the model, which the fetch-time window here
//     could never say. The freshness window rides the query as `since=<n>h` and the
//     textual filter below survives as the safety net it was always going to
//     become. Publication dates are best-effort (~10% coverage, mostly URL
//     paths — `published_coverage` on /analytics says exactly); an undated
//     page behaves exactly as before.
//
//   * THIN SOURCE DIVERSITY. Today a topic's fresh results come from one or
//     two domains, so most stories will carry a single source. That is
//     reported honestly rather than dressed up: a story with one source says
//     one source. As the crawl widens, the same grouping produces the
//     multi-source stories the design is for, with no change here.
//
// The prompt lives in prompts/discover.md, written out and reasoned about.
// This file holds the machinery: fetch, filter, ask, parse.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, desc, createTableSql, field, findById, listOrdered, listWhere, deleteWhere, persist, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, modelsMapping } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { complete, replyText } from "./provider.ts";
import { retrieveWeb, searchApiBase } from "./webrag.ts";
import { urlEncode } from "./mcp-oauth.ts";
import { jsonList, jsonRaw, jsonText } from "./scan.ts";

/* How the digest is tuned, read from the environment on every pass.
 *
 * These three were compile-time constants, and that was the wrong shape for
 * them. Changing "how many cards" or "how far back" meant rebuilding a native
 * binary and restarting the engine - a deploy, with a rollback plan, to alter
 * a number somebody wants to try two values of. Worse, the numbers that
 * matter are exactly the ones you learn by watching a live feed: 36 hours and
 * six cards were reasonable guesses that measured badly, and the cost of
 * correcting a guess should be one line in a unit file.
 *
 * Defaults are the old values where they were sound and the measured ones
 * where they were not, so a deployment that sets nothing still behaves.
 * Floors, not just defaults: a zero or a negative read from the environment
 * would silently empty every feed, and a typo in a unit file should not be
 * able to do that. */
function freshHours(): int {
  let said = process.env["AGENTS_DISCOVER_FRESH_HOURS"] ?? "";
  if (said == "") { return 48; }
  let n = parseInt(said, 10) ?? 48;
  return n < 1 ? 1 : n;
}

/* How many results to read per topic. Eighty, not the original forty: that
 * pairing was sized for a 32k-context model, and the digest now runs on 131k
 * where the tail of an eighty-snippet prompt is still read. */
function readCap(): int {
  let said = process.env["AGENTS_DISCOVER_READ"] ?? "";
  if (said == "") { return 80; }
  let n = parseInt(said, 10) ?? 80;
  return n < 1 ? 1 : n;
}

/* The ceiling on cards per feed. Twelve rather than six - the pages this
 * feeds were showing one to five against indexes offering dozens. */
function storyCap(): int {
  let said = process.env["AGENTS_DISCOVER_STORIES"] ?? "";
  if (said == "") { return 12; }
  let n = parseInt(said, 10) ?? 12;
  return n < 1 ? 1 : n;
}

/* One feed the digest job maintains: a topic, for a language and a place.
 *
 * A ROW rather than a cross-product of every topic against every language
 * against every country. The index carries fifty thousand domains across
 * dozens of languages, and multiplying those out would be tens of thousands
 * of model calls an hour to fill feeds nobody reads. Each row is a deliberate
 * "this pair has enough material to be worth digesting", and the seeding
 * route below proposes them from the index's own analytics rather than from
 * a list somebody typed.
 *
 * `lang` and `country` are the index's own codes and may be "" — meaning "do
 * not filter by it". A topic with both empty is the worldwide feed. */
export type DiscoverFeed = {
  id: string,
  topic: string,
  query: string,
  lang: string,
  country: string,
  enabled: bool,
  // When the job last wrote stories for it. "" until the first pass, which is
  // what the page shows as "not digested yet" rather than as empty.
  digestedAt: string,
};

export type DiscoverStory = {
  headline: string,
  summary: string,
  sources: string[],
  // When the OLDEST source was fetched. Not a publication date — the index
  // knows when it fetched a page and never when the page was written, and a
  // model asked to infer one produces a confident wrong answer every time.
  fetchedAt: string,
  why: string,
};

/** A story as it is stored: the model's answer, flattened onto a feed. */
export type DiscoverRow = {
  id: string,
  feedId: string,
  rank: int,
  headline: string,
  summary: string,
  // The urls, joined by newline. A list column would be a second table for
  // data that is only ever read whole.
  sources: string,
  /* What each of those sources called the story, in the same order and joined the same
   * way — line n here is the headline for line n of `sources`.
   *
   * Written at digest time rather than looked up when somebody opens the article, and
   * the reason is not caching: the console renders on the server, and a title it has to
   * fetch from the browser cannot be in the first paint. The cards showed bare
   * hostnames and filled in a moment later. The digest already holds these — every
   * search hit carries its title, and they were being discarded once the model had read
   * them.
   *
   * Empty for rows digested before this column existed; the console asks the index for
   * those, which is what it did for all of them until now. */
  sourceTitles: string,
  fetchedAt: string,
  why: string,
  madeAt: string,
  /* What the crawl holds on this story, as markdown — the passages the index
   * has for the story's own sources, grouped under the host each came from.
   *
   * STORED, rather than fetched when somebody opens the article, and the
   * reason is not caching. `/search`, `/retrieve` and `/doc/<hash>` are all
   * operator-only in the console's index proxy, and Discover is a public
   * page; a visitor's browser cannot ask the index anything. So the body is
   * written where the digest already runs, holding the index credential, and
   * the article is served from this column like everything else on the page.
   *
   * It is not a republished article and the page does not present it as one:
   * it is what the crawler fetched, under the source's own name, next to a
   * link to the source. */
  body: string,
  /* The picture, when there is one — the `image` the index now answers with,
   * taken from whichever of this story's sources carries it.
   *
   * Sparse, and everything that draws it is built for that: about one crawled
   * page in twenty has one, so a card or an article with no picture is the
   * ordinary case and never a layout with a hole in it. */
  image: string,
  // Minutes, from the body's word count. Zero where there is no body.
  readMinutes: int,
  /* The body again, made readable — same facts, no crawl wreckage.
   *
   * What the crawler hands over is a page, not an article: image captions and
   * photo credits inline with the prose, half-eaten link syntax like
   * ")](#) F&F Van in Westchester (PRNewsfoto/Feast & Fettle) [", anchor
   * fragments, the whole press-release tail of boilerplate and
   * forward-looking statements, and the emphasis markers the source used
   * around its own bullet points arriving as literal underscores. It is
   * readable in the sense that the words are there.
   *
   * So a model reflows it once and the result is stored beside the raw text.
   * Not instead of: the raw body stays, because it is the evidence, and a
   * reformatting that goes wrong must not be the only copy left.
   *
   * "" means it has not been done yet — the article falls back to `body`,
   * which is what every story written before this column had. */
  bodyMd: string,
};

export function discoverFeedsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("topic", "topic", "text"),
    field("query", "query", "text"),
    field("lang", "lang", "text"),
    field("country", "country", "text"),
    field("enabled", "enabled", "bool"),
    field("digestedAt", "digested_at", "text"),
  ];
  return repository("discover_feeds", "id", "id", fs);
}

export function discoverStoriesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("feedId", "feed_id", "text"),
    field("rank", "rank", "int"),
    field("headline", "headline", "text"),
    field("summary", "summary", "text"),
    field("sources", "sources", "text"),
    field("sourceTitles", "source_titles", "text"),
    field("fetchedAt", "fetched_at", "text"),
    field("why", "why", "text"),
    field("madeAt", "made_at", "text"),
    field("body", "body", "text"),
    field("bodyMd", "body_md", "text"),
    field("image", "image", "text"),
    field("readMinutes", "read_minutes", "int"),
  ];
  return repository("discover_stories", "id", "id", fs);
}

/* The stories table AS 98.2 CREATED IT.
 *
 * A frozen copy, and it has to be one: `createTableSql` reads the mapping
 * above, the mapping has grown three columns, and a migration's SQL is
 * checksummed — so pointing 98.2 at the live mapping would change SQL that is
 * already applied on every deployment and the guard would refuse to start.
 * This is the second time that has been learned in this file's neighbourhood;
 * the frozen-copy shape is the one that works.
 *
 * Nothing may edit this. New columns are an ALTER at a new version, below. */
function storiesAsCreated(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("feedId", "feed_id", "text"),
    field("rank", "rank", "int"),
    field("headline", "headline", "text"),
    field("summary", "summary", "text"),
    field("sources", "sources", "text"),
    field("fetchedAt", "fetched_at", "text"),
    field("why", "why", "text"),
    field("madeAt", "made_at", "text"),
  ];
  return repository("discover_stories", "id", "id", fs);
}

/** Operator-written text the digest uses, keyed by name.
 *
 *  A prompt is CONTENT, not code. It lived in this file and every wording change
 *  meant compiling and restarting the engine — which is the wrong shape for the
 *  thing most likely to need a tweak at 2am, and the reason a feed drifting out of
 *  its language took a rebuild to correct. The compiled prompt below stays as the
 *  default and the fallback; a row here overrides it, is read on the next pass, and
 *  is editable from the console. */
export function discoverTextMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("value", "value", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("discover_text", "id", "id", fs);
}

/** The override for a named piece of text, or "" when the built-in stands. */
export function discoverText(db: Db, name: string): string {
  let held = findById(db, discoverTextMapping(), name);
  if (held == "") { return ""; }
  return jsonText(held, "value");
}

export function setDiscoverText(db: Db, name: string, value: string, now: string): string {
  let row = "{\"id\":" + JSON.stringify(name) + ",\"value\":" + JSON.stringify(value)
    + ",\"updatedAt\":" + JSON.stringify(now) + "}";
  let written = persist(db, discoverTextMapping(), row);
  if (!written.ok) { return written.error; }
  return "";
}

export function discoverPlan(db: Db): Migration[] {
  return [
    migration("98.1", "the feeds the digest job maintains",
      createTableSql(db, discoverFeedsMapping())),
    migration("98.2", "the stories it wrote",
      createTableSql(db, storiesAsCreated())),
    migration("98.3", "a story carries what the crawl holds on it",
      "ALTER TABLE discover_stories ADD COLUMN body " + db.textType + " NOT NULL DEFAULT ''"),
    migration("98.4", "and a picture, when the crawl learns to keep one",
      "ALTER TABLE discover_stories ADD COLUMN image " + db.textType + " NOT NULL DEFAULT ''"),
    migration("98.5", "and how long it takes to read",
      "ALTER TABLE discover_stories ADD COLUMN read_minutes " + db.intType + " NOT NULL DEFAULT 0"),
    // 100 and not 98.6, which is the obvious next number in this module's own
    // series and would be refused: 99 has already run, and plume declines a
    // migration that sorts below one already applied rather than running the
    // plan out of order. It does not warn — it refuses the whole plan, and an
    // engine that cannot migrate does not serve. Check
    // `SELECT version FROM plume_schema_history ORDER BY installed_rank DESC`
    // before picking one; a module owning a number range does not own the
    // ordering.
    migration("100", "the body again, made readable",
      "ALTER TABLE discover_stories ADD COLUMN body_md " + db.textType + " NOT NULL DEFAULT ''"),
    // 105, for the reason spelled out above 100: plume refuses a plan whose next
    // migration sorts below one already applied, and 104 has run. The number belongs to
    // the deployment's order, not to this module's series.
    migration("105", "what each source called the story",
      "ALTER TABLE discover_stories ADD COLUMN source_titles " + db.textType + " NOT NULL DEFAULT ''"),
    // 114: see the note above 100 and 105 — the number belongs to the deployment's
    // applied order, not to this module's series. 113 has run.
    migration("114", "prompts and other text the operator may edit",
      createTableSql(db, discoverTextMapping())),
  ];
}

/* A place's own feed, made the first time somebody from there opens the page.
 *
 * The cross-product argument above still holds: nobody sits down and types
 * two hundred country feeds, and most of them would digest an empty search
 * forever. But a country that has a READER is exactly the "worth digesting"
 * judgement the row is supposed to record — so the /discover route creates
 * the row lazily, and the digest job fills it on its next pass with the
 * index's country filter doing the selection.
 *
 * Two properties keep a public, unauthenticated GET from turning this into a
 * junk-row faucet: the code must be two letters of the ISO alphabet (which
 * also drops Cloudflare's "XX" unknown and "T1" Tor), and the total number of
 * place feeds is capped. A country the index holds nothing for costs one
 * hitless search per pass — no model call — and never renders, because the
 * feed route only draws feeds that have stories. */
const MAX_GEO_FEEDS: int = 40;

const CC_LETTERS: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The caller's country, as the index writes it: two ISO letters, uppercase.
 *  Anything else — an empty header, Cloudflare's "XX"/"T1" unknowns, a spoofed
 *  paragraph — answers "", which every caller reads as "no place given". */
export function geoCode(said: string): string {
  let s = said.trim().toUpperCase();
  if (s.length != 2) { return ""; }
  if (CC_LETTERS.indexOf(s.slice(0, 1)) < 0) { return ""; }
  if (CC_LETTERS.indexOf(s.slice(1, 2)) < 0) { return ""; }
  if (s == "XX" || s == "ZZ") { return ""; }
  return s;
}

/** Every feed, worldwide ones first — they are the fallback a visitor gets
 *  when nothing matches their own language and place. */
export function allFeeds(db: Db): DiscoverFeed[] {
  let keys: DbOrder[] = [asc("topic")];
  return JSON.parse<DiscoverFeed[]>(
    listOrdered(db, discoverFeedsMapping(), "", [], keys));
}

/** The feed for one place, created if this is the first reader from there.
 *  The topic is "Local news" for the model's benefit — the console shows the
 *  country's own name instead — and the query leans on the index's country
 *  filter rather than on words: `freshFor` sends `country=` with it. */
export function ensureGeoFeed(db: Db, country: string): void {
  let cc = geoCode(country);
  if (cc == "") { return; }
  let id = "geo:" + cc.toLowerCase();
  if (findById(db, discoverFeedsMapping(), id) != "") { return; }
  let all = allFeeds(db);
  let placed: int = 0;
  let i: int = 0;
  while (i < all.length) {
    if (all[i].country != "") { placed = placed + 1; }
    i = i + 1;
  }
  if (placed >= MAX_GEO_FEEDS) { return; }
  let row: DiscoverFeed = {
    id: id, topic: "Local news", query: "news", lang: "", country: cc,
    enabled: true, digestedAt: "",
  };
  persist(db, discoverFeedsMapping(), JSON.stringify(row));
}

/** The stories on one feed, in the order the model ranked them. */
export function storiesFor(db: Db, feedId: string): DiscoverRow[] {
  let keys: DbOrder[] = [asc("rank")];
  return JSON.parse<DiscoverRow[]>(
    listOrdered(db, discoverStoriesMapping(), "feed_id = " + db.placeholder, [feedId], keys));
}

/** One story, by its id, or an empty row when the feed has rolled past it.
 *
 *  A refresh REPLACES a feed's rows, so an article's address outliving its
 *  row is the ordinary case rather than an error — a link somebody sent this
 *  morning points at a story that has since dropped off the feed. The caller
 *  turns that into a sentence saying so, which is a different thing from a
 *  404 that reads as a broken page. */
export function storyById(db: Db, id: string): DiscoverRow {
  let held = findById(db, discoverStoriesMapping(), id);
  if (held == "") {
    let none: DiscoverRow = {
      id: "", feedId: "", rank: 0, headline: "", summary: "", sources: "", sourceTitles: "",
      fetchedAt: "", why: "", madeAt: "", body: "", image: "", readMinutes: 0,
      bodyMd: "",
    };
    return none;
  }
  return JSON.parse<DiscoverRow>(held);
}

/** The feed a story belongs to, for the topic name above an article. */
export function feedById(db: Db, id: string): DiscoverFeed {
  let held = findById(db, discoverFeedsMapping(), id);
  if (held == "") {
    let none: DiscoverFeed = {
      id: "", topic: "", query: "", lang: "", country: "", enabled: false,
      digestedAt: "",
    };
    return none;
  }
  return JSON.parse<DiscoverFeed>(held);
}

/* A story the model wrote, with what the crawl holds on it.
 *
 * A record wrapping the two rather than a second array beside `stories`: the
 * body belongs to exactly one story, and a pair of arrays that must stay the
 * same length is a bug waiting for the day one of them is filtered. */
export type WrittenStory = {
  story: DiscoverStory,
  body: string,
  readMinutes: int,
  // The picture, taken from whichever of the story's own sources has one.
  image: string,
  // Each source's own headline, by position against story.sources. Found here for the
  // same reason image is: this is where the hits are.
  sourceTitles: string,
};

export type DiscoverTopic = {
  topic: string,
  stories: WrittenStory[],
  // What the model was working from, so a thin day reads as a thin day
  // rather than as a broken feature.
  read: int,
  fresh: int,
  problem: string,
};

/** One result, as the index answers it. */
type Hit = {
  title: string,
  url: string,
  snippet: string,
  source: string,
  fetched_at: string,
  /* When the PAGE said it was published, ISO-8601, or "" when it declared no
   * date. The index learned this on 2026-08-06 and it is the field this feed
   * is actually about: fetched_at answers "when did the crawler last see it",
   * which a re-crawl moves to today for an article written in 2019. */
  published_at: string,
  /* When the URL first entered the index, never moved by a re-crawl. The
   * honest fallback for a page that declares no date: it says "new to us",
   * which is a claim we can defend, where fetch time says nothing at all. */
  first_seen: string,
  lang: string,
  country: string,
  category: string,
  score: number,
  // The page's own picture, when the crawler found one. Thin coverage — about
  // one page in twenty carries it — which is why nothing on the article or the
  // card is laid out around its presence: a story with a picture gets one, a
  // story without is not a story with a hole in it.
  image: string,
};

/** Whether a fetch stamp is inside the window. The index writes ISO-8601 in
 *  UTC ("2026-08-05T09:14:00.000Z"), which sorts and parses as text. */
/* The date this feed judges a story by.
 *
 * Publication if the page declared one; else when we first saw it; else the
 * fetch. The order matters and the last one is a last resort: fetch time is
 * when the crawler last touched the page, so a back-catalogue walk re-stamps
 * thousands of old articles with today and every one of them enters a
 * 36-hour window as breaking news. Both the cutoff below and the ordering
 * read this rather than fetched_at, or the index's own `sort=recent` and
 * `since=` are undone the moment their answer arrives here.
 *
 * Empty strings, not nulls: jsonText yields "" for an absent member, and the
 * comparison is textual, so a "" would sort below every real stamp and be
 * filtered out — which is why each step is checked for length rather than
 * chained blindly. */
function effectiveStamp(h: Hit): string {
  if (h.published_at.length >= 19) { return h.published_at; }
  if (h.first_seen.length >= 19) { return h.first_seen; }
  return h.fetched_at;
}

function recent(stamp: string, cutoff: string): bool {
  if (stamp.length < 19 || cutoff.length < 19) { return false; }
  return stamp.slice(0, 19) >= cutoff.slice(0, 19);
}

/* The cutoff, as the same ISO text the index writes.
 *
 * Computed from the epoch by hand rather than through a date library: this
 * has to produce EXACTLY the shape the index writes, because the comparison
 * is textual — a stamp missing its zero padding ("2026-8-05") sorts before
 * every real one and would let the entire corpus through the filter.
 *
 * The civil-date arithmetic is Howard Hinnant's days-from-epoch inverse, the
 * standard one, because "days since 1970 to a Gregorian date" is exactly the
 * kind of thing to take from somebody who has already got the leap years
 * right. */
function cutoffText(): string {
  let secs = parseInt(`${Date.now()}`, 10) ?? 0;
  secs = secs / 1000 - freshHours() * 3600;

  let days = secs / 86400;
  let rest = secs - days * 86400;
  let hh = rest / 3600;
  let mm = (rest - hh * 3600) / 60;
  let ss = rest - hh * 3600 - mm * 60;

  // days -> y/m/d, counting from 1970-01-01.
  let z = days + 719468;
  let era = z / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) { y = y + 1; }

  return `${y}` + "-" + pad2(m) + "-" + pad2(d)
    + "T" + pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
}

function pad2(n: int): string {
  return n < 10 ? "0" + `${n}` : `${n}`;
}

/** The fresh results for one query, newest first.
 *
 *  Sorted here because the index cannot sort by time yet — and sorted rather
 *  than merely filtered so the model reads the newest snippets first, which is
 *  the order it weighs when it decides what leads. */
export function freshFor(query: string, lang: string, country: string, cap: int): Hit[] {
  let none: Hit[] = [];
  // lang and country are the index's own filters, so a French feed is a
  // French SEARCH rather than a worldwide search read in French — the
  // difference is whether the model ever sees the pages it should not.
  // The window and the order are the index's own since it learned dates:
  // `since` filters on publication where a page declared one and on fetch
  // time where it did not, and `sort=recent` puts the newest first before a
  // byte arrives here. The textual cutoff below stays as the safety net.
  let url = searchApiBase() + "/search?q=" + urlEncode(query) + "&k=" + `${cap}`
    + "&sort=recent&since=" + `${freshHours()}` + "h";
  // A keyword feed asks for ANY of its words, not all of them. The query is a topic
  // sketch, not a phrase: as a conjunction "company acquisition earnings" found 4
  // fresh pages in a corpus holding hundreds, because no article contains all three.
  // The digest model is the precision stage; retrieval's job here is recall.
  if (query != "*") { url = url + "&match=any"; }
  if (lang != "") { url = url + "&lang=" + urlEncode(lang); }
  if (country != "") { url = url + "&country=" + urlEncode(country); }
  let res = http.request(url, "GET", "", new Map<string, string>());
  if (!res.ok || res.status != 200) { return none; }
  let raw = jsonRaw(res.body, "results");
  if (raw == "") { return none; }
  /* Scanned field by field, NEVER JSON.parse<Hit[]>: the typed parse refuses
   * a member the type does not name, and the index's answer GROWS members —
   * the day it learned `published_at`, every digest quietly became "nothing
   * fresh" while the index was answering forty hits, because the release
   * build reads a refused parse as an empty list. The scan takes what it
   * knows and ignores what it does not, which is the only stable contract
   * with an API that is allowed to improve. (retrieveWeb reads its passages
   * the same way, for the same reason.) */
  let rows = jsonList(raw);
  let hits: Hit[] = [];
  let r: int = 0;
  while (r < rows.length) {
    let one: Hit = {
      title: jsonText(rows[r], "title"),
      url: jsonText(rows[r], "url"),
      snippet: jsonText(rows[r], "snippet"),
      source: jsonText(rows[r], "source"),
      fetched_at: jsonText(rows[r], "fetched_at"),
      published_at: jsonText(rows[r], "published_at"),
      first_seen: jsonText(rows[r], "first_seen"),
      lang: jsonText(rows[r], "lang"),
      country: jsonText(rows[r], "country"),
      category: jsonText(rows[r], "category"),
      score: 0,
      image: jsonText(rows[r], "image"),
    };
    if (one.url != "") { hits.push(one); }
    r = r + 1;
  }

  let cutoff = cutoffText();
  let kept: Hit[] = [];
  let i: int = 0;
  while (i < hits.length) {
    if (recent(effectiveStamp(hits[i]), cutoff)) { kept.push(hits[i]); }
    i = i + 1;
  }

  // Newest first, by selection — the list is at most `cap` and the compare is
  // textual, so a sort here costs nothing worth naming.
  let out: Hit[] = [];
  while (out.length < kept.length) {
    let best: int = -1;
    let k: int = 0;
    while (k < kept.length) {
      if (!taken(out, kept[k].url)
          && (best < 0 || effectiveStamp(kept[k]) > effectiveStamp(kept[best]))) { best = k; }
      k = k + 1;
    }
    if (best < 0) { break; }
    out.push(kept[best]);
  }
  return out;
}

function taken(rows: Hit[], url: string): bool {
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].url == url) { return true; }
    i = i + 1;
  }
  return false;
}

/** The results, as the lines the model reads. One per line, numbered, with
 *  the fetch stamp on it — the model is told to copy that stamp rather than
 *  invent a date, so it has to be in front of it. */
function asLines(hits: Hit[]): string {
  let out = "";
  let i: int = 0;
  while (i < hits.length) {
    let h = hits[i];
    out = out + `${i + 1}` + ". " + h.title
      + "\n   url: " + h.url
      + "\n   fetched: " + h.fetched_at
      + "\n   " + h.snippet + "\n\n";
    i = i + 1;
  }
  return out;
}

/* How much of the index to pull for one story's body, and how much of it to
 * keep.
 *
 * Twelve passages because the filter below throws most of them away: the
 * index has no url filter, so the body is retrieved on the story's own words
 * and then narrowed to the story's own sources, and asking for three would
 * routinely keep none. 40000 characters is the ceiling on what comes back,
 * not on what is stored — `BODY_CHARS` is that, and it is a reading length
 * rather than a storage limit: past about this much nobody is reading an
 * aggregator's excerpt, they are on the source's own page. */
const BODY_PASSAGES: int = 12;
const BODY_FETCH_CHARS: int = 40000;
const BODY_CHARS: int = 12000;

/** The host part of a url, for grouping and for reading. */
function hostOf(url: string): string {
  let start = url.indexOf("://");
  let rest = start < 0 ? url : url.slice(start + 3);
  let slash = rest.indexOf("/");
  let host = slash < 0 ? rest : rest.slice(0, slash);
  if (host.startsWith("www.")) { host = host.slice(4); }
  return host;
}

/* A passage with its inline images taken out.
 *
 * Crawled markdown is full of them — a Vox excerpt arrived with the same
 * photograph three times before its first sentence — and every one is an
 * `<img>` pointed at the publisher. Left in, they would undo the whole reason
 * the story picture is proxied: the reader's browser would announce itself to
 * a site they did not choose to visit, once per image, on every article.
 *
 * Removed rather than proxied, and that is the cheaper answer as well as the
 * safer one. Proxying these would mean a route that takes a URL from the
 * caller, which is the shape `image-proxy.ts` exists to avoid; and what is
 * being removed is mostly a publisher's own furniture — logos, ad slots, the
 * lead photo repeated at three widths — rather than anything the excerpt
 * needs. The story's own picture, the one the index extracted, is unaffected
 * and is served through the proxy.
 *
 * A scanner and not a pattern match, because the alt text may itself contain
 * brackets: this finds the "![", then the "](" that closes the alt, then the
 * ")" that closes the url, and drops the span between. Anything that does not
 * close is left exactly as it was rather than swallowing the rest of the
 * document. */
function withoutImages(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    if (i + 1 < text.length && text.charAt(i) == "!" && text.charAt(i + 1) == "[") {
      let alt = text.indexOf("](", i);
      if (alt < 0) { out = out + text.slice(i); return out; }
      let shut = text.indexOf(")", alt);
      if (shut < 0) { out = out + text.slice(i); return out; }
      i = shut + 1;
      // The blank line an image sat alone on would otherwise become two.
      while (i < text.length && text.charAt(i) == "\n") { i = i + 1; }
      if (out.length > 0 && !out.endsWith("\n\n")) { out = out + "\n\n"; }
    } else {
      out = out + text.charAt(i);
      i = i + 1;
    }
  }
  return out;
}

/* What the crawl holds on one story, as markdown.
 *
 * Retrieved on the story's own headline and summary, then narrowed to the
 * urls the model cited. The narrowing is the honest part: a retrieval on
 * "Acme buys Widget Co" also returns three other pages about acquisitions,
 * and putting those under this headline would be the article claiming
 * sources it does not have.
 *
 * Grouped under each host with its link, because that is what the reader
 * needs to judge it — the passage is what a crawler fetched, and the link is
 * where to go if it matters.
 *
 * Falls back to the snippets the digest already read. They are short, but a
 * story that opens to a paragraph and a link is a story; one that opens to an
 * empty page is a fault. */
function bodyFor(story: DiscoverStory, hits: Hit[]): string {
  let out = "";
  let found = retrieveWeb(story.headline + ". " + story.summary,
    BODY_PASSAGES, BODY_FETCH_CHARS);

  if (found.ok) {
    let s: int = 0;
    while (s < story.sources.length) {
      let url = story.sources[s];
      let wrote: bool = false;
      let p: int = 0;
      while (p < found.found.length) {
        let one = found.found[p];
        if (one.url == url && one.text != "") {
          if (!wrote) {
            out = out + "## " + hostOf(url) + "\n\n";
            wrote = true;
          }
          out = out + withoutImages(one.text) + "\n\n";
        }
        p = p + 1;
      }
      if (wrote) { out = out + "[Read on " + hostOf(url) + "](" + url + ")\n\n"; }
      s = s + 1;
    }
  }

  if (out == "") {
    // The snippets, which the digest read on its way to writing the story.
    let s: int = 0;
    while (s < story.sources.length) {
      let url = story.sources[s];
      let h: int = 0;
      while (h < hits.length) {
        if (hits[h].url == url && hits[h].snippet != "") {
          out = out + "## " + hostOf(url) + "\n\n"
            + withoutImages(hits[h].snippet) + "\n\n"
            + "[Read on " + hostOf(url) + "](" + url + ")\n\n";
        }
        h = h + 1;
      }
      s = s + 1;
    }
  }

  if (out.length > BODY_CHARS) { out = out.slice(0, BODY_CHARS) + "…\n"; }
  return out;
}

/* The story's picture, from the story's own sources.
 *
 * Taken in the model's own source order, so the picture belongs to the page
 * the digest leaned on most rather than to whichever result happened to carry
 * one. A story whose sources have no image gets "", and everything that draws
 * one treats that as the normal case — roughly nineteen rows in twenty are it.
 *
 * Only `https:` is accepted. The url is a string a crawler read out of a page
 * this deployment does not control, and it ends up in an `src` attribute; a
 * `javascript:` or `data:` value there is a page somebody else wrote deciding
 * what runs in this one. An allowlist of the one scheme an image needs is the
 * cheap half of that, and the console's `img-src` is the other. */
function imageFor(story: DiscoverStory, hits: Hit[]): string {
  let s: int = 0;
  while (s < story.sources.length) {
    let h: int = 0;
    while (h < hits.length) {
      if (hits[h].url == story.sources[s] && hits[h].image.startsWith("https://")) {
        return hits[h].image;
      }
      h = h + 1;
    }
    s = s + 1;
  }
  return "";
}

/** Each source's own headline, in the order the sources are listed.
 *
 *  The same walk imageFor does: the hits are what the model was given, so the title
 *  beside a url here is the one that produced the story. A source with no matching hit
 *  yields an empty line rather than shifting the others — the two lists are read by
 *  position, so a missing title must still occupy its place. */
function titlesFor(story: DiscoverStory, hits: Hit[]): string {
  let out: string = "";
  let s: int = 0;
  while (s < story.sources.length) {
    let found: string = "";
    let h: int = 0;
    while (h < hits.length) {
      if (hits[h].url == story.sources[s]) { found = hits[h].title; h = hits.length; }
      else { h = h + 1; }
    }
    out = out + found.replaceAll("\n", " ");
    if (s + 1 < story.sources.length) { out = out + "\n"; }
    s = s + 1;
  }
  return out;
}

/** Reading minutes, at 220 words a minute, never zero for a body that exists.
 *  Words counted as runs of non-space, which is close enough for a figure
 *  whose whole job is to say "short" or "long". */
function readingMinutes(body: string): int {
  if (body == "") { return 0; }
  let words: int = 0;
  let inWord: bool = false;
  let i: int = 0;
  while (i < body.length) {
    let c = body.charAt(i);
    let space = c == " " || c == "\n" || c == "\t" || c == "\r";
    if (space) { inWord = false; } else if (!inWord) { words = words + 1; inWord = true; }
    i = i + 1;
  }
  let mins = words / 220;
  return mins < 1 ? 1 : mins;
}

/* A story's id, derived from what the story IS.
 *
 * It used to be `<feed>:<rank>`, which is a SLOT and not a story: after the
 * next digest `tech-en:0` is whatever leads that hour, so a link somebody
 * sent, a conversation seeded from an article, and a browser's history all
 * quietly repointed at a different piece of news. Deriving it from the
 * headline means a story that survives a refresh keeps its address, and one
 * that does not, 404s honestly.
 *
 * The accumulator is knowledge.ts::fnv1a's, copied rather than shared and
 * for its stated reason: FNV wants i32 arithmetic that wraps, this language
 * traps on overflow, and the mask keeps every intermediate provably inside
 * i32. Not cryptographic, and it does not need to be — it only has to keep
 * two headlines on one feed apart. */
function stem(text: string): string {
  let hash: int = 5381;
  let i: int = 0;
  while (i < text.length) {
    let m = hash & 0x01ffffff;
    hash = (m << 5) + m + text.charCodeAt(i);
    i = i + 1;
  }
  let digits = "0123456789abcdef";
  let out = "";
  let d: int = 0;
  let held = hash;
  while (d < 8) {
    out = digits.charAt(held & 15) + out;
    held = held >> 4;
    d = d + 1;
  }
  return out;
}

/* The instructions, and the reasoning for them is in prompts/discover.md.
 *
 * Kept as one constant rather than a prompt row because it is not a
 * deployment's choice: a digest that invents dates or pads its count is
 * broken, not differently configured. The topics ARE a choice, and those are
 * data. */
function langName(code: string): string {
  if (code == "ar") { return "Arabic"; }
  if (code == "fr") { return "French"; }
  if (code == "en") { return "English"; }
  if (code == "de") { return "German"; }
  if (code == "tr") { return "Turkish"; }
  if (code == "es") { return "Spanish"; }
  if (code == "it") { return "Italian"; }
  if (code == "pt") { return "Portuguese"; }
  // A code this list does not know must not reach the prompt as a bare "tr" —
  // the model reads that as a shrug and writes English. Saying nothing keeps the
  // digest in the sources' own language, which is the honest fallback.
  return code;
}

/** The prompt, with the operator's wording when there is one.
 *
 *  Substitution is deliberately three named tokens rather than a template engine:
 *  a prompt is edited by a person in a text box, and the failure mode of anything
 *  cleverer is a digest that stops running because a brace was mistyped. */
function digestPromptWith(override: string, topic: string, count: int, outLang: string): string {
  if (override.trim() == "") { return digestPrompt(topic, count, outLang); }
  let out = override.replaceAll("{topic}", topic).replaceAll("{count}", `${count}`);
  out = out.replaceAll("{language}", outLang == "" ? "the language of the sources" : langName(outLang));
  return out;
}

function digestPrompt(topic: string, count: int, outLang: string): string {
  /* The output language is stated FIRST and again LAST, and that is not
   * belt-and-braces — it is what stopped the Tunisian feed drifting back into
   * French. The rule used to sit in the middle of the prompt, which held while
   * the reading cap was fifty snippets and broke the day it became eighty: the
   * model reads a long body of French sources with one line about Arabic buried
   * behind them and writes what it just read. Primacy and recency are the two
   * positions a long prompt does not lose. */
  let lead = outLang == "" ? ""
    : "WRITE EVERY headline, summary and why in " + langName(outLang) + ". The "
      + "sources below are in other languages; translate them. This is not "
      + "negotiable and applies to every card.\n\n";
  return lead
    + "You are assembling a news digest from pages a web crawler fetched in "
    + "the last day. You will be given search results for the topic \"" + topic
    + "\". Each carries a title, a url, a fetch time and a snippet.\n\n"
    + "Group them into at most " + `${count}` + " STORIES. A story is one event "
    + "several pages are covering — three outlets reporting the same "
    + "acquisition are ONE story with three sources. Order them by how much a "
    + "person following " + topic + " would want to know, not by how many "
    + "sources you found.\n\n"
    + "Answer with this JSON and nothing else:\n"
    + "{\"stories\":[{\"headline\":\"…\",\"summary\":\"…\","
    + "\"sources\":[\"https://…\"],\"fetchedAt\":\"…\",\"why\":\"…\"}]}\n\n"
    + "headline: what happened, under 90 characters, a sentence a person could "
    + "say out loud. Never a question, never a teaser, never the publication's "
    + "own headline copied — those are written to be clicked.\n"
    + "summary: two sentences, at most 45 words. The first says what happened; "
    + "the second says what is not obvious from the first — a number, a "
    + "consequence, who disputes it.\n"
    + "sources: every url you drew on, most substantial first. One source is "
    + "allowed and will be common.\n"
    + "fetchedAt: the EARLIEST fetch time among your sources, copied exactly. "
    + "You do not know when anything was published, only when it was fetched. "
    + "Never infer a date from the text.\n"
    + "why: one clause under 60 characters on why it is worth attention today. "
    + "Empty string if the honest answer is that it is simply new.\n\n"
    + (outLang == ""
      ? "Write headline, summary and why in the language most of the snippets "
        + "you drew on are written in - a French feed's cards read in French, an "
        + "Arabic feed's in Arabic. Never translate local news into English.\n\n"
      : "Write headline, summary and why in " + langName(outLang) + ", whatever "
        + "language the snippets are in. Translate faithfully; keep proper names, "
        + "institutions and figures exactly as the source gives them.\n\n")
    + "Rules that are not style:\n"
    + "1. Every claim must be in a snippet you were given. If the snippets say "
    + "a company is in talks, you may not write that a deal happened. Where "
    + "they disagree, say so rather than picking a side.\n"
    + "2. One card per distinct EVENT, mechanically: group snippets that cover "
    + "the same event, then emit a card for every group, up to the limit, "
    + "ranked newest first. Importance is not your call - a road closure and "
    + "a cabinet reshuffle both get their card. The only things you may drop "
    + "are rule 3 non-news and true duplicates of an event you already "
    + "carded. Do not invent events that are not in the snippets.\n"
    + "3. Drop what is not news: market-research listings, SEO round-ups, "
    + "product pages, undated explainers. A crawl is mostly made of those.\n"
    + "4. Nothing about a private individual unless they are acting in a "
    + "public role.\n"
    + "5. No opinion of your own, on the event or on the coverage."
    + (outLang == "" ? ""
      : "\n6. The language rule at the top governs: every headline, summary and "
        + "why in " + langName(outLang) + ", however the sources are written. A "
        + "card in another language is a failed card.");
}

/** A digest for one topic. Everything that can go wrong lands in `problem`
 *  and leaves the rest of the shape intact — a topic the model could not read
 *  should draw as an empty topic, never as a broken page. */
export function digest(db: Db, topic: string, query: string, lang: string, country: string, modelId: string, master: string): DiscoverTopic {
  let empty: WrittenStory[] = [];
  /* For a PLACE feed, lang is the language the cards are WRITTEN in, not a filter
   * on what may be read. Tunisia publishes in Arabic and French; filtering
   * retrieval to one of them halved the pool and hid half the day's news, when
   * what was actually wanted was: read everything, write Arabic. Topic feeds keep
   * lang as a retrieval filter - an English tech feed reading sources its readers
   * cannot check would be summarising the unverifiable. */
  let readLang = country == "" ? lang : "";
  let hits = freshFor(query, readLang, country, readCap());
  // A record's fields cannot be assigned after it is built, so every exit
  // below constructs its own answer. `said` keeps that from being six copies
  // of the same literal.
  let said = (why: string) => {
    let r: DiscoverTopic = {
      topic: topic, stories: empty, read: hits.length, fresh: hits.length,
      problem: why,
    };
    return r;
  };
  if (hits.length == 0) { return said("nothing fresh in the index for this topic"); }

  let modelDoc = findById(db, modelsMapping(), modelId);
  if (modelDoc == "") { return said("no model " + modelId); }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) { return said(model.label + " is disabled"); }
  let key = credentialFor(db, model.provider, master);
  if (key == "") { return said("no credential for " + model.provider); }

  /* 12000 and not the 1800 this started at. The ceiling has to hold the
   * WHOLE answer, and three things spend it faster than an English estimate
   * says: a digest in Arabic or another non-Latin script pays more tokens per
   * word, the sources arrays echo URLs verbatim and a percent-encoded Arabic
   * URL alone runs to hundreds of tokens, and a provider that reasons before
   * answering (Gemini) spends its thinking inside this same budget. At 1800
   * every feed's JSON was cut before its first closing brace and every pass
   * failed as "did not answer with JSON"; a measured Tunisian digest needed
   * 5,000 for the answer alone — truncation reads as malformed output, three
   * layers from its cause. */
  let config: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.2, maxTokens: 12000, topP: 1.0,
    extra: "", thinking: "off", label: "", selectable: false, rank: 0,
  };
  /* Up to three attempts. DeepSeek returns an entirely empty answer every few
   * passes - not an error, not malformed JSON, just nothing - and a digest that
   * gives up on the first one loses the whole half-hour cycle for that feed.
   * The feeds this bit hardest were exactly the busiest ones; geo:tn failed
   * three consecutive passes this way while forty candidates waited. A retry
   * costs seconds against a cycle that costs thirty minutes. */
  let written = discoverText(db, "digest-prompt");
  let asked = complete(model, config, digestPromptWith(written, topic, storyCap(), lang), asLines(hits), key);
  let tries: int = 1;
  while (tries < 3) {
    if (asked.ok) {
      let peek = replyText(model.provider, asked.text).trim();
      if (peek.indexOf("{") >= 0) { break; }
    }
    asked = complete(model, config, digestPromptWith(written, topic, storyCap(), lang), asLines(hits), key);
    tries = tries + 1;
  }
  if (!asked.ok) { return said("the model did not answer"); }

  // The JSON, out of whatever the model wrapped it in. A model that fences its
  // answer is doing something reasonable; a parser that refuses the fence is
  // not.
  // `Completion.text` is the provider's whole response BODY, not the
  // message — replyText is what pulls the assistant's words out of it. Read
  // as text it looked like the model had answered with a JSON envelope
  // instead of a digest, which is the answer being read at the wrong layer.
  let text = replyText(model.provider, asked.text).trim();
  let open = text.indexOf("{");
  let shut = text.lastIndexOf("}");
  if (open < 0 || shut <= open) {
    return said("the model did not answer with JSON: "
      + (text.length > 200 ? text.slice(0, 200) + "…" : text));
  }
  let body = text.slice(open, shut + 1);
  let raw = jsonRaw(body, "stories");
  if (raw == "") {
    // Worth the words the failure costs: the answer is in hand and unusable,
    // and "no stories" reads as a quiet day rather than as a parse that gave
    // up. The head of what came back is what tells the two apart.
    return said("the model answered without a stories array: "
      + (body.length > 160 ? body.slice(0, 160) + "…" : body));
  }
  // The bodies, one index call per story. They are fetched HERE rather than
  // when somebody opens an article for the reason `body` carries in full: the
  // index is operator-only and Discover is public, so this pass is the only
  // place that may ask it anything.
  let wrote: WrittenStory[] = [];
  let parsed = JSON.parse<DiscoverStory[]>(raw);
  let w: int = 0;
  while (w < parsed.length) {
    let text = bodyFor(parsed[w], hits);
    let one: WrittenStory = {
      story: parsed[w], body: text, readMinutes: readingMinutes(text),
      image: imageFor(parsed[w], hits),
      sourceTitles: titlesFor(parsed[w], hits),
    };
    wrote.push(one);
    w = w + 1;
  }

  let told: DiscoverTopic = {
    topic: topic, stories: wrote,
    read: hits.length, fresh: hits.length, problem: "",
  };
  return told;
}



/* An article, as the context a conversation about it starts from.
 *
 * Built HERE, in the engine, from the stored row — never from a request body,
 * and that is a security property rather than a layering preference. A turn
 * whose text opens with this sentence is filed as `CHUNK_ROLE` by
 * `threads.ts::isRetrievedContext` and is therefore invisible in every view
 * that shows a conversation to a person. A client able to post one could put
 * instructions in front of a model that the reader can never see. So the only
 * thing a caller may send is WHICH story; the words are ours.
 *
 * The opening sentence is `webrag.ts::asWebContext`'s, and it has to start
 * with those exact words — that prefix is what the classifier matches on, and
 * the two files have silently drifted apart once already. What follows is
 * this one's own, because "for this question" is a lie here: there is no
 * question yet, only an article somebody opened.
 *
 * The reader is told the passages are a CRAWL of the sources rather than the
 * articles themselves, because that is what they are, and a model that treats
 * an excerpt as the whole piece will confidently answer a question the text
 * never covered. */
export function asArticleContext(row: DiscoverRow, topic: string): string {
  let out = "Passages retrieved from the public web index. "
    + "The person is reading an article on the Discover feed"
    + (topic == "" ? "" : " under the topic \"" + topic + "\"")
    + " and their questions are about it.\n\n"
    + "The digest below was written by an earlier pass over the same index, and "
    + "the passages under it are what a crawler fetched from the sources — "
    + "excerpts, not the published articles. Answer from them, say plainly when "
    + "they do not cover something rather than filling the gap, and never "
    + "attribute to a source what is not in its passage. The fetch time is the "
    + "only time here: nothing below says when anything was published. When the "
    + "task calls for your tools or skills, use them regardless of what is here. "
    + "The source URLs below are attached to this conversation: read_link fetches "
    + "any of them in full when the excerpts are not enough, and works for any "
    + "other link the person brings.\n\n"
    + "# " + row.headline + "\n\n"
    + row.summary + "\n\n"
    + "Sources: " + row.sources.replaceAll("\n", ", ") + "\n"
    + "Fetched: " + row.fetchedAt + "\n";
  if (row.body != "") { out = out + "\n" + row.body + "\n"; }
  return out;
}

/* Which model digests, and how often.
 *
 * The LOCAL one by default, and that is a deliberate split rather than a
 * default nobody chose: this work is background, unattended and repeated
 * every half hour, so it should run on the model that costs nothing and has
 * no rate limit. The paid API is for the conversation somebody is waiting on.
 *
 * Both are read from the environment so a deployment can say otherwise
 * without a rebuild — a box with no local model set can point this at
 * whatever it does have. */
/* What the crawler hands over is a page, not an article, and this turns the
 * first into the second.
 *
 * A REFORMATTER and not a summariser, which is the whole of the prompt below.
 * The page already carries a two-sentence summary above the body; a second
 * one here would be the same answer twice and would throw away the numbers,
 * which are the only reason to open a press release at all.
 *
 * What it removes is what the crawl brought and the source never meant as
 * prose: photo credits and caption fragments ("F&F Van in Westchester
 * (PRNewsfoto/Feast & Fettle)"), the half-eaten link syntax a markdown
 * extractor leaves behind (")](#)", "[CLX](#financial-modal)"), navigation,
 * cookie notices, the "About <company>" tail, forward-looking statements and
 * the investor-contact block.
 *
 * "" on any failure, which the caller treats as "keep showing the raw body".
 * A story is readable-ish today; it must not become unreadable because a
 * model was down. */
const READABLE_PROMPT: string = "You are given the raw text a web crawler extracted from one article. "
  + "Reformat it into clean, readable markdown.\n\n"
  + "RULES:\n"
  + "1. Keep every fact, figure, date, name and quotation exactly as written. Do not summarise, shorten or paraphrase.\n"
  + "2. Restore the structure the source had: paragraphs, headings, and bullet lists where the text is a list.\n"
  + "3. Delete crawl wreckage: image captions and photo credits, broken link syntax such as \")](#)\" or \"[NAME](#anchor)\", "
  + "navigation and menu text, cookie and subscription notices, share buttons, and stray emphasis markers left mid-sentence.\n"
  + "4. Delete the tail a press release carries and a reader does not want: \"About <company>\" blurbs, forward-looking "
  + "statement disclaimers, media and investor contact blocks, and legal notices.\n"
  + "5. Invent nothing. Add no headline, no introduction, no commentary of your own, and no closing note. "
  + "If a passage is garbled beyond repair, drop it rather than guessing what it said.\n"
  + "6. Answer with the markdown only. No preamble, no code fence, no explanation of what you did.";

export function readable(db: Db, raw: string, modelId: string, master: string): string {
  if (raw == "") { return ""; }
  let modelDoc = findById(db, modelsMapping(), modelId);
  if (modelDoc == "") { return ""; }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) { return ""; }
  let key = credentialFor(db, model.provider, master);
  if (key == "") { return ""; }

  // Cooler than the digest and roomier: this is transcription, not writing,
  // and the answer is longer than its instructions. The ceiling is generous
  // because a body cut off mid-sentence is worse than one nobody reformatted —
  // and it carries the digest's tax too: non-Latin scripts cost more tokens
  // per word, and a reasoning provider spends its thinking inside this budget.
  let config: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.0, maxTokens: 8000, topP: 1.0,
    extra: "", thinking: "off", label: "", selectable: false, rank: 0,
  };
  let asked = complete(model, config, READABLE_PROMPT, raw, key);
  if (!asked.ok) { return ""; }
  let out = replyText(model.provider, asked.text).trim();

  // A fence is a reasonable thing for a model to do and an unreasonable thing
  // to leave in the page.
  if (out.startsWith("```")) {
    let firstBreak = out.indexOf("\n");
    if (firstBreak > 0) { out = out.slice(firstBreak + 1); }
    if (out.endsWith("```")) { out = out.slice(0, out.length - 3); }
    out = out.trim();
  }

  // A refusal, an apology, or a summary that came back a tenth of the length
  // is not a reformatting. Half is the line: real cleaning removes boilerplate
  // and caption wreckage, which on a press release is a third of the bytes,
  // and anything shorter has thrown away facts.
  if (out.length < raw.length / 2) { return ""; }
  return out;
}


function digestModelId(): string {
  let said = process.env["AGENTS_DISCOVER_MODEL"] ?? "";
  return said == "" ? "m-vllm-qwen" : said;
}

/* The separator between a story's raw body and its readable one inside the
 * carry-over map. Any string that cannot occur in either half would do; what
 * matters is that the code slices by its length rather than by a guess. */
const CARRY_SEP: string = "\n<<<BODY-MD>>>\n";

/** id -> "body\nbodyMd" for a feed's stories that have been reflowed, so a
 *  refresh can carry the work across. A map of one string per story rather
 *  than the rows, because only two fields matter and the bodies are large. */
export function readableSoFar(db: Db, feedId: string): Map<string, string> {
  let out = new Map<string, string>();
  let rows = JSON.parse<DiscoverRow[]>(listWhere(db, discoverStoriesMapping(),
    "feed_id = " + db.placeholder + " AND body_md <> ''", [feedId]));
  let i: int = 0;
  while (i < rows.length) {
    out.set(rows[i].id, rows[i].body + CARRY_SEP + rows[i].bodyMd);
    i = i + 1;
  }
  return out;
}

/** The stored readable body for this story, but only if the crawled text is
 *  byte-for-byte what it was. A changed body is a changed article, and last
 *  hour's reflow of a different text would be a quiet lie. */
export function carriedOver(kept: Map<string, string>, id: string, body: string): string {
  let held = kept.get(id) ?? "";
  if (held == "") { return ""; }
  let cut = held.indexOf(CARRY_SEP);
  if (cut < 0) { return ""; }
  if (held.slice(0, cut) != body) { return ""; }
  // + the separator's LENGTH, not + 1. This was "\u0000" and `cut + 1`, on
  // the assumption that the escape produced one NUL character. It does not
  // here — it is six literal characters — so every carried-over body kept five
  // of them and articles opened with "0000##" printed where a heading should
  // be. A named constant and its own length is the shape that cannot drift.
  return held.slice(cut + CARRY_SEP.length);
}

/** Stories the crawl gave a body and nobody has reflowed yet, oldest first.
 *
 *  The scheduler's pass drains this a few at a time. A limit rather than "all
 *  of them" because each one is a model call: a feed that just refreshed has
 *  six new stories per topic, and a pass that tried to do every topic at once
 *  would hold the unit active long past its next tick. */
export function unreadableStories(db: Db, limit: int): DiscoverRow[] {
  let keys: DbOrder[] = [asc("made_at")];
  let rows = JSON.parse<DiscoverRow[]>(listOrdered(db, discoverStoriesMapping(),
    "body <> '' AND body_md = ''", [], keys));
  if (rows.length <= limit) { return rows; }
  let some: DiscoverRow[] = [];
  let i: int = 0;
  while (i < limit) { some.push(rows[i]); i = i + 1; }
  return some;
}

/** The same model, named for callers outside this module — the article route
 *  reformats a body on first open and needs to ask the same thing the digest
 *  would have. */
export function discoverModelId(): string { return digestModelId(); }

/** The story with its readable body filled in. Records are immutable, so
 *  "set one field" is "build the row again"; written once here rather than at
 *  the call site, where a long literal is what loses a column. */
export function withReadableBody(row: DiscoverRow, md: string): DiscoverRow {
  let better: DiscoverRow = {
    id: row.id, feedId: row.feedId, rank: row.rank, headline: row.headline,
    summary: row.summary, sources: row.sources, sourceTitles: row.sourceTitles,
    fetchedAt: row.fetchedAt,
    why: row.why, madeAt: row.madeAt, body: row.body, image: row.image,
    readMinutes: row.readMinutes, bodyMd: md,
  };
  return better;
}

function digestEveryMs(): int {
  let said = process.env["AGENTS_DISCOVER_EVERY_MS"] ?? "";
  if (said == "") { return 1800000; }
  let n = parseInt(said, 10) ?? 1800000;
  return n < 60000 ? 60000 : n;
}

/** Digest one feed and store what came back.
 *
 *  Rows are replaced only on a GOOD pass. A model that is down, a topic that
 *  went quiet, an answer that would not parse — all of them leave yesterday's
 *  stories on the page, because a feed that empties itself whenever the local
 *  model is asleep is worse than a feed that is a few hours stale. The
 *  desktop this runs against has gone away twice today; that must cost
 *  freshness and nothing else. */
export function refreshFeed(db: Db, feed: DiscoverFeed, master: string): string {
  let told = digest(db, feed.topic, feed.query, feed.lang, feed.country,
    digestModelId(), master);
  if (told.problem != "") { return told.problem; }
  if (told.stories.length == 0) { return "nothing worth a card"; }

  let now = `${Date.now()}`;
  /* What has already been made readable, kept across the rewrite.
   *
   * A refresh deletes the feed's stories and writes them again, which threw
   * away every reflowed body twice an hour — the sweep filled the column, the
   * next pass emptied it, and the page never improved. A story whose id and
   * whose crawled body are both unchanged is the same story, so its readable
   * form is still true and is carried over rather than paid for again. */
  let kept = readableSoFar(db, feed.id);
  deleteWhere(db, discoverStoriesMapping(), "feed_id = " + db.placeholder, [feed.id]);
  let i: int = 0;
  while (i < told.stories.length) {
    let written = told.stories[i];
    let one = written.story;
    let row: DiscoverRow = {
      // Named for the story and not for the slot — see `stem`. The feed is
      // still in front of it so two feeds carrying the same headline are two
      // articles, which is what they are: a French reader's copy is not the
      // English one, and each is its own page.
      id: feed.id + ":" + stem(one.headline), feedId: feed.id, rank: i,
      headline: one.headline, summary: one.summary,
      sources: one.sources.join("\n"), sourceTitles: written.sourceTitles,
      fetchedAt: one.fetchedAt,
      why: one.why, madeAt: now,
      body: written.body, image: written.image, readMinutes: written.readMinutes,
      // Carried over when this story survived the refresh unchanged, and
      // otherwise left for the scheduler's sweep. Never computed here: this
      // runs inside the digest pass, which already holds a model call per
      // topic, and adding one per story to it would make a refresh six times
      // longer for work nobody is waiting on.
      bodyMd: carriedOver(kept, feed.id + ":" + stem(one.headline), written.body),
    };
    persist(db, discoverStoriesMapping(), JSON.stringify(row));
    i = i + 1;
  }
  let after: DiscoverFeed = {
    id: feed.id, topic: feed.topic, query: feed.query, lang: feed.lang,
    country: feed.country, enabled: feed.enabled, digestedAt: now,
  };
  persist(db, discoverFeedsMapping(), JSON.stringify(after));
  return "";
}


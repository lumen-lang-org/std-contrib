import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, field, findById, listOrdered, listWhere, deleteWhere, persist, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, modelsMapping } from "./schema.ts";
import { credentialFor } from "./credentials.ts";
import { complete, replyText } from "./provider.ts";
import { retrieveWeb, searchApiBase } from "./webrag.ts";
import { urlEncode } from "./mcp-oauth.ts";
import { jsonList, jsonRaw, jsonText } from "./scan.ts";

function freshHours(): int {
  let said = process.env["AGENTS_DISCOVER_FRESH_HOURS"] ?? "";
  if (said == "") {
    return 48;
  }
  let n = parseInt(said, 10) ?? 48;
  return n < 1 ? 1 : n;
}

function readCap(): int {
  let said = process.env["AGENTS_DISCOVER_READ"] ?? "";
  if (said == "") {
    return 80;
  }
  let n = parseInt(said, 10) ?? 80;
  return n < 1 ? 1 : n;
}

/* How much room to reserve for the answer.
 *
 * A constant until now, and the wrong shape for one: the window has to hold the
 * snippets and the reply together, so every token reserved here is a token the
 * digest cannot spend on evidence. 12000 was sized for a 131k model and became
 * the binding constraint the day the digest moved to a 24k local one - it is
 * why READ had to fall from 80 to 40. A real pass emits about 2k. */
function answerTokens(): int {
  let said = process.env["AGENTS_DISCOVER_MAX_TOKENS"] ?? "";
  if (said == "") {
    return 12000;
  }
  let n = parseInt(said, 10) ?? 12000;
  return n < 256 ? 256 : n;
}

function storyCap(): int {
  let said = process.env["AGENTS_DISCOVER_STORIES"] ?? "";
  if (said == "") {
    return 12;
  }
  let n = parseInt(said, 10) ?? 12;
  return n < 1 ? 1 : n;
}

export type DiscoverFeed = {
  id: string,
  topic: string,
  query: string,
  lang: string,
  country: string,
  enabled: bool,
  digestedAt: string,
};

export type DiscoverStory = {
  headline: string,
  summary: string,
  sources: string[],
  fetchedAt: string,
  why: string,
};

export type DiscoverRow = {
  id: string,
  /* Empty while the story is on the feed; the millisecond stamp of the pass that dropped
   * it once it is not. See migration 116 - nothing deletes a story. */
  archivedAt: string,
  feedId: string,
  rank: int,
  headline: string,
  summary: string,
  sources: string,
  sourceTitles: string,
  fetchedAt: string,
  why: string,
  madeAt: string,
  body: string,
  image: string,
  readMinutes: int,
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
  return repository({ table: "discover_feeds", idField: "id", idColumn: "id", fields: fs });
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
    field("archivedAt", "archived_at", "text"),
  ];
  return repository({ table: "discover_stories", idField: "id", idColumn: "id", fields: fs });
}

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
  return repository({ table: "discover_stories", idField: "id", idColumn: "id", fields: fs });
}

export function discoverTextMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("value", "value", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "discover_text", idField: "id", idColumn: "id", fields: fs });
}

export function discoverText(db: Db, name: string): string {
  let held = findById(db, discoverTextMapping(), name);
  if (held == "") {
    return "";
  }
  return jsonText(held, "value");
}

export function setDiscoverText(db: Db, name: string, value: string, now: string): string {
  let row = "{\"id\":" + JSON.stringify(name) + ",\"value\":" + JSON.stringify(value)
    + ",\"updatedAt\":" + JSON.stringify(now) + "}";
  let written = persist(db, discoverTextMapping(), row);
  if (!written.ok) {
    return written.error;
  }
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
    migration("100", "the body again, made readable",
      "ALTER TABLE discover_stories ADD COLUMN body_md " + db.textType + " NOT NULL DEFAULT ''"),
    migration("105", "what each source called the story",
      "ALTER TABLE discover_stories ADD COLUMN source_titles " + db.textType + " NOT NULL DEFAULT ''"),
    migration("114", "prompts and other text the operator may edit",
      createTableSql(db, discoverTextMapping())),
    /* A story leaves the page; it does not leave the database. The digest used to
     * DELETE every row of a feed and write the new set, so a story that fell out of one
     * pass was gone - with its generated body, its read time, and any link a reader had
     * shared to it. Archiving keeps all of that: the feed reads the live rows,
     * /discover/story/:id still resolves an archived one, and a story that comes back is
     * un-archived rather than rebuilt. */
    migration("128", "a story is archived, never deleted",
      "ALTER TABLE discover_stories ADD COLUMN archived_at " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

const MAX_GEO_FEEDS: int = 40;

const CC_LETTERS: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function geoCode(said: string): string {
  let s = said.trim().toUpperCase();
  if (s.length != 2) {
    return "";
  }
  if (CC_LETTERS.indexOf(s.slice(0, 1)) < 0) {
    return "";
  }
  if (CC_LETTERS.indexOf(s.slice(1, 2)) < 0) {
    return "";
  }
  if (s == "XX" || s == "ZZ") {
    return "";
  }
  return s;
}

export function allFeeds(db: Db): DiscoverFeed[] {
  let keys: DbOrder[] = [{ column: "topic" }];
  return JSON.parse<DiscoverFeed[]>(
    listOrdered(db, discoverFeedsMapping(), { order: keys }));
}

export function ensureGeoFeed(db: Db, country: string): void {
  let cc = geoCode(country);
  if (cc == "") {
    return;
  }
  let id = "geo:" + cc.toLowerCase();
  if (findById(db, discoverFeedsMapping(), id) != "") {
    return;
  }
  let all = allFeeds(db);
  let placed: int = 0;
  let i: int = 0;
  while (i < all.length) {
    if (all[i].country != "") {
      placed = placed + 1;
    }
    i = i + 1;
  }
  if (placed >= MAX_GEO_FEEDS) {
    return;
  }
  let row: DiscoverFeed = {
    id: id, topic: "Local news", query: "news", lang: "", country: cc,
    enabled: true, digestedAt: "",
  };
  persist(db, discoverFeedsMapping(), JSON.stringify(row));
}

export function storiesFor(db: Db, feedId: string): DiscoverRow[] {
  let keys: DbOrder[] = [{ column: "rank" }];
  return JSON.parse<DiscoverRow[]>(
    listOrdered(db, discoverStoriesMapping(), {
      // Live rows only. An archived story keeps its id and stays readable by link.
      where: "feed_id = " + db.placeholder + " AND archived_at = ''",
      args: [feedId],
      order: keys,
    }));
}

export function storyById(db: Db, id: string): DiscoverRow {
  let held = findById(db, discoverStoriesMapping(), id);
  if (held == "") {
    let none: DiscoverRow = {
      id: "", feedId: "", rank: 0, headline: "", summary: "", sources: "", sourceTitles: "",
      fetchedAt: "", why: "", madeAt: "", body: "", image: "", readMinutes: 0,
      bodyMd: "", archivedAt: "",
    };
    return none;
  }
  return JSON.parse<DiscoverRow>(held);
}

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

export type WrittenStory = {
  story: DiscoverStory,
  body: string,
  readMinutes: int,
  image: string,
  sourceTitles: string,
};

export type DiscoverTopic = {
  topic: string,
  stories: WrittenStory[],
  read: int,
  fresh: int,
  fault: string,
};

type Hit = {
  title: string,
  url: string,
  snippet: string,
  source: string,
  fetched_at: string,
  published_at: string,
  first_seen: string,
  lang: string,
  country: string,
  category: string,
  score: number,
  image: string,
};

function effectiveStamp(h: Hit): string {
  if (h.published_at.length >= 19) {
    return h.published_at;
  }
  if (h.first_seen.length >= 19) {
    return h.first_seen;
  }
  return h.fetched_at;
}

function recent(stamp: string, cutoff: string): bool {
  if (stamp.length < 19 || cutoff.length < 19) {
    return false;
  }
  return stamp.slice(0, 19) >= cutoff.slice(0, 19);
}

function cutoffText(): string {
  let secs = parseInt(`${Date.now()}`, 10) ?? 0;
  secs = secs / 1000 - freshHours() * 3600;

  let days = secs / 86400;
  let rest = secs - days * 86400;
  let hh = rest / 3600;
  let mm = (rest - hh * 3600) / 60;
  let ss = rest - hh * 3600 - mm * 60;

  let z = days + 719468;
  let era = z / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) {
    y = y + 1;
  }

  return `${y}` + "-" + pad2(m) + "-" + pad2(d)
    + "T" + pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
}

function pad2(n: int): string {
  return n < 10 ? "0" + `${n}` : `${n}`;
}

export function freshFor(query: string, lang: string, country: string, cap: int): Hit[] {
  let none: Hit[] = [];
  let url = searchApiBase() + "/search?q=" + urlEncode(query) + "&k=" + `${cap}`
    + "&sort=recent&since=" + `${freshHours()}` + "h";
  if (query != "*") {
    url = url + "&match=any";
  }
  if (lang != "") {
    url = url + "&lang=" + urlEncode(lang);
  }
  if (country != "") {
    url = url + "&country=" + urlEncode(country);
  }
  let res = http.request(url, "GET", "", new Map<string, string>());
  if (!res.ok || res.status != 200) {
    return none;
  }
  let raw = jsonRaw(res.body, "results");
  if (raw == "") {
    return none;
  }
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
    if (one.url != "") {
      hits.push(one);
    }
    r = r + 1;
  }

  let cutoff = cutoffText();
  let kept: Hit[] = [];
  let seenTitle = new Map<string, bool>();
  let i: int = 0;
  while (i < hits.length) {
    if (recent(effectiveStamp(hits[i]), cutoff)) {
      let key = hits[i].title.trim().toLowerCase();
      if (key == "" || !seenTitle.has(key)) {
        if (key != "") {
          seenTitle.set(key, true);
        }
        kept.push(hits[i]);
      }
    }
    i = i + 1;
  }

  let out: Hit[] = [];
  while (out.length < kept.length) {
    let best: int = -1;
    let k: int = 0;
    while (k < kept.length) {
      if (!taken(out, kept[k].url)
          && (best < 0 || effectiveStamp(kept[k]) > effectiveStamp(kept[best]))) {
            best = k;
          }
      k = k + 1;
    }
    if (best < 0) {
      break;
    }
    out.push(kept[best]);
  }
  return out;
}

function taken(rows: Hit[], url: string): bool {
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].url == url) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

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

const BODY_PASSAGES: int = 12;
const BODY_FETCH_CHARS: int = 40000;
const BODY_CHARS: int = 12000;

function hostOf(url: string): string {
  let start = url.indexOf("://");
  let rest = start < 0 ? url : url.slice(start + 3);
  let slash = rest.indexOf("/");
  let host = slash < 0 ? rest : rest.slice(0, slash);
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }
  return host;
}

function withoutImages(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    if (i + 1 < text.length && text.charAt(i) == "!" && text.charAt(i + 1) == "[") {
      let alt = text.indexOf("](", i);
      if (alt < 0) {
        out = out + text.slice(i);
        return out;
      }
      let shut = text.indexOf(")", alt);
      if (shut < 0) {
        out = out + text.slice(i);
        return out;
      }
      i = shut + 1;
      while (i < text.length && text.charAt(i) == "\n") {
        i = i + 1;
      }
      if (out.length > 0 && !out.endsWith("\n\n")) {
        out = out + "\n\n";
      }
    } else {
      out = out + text.charAt(i);
      i = i + 1;
    }
  }
  return out;
}

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
      if (wrote) {
        out = out + "[Read on " + hostOf(url) + "](" + url + ")\n\n";
      }
      s = s + 1;
    }
  }

  if (out == "") {
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

  if (out.length > BODY_CHARS) {
    out = out.slice(0, BODY_CHARS) + "…\n";
  }
  return out;
}

/* The longest run of digits in a string.
 *
 * A newsroom article id (mosaiquefm /1527391/, babnet -334542.asp) is the one part of a
 * URL a model retypes correctly: it is short, ASCII, and carries no meaning to garble.
 * When the slug around it is corrupted, this still identifies the article. */
/* The pool, round-robined across its hosts, newest first within each.
 *
 * freshFor sorts by recency alone, so the outlet that publishes through the night takes
 * the top of the list. Measured 2026-08-16 on geo:tn: 16 of 40 snippets were mosaiquefm,
 * and the model built ALL EIGHT cards from that one outlet while lapresse (12 snippets),
 * babnet (6) and four other newsrooms went unread. Ranking by recency is right for one
 * source and wrong across sources - "newest" then means "whoever posts most often".
 *
 * Nothing is dropped: the same 40 snippets reach the model, ordered so the first seven
 * are seven different newsrooms. Recency still decides the order WITHIN a host, and the
 * hosts themselves are offered in the order their freshest article arrived. */
function spreadByHost(hits: Hit[]): Hit[] {
  let out: Hit[] = [];
  let used = new Map<int, bool>();
  let remaining = hits.length;
  while (remaining > 0) {
    let seen = new Map<string, bool>();
    let j: int = 0;
    while (j < hits.length) {
      if (!used.has(j)) {
        let h = hostOf(hits[j].url);
        if (!seen.has(h)) {
          seen.set(h, true);
          used.set(j, true);
          out.push(hits[j]);
          remaining = remaining - 1;
        }
      }
      j = j + 1;
    }
  }
  return out;
}

function longestDigits(s: string): string {
  let best: string = "";
  let cur: string = "";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      cur = cur + s[i];
      if (cur.length > best.length) {
        best = cur;
      }
    } else {
      cur = "";
    }
    i = i + 1;
  }
  return best;
}

/* One model-written source, resolved to a URL that exists in the pool, or "".
 *
 * Order matters: an exact hit first, so a correctly copied URL costs nothing; then a
 * citation number, because asLines() numbers the snippets and a model asked for a source
 * often answers with that number; then the article id, which survives a mistyped slug.
 * Anything still unmatched is discarded rather than stored - a URL that is in no hit is
 * either invented or corrupted, and both are worse than one fewer source. */
function resolveSource(raw: string, hits: Hit[]): string {
  let s = raw.trim();
  if (s == "") {
    return "";
  }
  let i: int = 0;
  while (i < hits.length) {
    if (hits[i].url == s) {
      return hits[i].url;
    }
    i = i + 1;
  }
  let bare = s.replaceAll("[", "").replaceAll("]", "").replaceAll("#", "").trim();
  let n = parseInt(bare, 10) ?? 0;
  if (n >= 1 && n <= hits.length && bare == `${n}`) {
    return hits[n - 1].url;
  }
  let id = longestDigits(s);
  if (id.length >= 5) {
    i = 0;
    while (i < hits.length) {
      if (hits[i].url.indexOf(id) >= 0) {
        return hits[i].url;
      }
      i = i + 1;
    }
  }
  return "";
}

/* Every source on every card, resolved in place. Cards left with no resolvable source
 * keep an empty list; the sources guard upstream already refuses those, and dedup treats
 * an empty list as "no primary url" rather than throwing. */
function resolveSources(stories: DiscoverStory[], hits: Hit[]): DiscoverStory[] {
  let out: DiscoverStory[] = [];
  let repaired: int = 0;
  let i: int = 0;
  while (i < stories.length) {
    let fixed: string[] = [];
    let s: int = 0;
    while (s < stories[i].sources.length) {
      let one = resolveSource(stories[i].sources[s], hits);
      if (one != "") {
        if (one != stories[i].sources[s]) {
          repaired = repaired + 1;
        }
        fixed.push(one);
      }
      s = s + 1;
    }
    /* A NEW record: Lumen record fields are immutable, and assigning one is a parse
     * error rather than a runtime surprise. Same lesson as the dedup pass. */
    let rebuilt: DiscoverStory = {
      headline: stories[i].headline, summary: stories[i].summary,
      sources: fixed, fetchedAt: stories[i].fetchedAt, why: stories[i].why,
    };
    out.push(rebuilt);
    i = i + 1;
  }
  if (repaired > 0) {
    console.error("discover: repaired " + `${repaired}` + " mistyped source url(s)");
  }
  return out;
}

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

function titlesFor(story: DiscoverStory, hits: Hit[]): string {
  let out: string = "";
  let s: int = 0;
  while (s < story.sources.length) {
    let found: string = "";
    let h: int = 0;
    while (h < hits.length) {
      if (hits[h].url == story.sources[s]) {
        found = hits[h].title;
        h = hits.length;
      }
      else {
        h = h + 1;
      }
    }
    out = out + found.replaceAll("\n", " ");
    if (s + 1 < story.sources.length) {
      out = out + "\n";
    }
    s = s + 1;
  }
  return out;
}

function readingMinutes(body: string): int {
  if (body == "") {
    return 0;
  }
  let words: int = 0;
  let inWord: bool = false;
  let i: int = 0;
  while (i < body.length) {
    let c = body.charAt(i);
    let space = c == " " || c == "\n" || c == "\t" || c == "\r";
    if (space) {
      inWord = false;
    } else if (!inWord) {
      words = words + 1;
      inWord = true;
    }
    i = i + 1;
  }
  let mins = words / 220;
  return mins < 1 ? 1 : mins;
}

/* A card's identity, taken from its PRIMARY SOURCE rather than its wording.
 *
 * The id used to be a hash of the headline, and the model rewrites headlines: the same
 * story came back under a new id every pass, so its generated body was thrown away, its
 * read time recomputed, and any link a reader had shared stopped resolving. The source
 * url is what the story IS, it survives a rephrasing, and since sources are resolved
 * against the pool it is a real url rather than something the model typed.
 *
 * The headline stays the fallback for a card with no source, which the guard upstream
 * should already have refused. */
function cardId(feedId: string, one: DiscoverStory): string {
  let key = one.sources.length > 0 ? one.sources[0] : one.headline;
  return feedId + ":" + stem(key);
}

/* The same story, stamped as no longer on the feed. A record field cannot be assigned in
 * Lumen, so this builds a new one - and it goes back through persist(), which upserts on
 * the id, rather than through hand-written SQL. */
function archivedRow(row: DiscoverRow, at: string): DiscoverRow {
  let gone: DiscoverRow = {
    id: row.id, feedId: row.feedId, rank: row.rank, headline: row.headline,
    summary: row.summary, sources: row.sources, sourceTitles: row.sourceTitles,
    fetchedAt: row.fetchedAt, why: row.why, madeAt: row.madeAt, body: row.body,
    image: row.image, readMinutes: row.readMinutes, bodyMd: row.bodyMd, archivedAt: at,
  };
  return gone;
}

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

function langName(code: string): string {
  if (code == "ar") {
    return "Arabic";
  }
  if (code == "fr") {
    return "French";
  }
  if (code == "en") {
    return "English";
  }
  if (code == "de") {
    return "German";
  }
  if (code == "tr") {
    return "Turkish";
  }
  if (code == "es") {
    return "Spanish";
  }
  if (code == "it") {
    return "Italian";
  }
  if (code == "pt") {
    return "Portuguese";
  }
  return code;
}

function digestPromptWith(override: string, topic: string, count: int, outLang: string): string {
  if (override.trim() == "") {
    return digestPrompt(topic, count, outLang);
  }
  let out = override.replaceAll("{topic}", topic).replaceAll("{count}", `${count}`);
  out = out.replaceAll("{language}", outLang == "" ? "the language of the sources" : langName(outLang));
  return out;
}

function scriptOk(text: string, outLang: string): bool {
  let lo: int = 0;
  let hi: int = 0;
  if (outLang == "ar" || outLang == "fa" || outLang == "ur") {
    lo = 216;
    hi = 219;
  }
  else if (outLang == "he") {
    lo = 214;
    hi = 215;
  }
  else if (outLang == "el") {
    lo = 206;
    hi = 207;
  }
  else if (outLang == "ru" || outLang == "uk" || outLang == "bg") {
    lo = 208;
    hi = 209;
  }
  else {
    return true;
  }
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c >= lo && c <= hi) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

/* Characters that can NEVER legitimately appear in a card. A multilingual model
 * under 4-bit quantization occasionally emits the right concept in the wrong
 * script - 移民 for migrant, сф inside Hafsia - measured at 2.07% of output
 * characters when the card is a translation, 0% when it is not. Meaning-correct
 * but script-wrong, so no grammar or language check sees it; a byte-range scan
 * does. Byte-level like scriptOk above: 227-237 are the UTF-8 lead bytes of
 * kana, CJK and Hangul; 208-209 are Cyrillic. Latin is deliberately allowed -
 * the prompt tells the model to keep a name it cannot render rather than
 * invent a spelling. */
function foreignScript(text: string, outLang: string): bool {
  let cyrOk = outLang == "ru" || outLang == "uk" || outLang == "bg";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c >= 227 && c <= 237) {
      return true;
    }
    if (!cyrOk && (c == 208 || c == 209)) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function digestPrompt(topic: string, count: int, outLang: string): string {
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
    + "are what rules 3, 4 and 5 exclude, and true duplicates of an event you "
    + "already carded. Do not invent events that are not in the snippets.\n"
    + "3. Drop what is not news: market-research listings, SEO round-ups, "
    + "product pages, undated explainers. A crawl is mostly made of those.\n"
    + "4. Drop individual crime and accident reports. Somebody assaulted, "
    + "killed, robbed, arrested or missing; a family tragedy; a road crash; a "
    + "fire; a suicide - a reader does not open a digest for these, and the "
    + "people in them did not choose to be in it. Crime as PUBLIC BUSINESS "
    + "stays: a law, a trial of someone acting in a public role, a policing "
    + "policy, a court ruling that sets a precedent, figures the authorities "
    + "themselves published. The test is whether the story is about an "
    + "institution or about somebody's worst day.\n"
    + "5. Drop showbiz. A concert or festival review, how an artist was "
    + "received, a chart placing, an album or single release, tour dates, "
    + "award nominations, celebrity relationships, feuds and lifestyle, "
    + "box-office takings. A cultural event earns a card only when something "
    + "happened beyond the performance - a cancellation, a funding or "
    + "licensing decision, a figure the organisers published, an institution "
    + "acting. Same test as rule 4: an institution, or a personality. This "
    + "rule lifts when the topic is itself music, film or entertainment.\n"
    + "6. Nothing about a private individual unless they are acting in a "
    + "public role.\n"
    + "7. No opinion of your own, on the event or on the coverage."
    + (outLang == "" ? ""
      : "\n8. The language rule at the top governs: every headline, summary and "
        + "why in " + langName(outLang) + ", however the sources are written. A "
        + "card in another language is a failed card.");
}

function translateTries(): int {
  let said = process.env["AGENTS_DISCOVER_RETRIES"] ?? "";
  if (said == "") {
    return 2;
  }
  let n = parseInt(said, 10) ?? 2;
  return n < 1 ? 1 : n;
}

/* One card, translated on its own, checked deterministically, retried within a
 * budget. Splitting translation out of the digest pass measured 4x less
 * wrong-script contamination (2.07% -> 0.54%) - a single card is a small
 * context with little cross-lingual pressure - and the residue is caught here
 * by the same byte-level checks and simply retried: the model only has to be
 * right once. An empty headline is the failure value; the caller drops the
 * card, which costs one story and poisons nothing. */
function translateCard(model: ModelRow, story: DiscoverStory, outLang: string, key: string): DiscoverStory {
  let cfg: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.2, maxTokens: 900, topP: 1.0,
    extra: "", thinking: "off", label: "", selectable: false, rank: 0,
  };
  let ask = "Translate this news card into " + langName(outLang) + ". Answer with "
    + "JSON only: {\"headline\":\"...\",\"summary\":\"...\",\"why\":\"...\"}. "
    + "Translate the MEANING. For a place, person, ministry or institution use "
    + "its established " + langName(outLang) + " name; if you do not know the "
    + "established name, keep it exactly as the source writes it, in its own "
    + "letters. Never invent a spelling and never use characters from any other "
    + "script. An empty why stays empty.
/no_think";
  let payload = JSON.stringify(story);
  let tries: int = 0;
  let budget = translateTries();
  while (tries < budget) {
    tries = tries + 1;
    let asked = complete(model, cfg, ask, payload, key);
    if (!asked.ok) {
      continue;
    }
    let text = replyText(model.provider, asked.text).trim();
    let open = text.indexOf("{");
    let shut = text.lastIndexOf("}");
    if (open < 0 || shut <= open) {
      continue;
    }
    let body = text.slice(open, shut + 1);
    let h = jsonText(body, "headline");
    let s = jsonText(body, "summary");
    let y = jsonText(body, "why");
    if (h == "" || s == "") {
      continue;
    }
    if (!scriptOk(h, outLang) || foreignScript(h + " " + s + " " + y, outLang)) {
      continue;
    }
    let done: DiscoverStory = {
      headline: h, summary: s, sources: story.sources,
      fetchedAt: story.fetchedAt, why: y,
    };
    return done;
  }
  let none: DiscoverStory = { headline: "", summary: "", sources: story.sources, fetchedAt: "", why: "" };
  return none;
}

function judgeOn(): bool {
  return (process.env["AGENTS_DISCOVER_JUDGE"] ?? "1") != "0";
}

/* Rules 4 and 5, enforced per card instead of trusted to the digest pass.
 *
 * The digest prompt bans individual crime and showbiz, and an 8B model obeys
 * MOST of the time - which for a public feed is the same as not obeying: one
 * self-harm story on the Tunisia page is one too many, and one got through the
 * day this was written (garbled in translation too - the model rendered
 * "s'ouvre les veines" as "opens his arms"). A second look at ONE card is a
 * question this model answers far more reliably than a rule buried in a long
 * digest prompt over forty snippets. Fail-OPEN: if the judge cannot answer,
 * the card stays - the digest prompt's own rules remain the first line, and a
 * judge outage must not blank every feed. */
/* One call for the whole feed, not one per card.
 *
 * The per-card judge was right and too expensive: twelve cards across twelve
 * feeds turned one digest pass into ~150 requests against a single 8B on one
 * 4070. vLLM began refusing - geo:tn logged "the model did not answer (http 0)"
 * and kept two stale cards for hours - so the reviewer meant to improve the feed
 * was starving it instead. A numbered list in, a list of numbers out: identical
 * judgement, a twelfth of the load. Fail-OPEN is unchanged; an answer that will
 * not parse drops nothing. */
function judgeBatch(model: ModelRow, stories: DiscoverStory[], key: string): Map<int, bool> {
  let drops = new Map<int, bool>();
  if (stories.length == 0) {
    return drops;
  }
  let cfg: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.0, maxTokens: 220, topP: 1.0,
    extra: "", thinking: "off", label: "", selectable: false, rank: 0,
  };
  let ask = "You review a numbered list of news digest cards. Answer JSON only: "
    + "{\"drop\":[numbers]} listing ONLY the numbers to drop; drop nothing is {\"drop\":[]}.
"
    + "The DEFAULT is keep. Drop only what clearly matches a rule below.

"
    + "drop yes - somebody's worst day: an individual crime, accident, fire, "
    + "road crash, suicide, self-harm, missing person or family tragedy, where "
    + "the story is about the victim or the incident itself.
"
    + "drop yes - showbiz as spectacle: a concert or festival REVIEW, how an "
    + "artist was received, chart placings, album or single releases, tour "
    + "dates, award nominations, celebrity relationships or lifestyle.

"
    + "KEEP (drop no) - these are NOT what the rules exclude, and dropping them "
    + "is the common mistake:
"
    + "- Enforcement and inspection BY authorities: seizures, raids, closures, "
    + "fines, recalls, smuggling or price-control operations. An institution "
    + "acting is public business even when the word 'seized' appears.
"
    + "- Any law, policy, court ruling, trial of someone in a public role, or "
    + "figures the authorities published.
"
    + "- SPORT: match results, transfers, signings, club and federation "
    + "business. Sport is not showbiz.
"
    + "- Culture as institution: a festival's funding, programme, attendance "
    + "figures, a cancellation, a heritage or artisanal initiative, a national "
    + "commemoration.
"
    + "- Economy, industry, health services, infrastructure, digital "
    + "government, education, environment, statistics, weather.

"
    + "When genuinely unsure, answer no.
/no_think";
  let tries: int = 0;
  let budget = translateTries();
  while (tries < budget) {
    tries = tries + 1;
    let listing = "";
    let li: int = 0;
    while (li < stories.length) {
      listing = listing + `${li + 1}` + ". " + stories[li].headline
        + " | " + stories[li].summary + "
";
      li = li + 1;
    }
    let asked = complete(model, cfg, ask, listing, key);
    if (!asked.ok) {
      continue;
    }
    let text = replyText(model.provider, asked.text).trim();
    let open = text.indexOf("{");
    let shut = text.lastIndexOf("}");
    if (open < 0 || shut <= open) {
      continue;
    }
    let raw = jsonRaw(text.slice(open, shut + 1), "drop");
    if (raw == "") {
      continue;
    }
    let nums = jsonList(raw);
    let k: int = 0;
    while (k < nums.length) {
      let n = parseInt(nums[k].trim(), 10) ?? 0;
      if (n >= 1 && n <= stories.length) {
        drops.set(n - 1, true);
      }
      k = k + 1;
    }
    return drops;
  }
  return drops;
}

export function digest(db: Db, topic: string, query: string, lang: string, country: string, modelId: string, master: string): DiscoverTopic {
  let empty: WrittenStory[] = [];
  let readLang = country == "" ? lang : "";
  let hits = freshFor(query, readLang, country, readCap());
  hits = spreadByHost(hits);
  let said = (why: string) => {
    let r: DiscoverTopic = {
      topic: topic, stories: empty, read: hits.length, fresh: hits.length,
      fault: why,
    };
    return r;
  };
  if (hits.length == 0) {
    return said("nothing fresh in the index for this topic");
  }

  let modelDoc = findById(db, modelsMapping(), modelId);
  if (modelDoc == "") {
    return said("no model " + modelId);
  }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) {
    return said(model.label + " is disabled");
  }
  let key = credentialFor(db, model.provider, master);
  if (key == "") {
    return said("no credential for " + model.provider);
  }

  let config: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.6, maxTokens: answerTokens(), topP: 1.0,
    extra: "", thinking: "off", label: "", selectable: false, rank: 0,
  };
  let written = discoverText(db, "digest-prompt");
  let asked = complete(model, config, digestPromptWith(written, topic, storyCap(), lang), asLines(hits), key);
  let tries: int = 1;
  while (tries < 3) {
    if (asked.ok) {
      let peek = replyText(model.provider, asked.text).trim();
      if (peek.indexOf("{") >= 0) {
        break;
      }
    }
    asked = complete(model, config, digestPromptWith(written, topic, storyCap(), lang), asLines(hits), key);
    tries = tries + 1;
  }
  if (!asked.ok) {
    let why = asked.error.length > 200 ? asked.error.slice(0, 200) + "…" : asked.error;
    return said("the model did not answer (http " + `${asked.status}` + "): " + why);
  }

  /* What the pass cost, said out loud.
   *
   * complete() counts these and nothing read them, so the digest's model spend -
   * feeds x passes-per-day, the one cost here that grows without anybody
   * choosing to grow it - could not be measured at all. `counted` is false when
   * the provider did not say, which is a different claim from zero. */
  if (asked.counted) {
    console.log("discover: " + topic + ": " + `${asked.inputTokens}` + " in, "
      + `${asked.outputTokens}` + " out, " + modelId);
  }

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
    return said("the model answered without a stories array: "
      + (body.length > 160 ? body.slice(0, 160) + "…" : body));
  }
  let wrote: WrittenStory[] = [];
  /* A card the model emitted without its sources array used to crash the write
   * path (bodyFor and refreshFeed dereference story.sources unguarded), and the
   * digest loop's try/catch sits outside its while — one such card killed every
   * feed until a restart, 40 times before this guard. Filter on the raw JSON
   * BEFORE the typed parse: a dropped card costs one story, never the pass. */
  let rawCards = jsonList(raw);
  let wholeCards: string[] = [];
  let lame: int = 0;
  let rc: int = 0;
  while (rc < rawCards.length) {
    /* Presence of the key is not enough: "sources": null and "sources": "url"
     * both pass a presence check, then .length throws downstream in dedup and
     * bodyFor - which is what kept crashing geo:ma and geo:tr (contained by the
     * per-feed catch, so the pass lived but those feeds never refreshed).
     * Require a non-empty ARRAY. */
    if (jsonList(jsonRaw(rawCards[rc], "sources")).length > 0 && jsonText(rawCards[rc], "headline") != "") {
      wholeCards.push(rawCards[rc]);
    } else {
      lame = lame + 1;
    }
    rc = rc + 1;
  }
  if (lame > 0) {
    console.error("discover: " + topic + ": dropped " + `${lame}` + " card(s) missing sources or headline");
  }
  /* Reassembling the survivors can still yield invalid JSON: jsonList hands back
   * whatever fragments it found, and a truncated final card is a fragment. That
   * threw straight out of digest() and cost geo:tr its refresh every pass
   * ("JSON.parse: invalid JSON") until the per-feed catch made it visible. A
   * digest that will not parse is a fault, not a crash - the feed keeps the
   * cards it already had. */
  let parsed: DiscoverStory[] = [];
  try {
    parsed = JSON.parse<DiscoverStory[]>("[" + wholeCards.join(",") + "]");
  } catch (e) {
    return said("the model's JSON did not parse: " + e.message);
  }
  /* Before anything reads a source: replace what the model typed with the real URL.
   * Without this a mistyped slug means no image, no source title, and a link the reader
   * cannot open - measured as 0 of 7 images on geo:tn while the images all existed. */
  parsed = resolveSources(parsed, hits);
  /* Judged once, before anything is written. The per-card call had to live
   * inside the loop because each answer was about one card; a batch verdict is
   * known up front, so the loop only consults it. */
  let judgeDrops = new Map<int, bool>();
  if (judgeOn()) {
    judgeDrops = judgeBatch(model, parsed, key);
  }
  let wrongLang: int = 0;
  let poisoned: int = 0;
  let judged: int = 0;
  let w: int = 0;
  while (w < parsed.length) {
    let cand = parsed[w];
    if (lang != "" && (!scriptOk(cand.headline, lang) || foreignScript(cand.headline + " " + cand.summary + " " + cand.why, lang))) {
      /* Not in the target script, or carrying one that can never be right:
       * translate it alone rather than dropping it - retried against the
       * deterministic checks inside translateCard. */
      cand = translateCard(model, cand, lang, key);
      if (cand.headline == "") {
        poisoned = poisoned + 1;
        w = w + 1;
        continue;
      }
    }
    if (!scriptOk(cand.headline, lang)) {
      wrongLang = wrongLang + 1;
      w = w + 1;
      continue;
    }
    if (foreignScript(cand.headline + " " + cand.summary + " " + cand.why, lang)) {
      poisoned = poisoned + 1;
      w = w + 1;
      continue;
    }
    if (judgeDrops.has(w)) {
      judged = judged + 1;
      w = w + 1;
      continue;
    }
    let text = bodyFor(cand, hits);
    let one: WrittenStory = {
      story: cand, body: text, readMinutes: readingMinutes(text),
      image: imageFor(cand, hits),
      sourceTitles: titlesFor(cand, hits),
    };
    wrote.push(one);
    w = w + 1;
  }
  if (poisoned > 0) {
    console.error("discover: " + topic + ": dropped " + `${poisoned}` + " card(s) carrying a foreign script");
  }
  if (judged > 0) {
    console.error("discover: " + topic + ": judge dropped " + `${judged}` + " card(s) as crime or showbiz");
  }
  if (wrote.length == 0 && wrongLang > 0) {
    let all: WrittenStory[] = [];
    let k: int = 0;
    while (k < parsed.length) {
      if (foreignScript(parsed[k].headline + " " + parsed[k].summary + " " + parsed[k].why, lang)) {
        k = k + 1;
        continue;
      }
      let t = bodyFor(parsed[k], hits);
      let o: WrittenStory = {
        story: parsed[k], body: t, readMinutes: readingMinutes(t),
        image: imageFor(parsed[k], hits), sourceTitles: titlesFor(parsed[k], hits),
      };
      all.push(o);
      k = k + 1;
    }
    console.error("discover: every card failed the " + lang + " script check; keeping them");
    wrote = all;
    wrongLang = 0;
  }
  if (wrongLang > 0) {
    console.error("discover: dropped " + `${wrongLang}` + " card(s) not written in " + lang);
  }

  let told: DiscoverTopic = {
    topic: topic, stories: wrote,
    read: hits.length, fresh: hits.length, fault: "",
  };
  return told;
}



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
  if (row.body != "") {
    out = out + "\n" + row.body + "\n";
  }
  return out;
}

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
  if (raw == "") {
    return "";
  }
  let modelDoc = findById(db, modelsMapping(), modelId);
  if (modelDoc == "") {
    return "";
  }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) {
    return "";
  }
  let key = credentialFor(db, model.provider, master);
  if (key == "") {
    return "";
  }

  let config: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.0, maxTokens: 8000, topP: 1.0,
    extra: "", thinking: "off", label: "", selectable: false, rank: 0,
  };
  let asked = complete(model, config, READABLE_PROMPT, raw, key);
  if (!asked.ok) {
    return "";
  }
  let out = replyText(model.provider, asked.text).trim();

  if (out.startsWith("```")) {
    let firstBreak = out.indexOf("\n");
    if (firstBreak > 0) {
      out = out.slice(firstBreak + 1);
    }
    if (out.endsWith("```")) {
      out = out.slice(0, out.length - 3);
    }
    out = out.trim();
  }

  if (out.length < raw.length / 2) {
    return "";
  }
  return out;
}


function digestModelId(): string {
  let said = process.env["AGENTS_DISCOVER_MODEL"] ?? "";
  return said == "" ? "m-vllm-qwen" : said;
}

const CARRY_SEP: string = "\n<<<BODY-MD>>>\n";

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

export function carriedOver(kept: Map<string, string>, id: string, body: string): string {
  let held = kept.get(id) ?? "";
  if (held == "") {
    return "";
  }
  let cut = held.indexOf(CARRY_SEP);
  if (cut < 0) {
    return "";
  }
  if (held.slice(0, cut) != body) {
    return "";
  }
  return held.slice(cut + CARRY_SEP.length);
}

export function unreadableStories(db: Db, limit: int): DiscoverRow[] {
  let keys: DbOrder[] = [{ column: "made_at" }];
  let rows = JSON.parse<DiscoverRow[]>(listOrdered(db, discoverStoriesMapping(), {
    where: "body <> '' AND body_md = '' AND archived_at = ''",
    order: keys,
  }));
  if (rows.length <= limit) {
    return rows;
  }
  let some: DiscoverRow[] = [];
  let i: int = 0;
  while (i < limit) {
    some.push(rows[i]);
    i = i + 1;
  }
  return some;
}

export function discoverModelId(): string {
  return digestModelId();
}

export function withReadableBody(row: DiscoverRow, md: string): DiscoverRow {
  let better: DiscoverRow = {
    id: row.id, feedId: row.feedId, rank: row.rank, headline: row.headline,
    summary: row.summary, sources: row.sources, sourceTitles: row.sourceTitles,
    fetchedAt: row.fetchedAt,
    why: row.why, madeAt: row.madeAt, body: row.body, image: row.image,
    readMinutes: row.readMinutes, bodyMd: md, archivedAt: row.archivedAt,
  };
  return better;
}

function digestEveryMs(): int {
  let said = process.env["AGENTS_DISCOVER_EVERY_MS"] ?? "";
  if (said == "") {
    return 1800000;
  }
  let n = parseInt(said, 10) ?? 1800000;
  return n < 60000 ? 60000 : n;
}

export function refreshFeed(db: Db, feed: DiscoverFeed, master: string): string {
  let told = digest(db, feed.topic, feed.query, feed.lang, feed.country,
    digestModelId(), master);
  if (told.fault != "") {
    return told.fault;
  }
  if (told.stories.length == 0) {
    return "nothing worth a card";
  }

  /* The prompt's rule 2 asks the model not to card the same event twice; it
   * does anyway (measured: identical mineral-water cards from two urls of the
   * same outlet). Dedup is set arithmetic, so do it in code: a card sharing a
   * source URL with an earlier card, or repeating an earlier headline, is the
   * same story - keep the first, which ranked higher. */
  let seenSrc = new Map<string, bool>();
  let seenHead = new Map<string, bool>();
  let unique: WrittenStory[] = [];
  let d: int = 0;
  while (d < told.stories.length) {
    let cand = told.stories[d];
    /* PRIMARY source only. Matching on ANY shared url merged twenty distinct
     * Tunisian stories into four, because the model cross-cites secondary urls
     * however firmly the prompt forbids it, and the newest-ranked stat cards
     * swallowed everything that touched their sources. Two cards naming the
     * same FIRST url are the same event; a shared secondary is model
     * sloppiness, not sameness. */
    let dup: bool = seenHead.has(cand.story.headline.trim());
    if (!dup && cand.story.sources.length > 0 && seenSrc.has(cand.story.sources[0])) {
      dup = true;
    }
    if (!dup) {
      seenHead.set(cand.story.headline.trim(), true);
      if (cand.story.sources.length > 0) {
        seenSrc.set(cand.story.sources[0], true);
      }
      unique.push(cand);
    }
    d = d + 1;
  }
  if (unique.length < told.stories.length) {
    console.error("discover: " + feed.id + ": merged " + `${told.stories.length - unique.length}` + " duplicate card(s)");
  }

  let now = `${Date.now()}`;
  let kept = readableSoFar(db, feed.id);
  /* What the feed holds BEFORE this pass, so the ones it drops can be archived after.
   * Read through the repository, like every other access to this table. */
  let before = storiesFor(db, feed.id);
  let live = new Map<string, bool>();
  let i: int = 0;
  while (i < unique.length) {
    let written = unique[i];
    let one = written.story;
    let row: DiscoverRow = {
      id: cardId(feed.id, one), feedId: feed.id, rank: i, archivedAt: "",
      headline: one.headline, summary: one.summary,
      sources: one.sources.join("\n"), sourceTitles: written.sourceTitles,
      fetchedAt: one.fetchedAt,
      why: one.why, madeAt: now,
      body: written.body, image: written.image, readMinutes: written.readMinutes,
      bodyMd: carriedOver(kept, cardId(feed.id, one), written.body),
    };
    persist(db, discoverStoriesMapping(), JSON.stringify(row));
    live.set(row.id, true);
    i = i + 1;
  }

  /* Anything the feed held and this pass did not choose is archived. The rows it DID
   * choose were upserted above, which also un-archives a story that came back under the
   * same source. Nothing is deleted here or anywhere else. */
  let gone: int = 0;
  let b: int = 0;
  while (b < before.length) {
    if (!live.has(before[b].id)) {
      persist(db, discoverStoriesMapping(), JSON.stringify(archivedRow(before[b], now)));
      gone = gone + 1;
    }
    b = b + 1;
  }
  if (gone > 0) {
    console.error("discover: " + feed.id + ": archived " + `${gone}` + " story(ies) off the feed");
  }
  let after: DiscoverFeed = {
    id: feed.id, topic: feed.topic, query: feed.query, lang: feed.lang,
    country: feed.country, enabled: feed.enabled, digestedAt: now,
  };
  persist(db, discoverFeedsMapping(), JSON.stringify(after));
  return "";
}


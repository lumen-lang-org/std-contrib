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
      where: "feed_id = " + db.placeholder,
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
      bodyMd: "",
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
  let i: int = 0;
  while (i < hits.length) {
    if (recent(effectiveStamp(hits[i]), cutoff)) {
      kept.push(hits[i]);
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
    + "are what rules 3 and 4 exclude, and true duplicates of an event you "
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
    + "5. Nothing about a private individual unless they are acting in a "
    + "public role.\n"
    + "6. No opinion of your own, on the event or on the coverage."
    + (outLang == "" ? ""
      : "\n7. The language rule at the top governs: every headline, summary and "
        + "why in " + langName(outLang) + ", however the sources are written. A "
        + "card in another language is a failed card.");
}

export function digest(db: Db, topic: string, query: string, lang: string, country: string, modelId: string, master: string): DiscoverTopic {
  let empty: WrittenStory[] = [];
  let readLang = country == "" ? lang : "";
  let hits = freshFor(query, readLang, country, readCap());
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
    id: "", modelId: model.id, temperature: 0.2, maxTokens: 12000, topP: 1.0,
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
    return said("the model did not answer");
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
  let parsed = JSON.parse<DiscoverStory[]>(raw);
  let wrongLang: int = 0;
  let w: int = 0;
  while (w < parsed.length) {
    if (!scriptOk(parsed[w].headline, lang)) {
      wrongLang = wrongLang + 1;
      w = w + 1;
      continue;
    }
    let text = bodyFor(parsed[w], hits);
    let one: WrittenStory = {
      story: parsed[w], body: text, readMinutes: readingMinutes(text),
      image: imageFor(parsed[w], hits),
      sourceTitles: titlesFor(parsed[w], hits),
    };
    wrote.push(one);
    w = w + 1;
  }
  if (wrote.length == 0 && wrongLang > 0) {
    let all: WrittenStory[] = [];
    let k: int = 0;
    while (k < parsed.length) {
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
    where: "body <> '' AND body_md = ''",
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
    readMinutes: row.readMinutes, bodyMd: md,
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

  let now = `${Date.now()}`;
  let kept = readableSoFar(db, feed.id);
  deleteWhere(db, discoverStoriesMapping(), "feed_id = " + db.placeholder, [feed.id]);
  let i: int = 0;
  while (i < told.stories.length) {
    let written = told.stories[i];
    let one = written.story;
    let row: DiscoverRow = {
      id: feed.id + ":" + stem(one.headline), feedId: feed.id, rank: i,
      headline: one.headline, summary: one.summary,
      sources: one.sources.join("\n"), sourceTitles: written.sourceTitles,
      fetchedAt: one.fetchedAt,
      why: one.why, madeAt: now,
      body: written.body, image: written.image, readMinutes: written.readMinutes,
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


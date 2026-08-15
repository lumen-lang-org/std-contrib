import { DiscoverFeed, DiscoverRow } from "../../../discover.ts";
import { jsonText } from "../../../scan.ts";
import { DiscoverFeedView } from "./dtos/discover-feed-view.dto.ts";
import { DiscoverStoryView } from "./dtos/discover-story-view.dto.ts";

export function askedPrompt(body: string): string {
  return jsonText(body, "prompt");
}

export function feedFits(feed: DiscoverFeed, lang: string, country: string): bool {
  let langOk = feed.lang == "" || lang == "" || feed.lang == lang;
  let placeOk = feed.country == "" || feed.country == country;
  return langOk && placeOk;
}

export function storyViewOf(row: DiscoverRow): DiscoverStoryView {
  let view: DiscoverStoryView = {
    id: row.id,
    feedId: row.feedId,
    rank: row.rank,
    headline: row.headline,
    summary: row.summary,
    sources: row.sources,
    sourceTitles: row.sourceTitles,
    fetchedAt: row.fetchedAt,
    why: row.why,
    madeAt: row.madeAt,
    image: row.image,
    readMinutes: row.readMinutes,
    hasBody: row.body != "",
  };
  return view;
}

export function storyViewsOf(rows: DiscoverRow[]): DiscoverStoryView[] {
  let out: DiscoverStoryView[] = [];
  let i: int = 0;
  while (i < rows.length) {
    out.push(storyViewOf(rows[i]));
    i = i + 1;
  }
  return out;
}

export function feedViewOf(feed: DiscoverFeed, stories: DiscoverStoryView[]): DiscoverFeedView {
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
  return view;
}

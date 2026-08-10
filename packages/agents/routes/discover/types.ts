import { DiscoverRow } from "../../discover.ts";

export type PromptView = {
  prompt: string,
  usingDefault: bool,
};

export type DiscoverStoryView = {
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
  image: string,
  readMinutes: int,
  hasBody: bool,
};

export type DiscoverFeedView = {
  id: string,
  topic: string,
  query: string,
  enabled: bool,
  lang: string,
  country: string,
  digestedAt: string,
  stories: DiscoverStoryView[],
};

export type StoryDetailView = {
  story: DiscoverRow,
  topic: string,
  feedId: string,
};

export type PlaceView = {
  country: string,
};

export type DeletedView = {
  deleted: string,
};

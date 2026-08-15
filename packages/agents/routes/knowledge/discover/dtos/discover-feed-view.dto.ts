import { DiscoverStoryView } from "./discover-story-view.dto.ts";

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

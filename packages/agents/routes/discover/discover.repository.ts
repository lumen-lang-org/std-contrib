import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, deleteWhere, listOrdered, persist } from "../../../plume/plume.ts";
import { DiscoverFeed, DiscoverRow, allFeeds, discoverFeedsMapping, discoverStoriesMapping, discoverText, discoverTextMapping, ensureGeoFeed, feedById, setDiscoverText, storiesFor, storyById } from "../../discover.ts";

export class DiscoverRepository {
  database: Db;
  feeds: DbRepository;
  stories: DbRepository;
  texts: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.feeds = discoverFeedsMapping();
    this.stories = discoverStoriesMapping();
    this.texts = discoverTextMapping();
  }

  text(name: string): string {
    return discoverText(this.database, name);
  }

  saveText(name: string, value: string, now: string): string {
    return setDiscoverText(this.database, name, value, now);
  }

  forgetText(name: string): DbResult {
    return deleteById(this.database, this.texts, name);
  }

  everyFeed(): DiscoverFeed[] {
    return allFeeds(this.database);
  }

  ensurePlaceFeed(country: string): void {
    ensureGeoFeed(this.database, country);
  }

  listingByTopic(): string {
    let keys: DbOrder[] = [{ column: "topic" }];
    return listOrdered(this.database, this.feeds, { order: keys });
  }

  feed(id: string): DiscoverFeed {
    return feedById(this.database, id);
  }

  saveFeed(row: DiscoverFeed): DbResult {
    return persist(this.database, this.feeds, JSON.stringify(row));
  }

  storiesOf(feedId: string): DiscoverRow[] {
    return storiesFor(this.database, feedId);
  }

  story(id: string): DiscoverRow {
    return storyById(this.database, id);
  }

  forgetFeed(id: string): string {
    let steps: DbResult[] = [
      deleteWhere(this.database, this.stories, "feed_id = " + this.database.placeholder, [id]),
      deleteById(this.database, this.feeds, id),
    ];
    let i: int = 0;
    while (i < steps.length) {
      if (!steps[i].ok) {
        return steps[i].error;
      }
      i = i + 1;
    }
    return "";
  }
}

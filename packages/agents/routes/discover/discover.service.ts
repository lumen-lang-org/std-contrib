import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { DiscoverFeed, geoCode } from "../../discover.ts";
import { DeletedView } from "./dtos/deleted-view.dto.ts";
import { DiscoverFeedView } from "./dtos/discover-feed-view.dto.ts";
import { FeedAsk } from "./dtos/feed-ask.dto.ts";
import { PlaceView } from "./dtos/place-view.dto.ts";
import { PromptView } from "./dtos/prompt-view.dto.ts";
import { StoryDetailView } from "./dtos/story-detail-view.dto.ts";
import { DiscoverRepository } from "./discover.repository.ts";
import { feedFits, feedViewOf, storyViewsOf } from "./discover.utils.ts";

const PROMPT_CHARS_MAX: int = 20000;

const DIGEST_PROMPT: string = "digest-prompt";

export class DiscoverService {
  repository: DiscoverRepository;

  constructor(database: Db) {
    this.repository = new DiscoverRepository(database);
  }

  prompt(): PromptView {
    let held = this.repository.text(DIGEST_PROMPT);
    let view: PromptView = { prompt: held, usingDefault: held.trim() == "" };
    return view;
  }

  writePrompt(asked: string): Outcome {
    if (asked.trim() == "") {
      let cleared = this.repository.forgetText(DIGEST_PROMPT);
      if (!cleared.ok) {
        return refusing(cleared.error);
      }
      let empty: PromptView = { prompt: "", usingDefault: true };
      return produced(JSON.stringify(empty));
    }
    if (asked.length > PROMPT_CHARS_MAX) {
      return refusing("a prompt over " + `${PROMPT_CHARS_MAX}` + " characters is refused");
    }
    let fault = this.repository.saveText(DIGEST_PROMPT, asked, stamp());
    if (fault != "") {
      return refusing(fault);
    }
    let held: PromptView = { prompt: asked, usingDefault: false };
    return produced(JSON.stringify(held));
  }

  reading(lang: string, said: string, showAll: bool): DiscoverFeedView[] {
    let country = geoCode(said);
    if (country != "") {
      this.repository.ensurePlaceFeed(country);
    }
    let feeds = this.repository.everyFeed();

    let out: DiscoverFeedView[] = [];
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      if (feed.enabled && (showAll || feedFits(feed, lang, country))) {
        let rows = this.repository.storiesOf(feed.id);
        if (showAll || rows.length > 0) {
          out.push(feedViewOf(feed, storyViewsOf(rows)));
        }
      }
      i = i + 1;
    }
    return out;
  }

  hasStory(id: string): bool {
    return this.repository.story(id).id != "";
  }

  story(id: string): StoryDetailView {
    let row = this.repository.story(id);
    let feed = this.repository.feed(row.feedId);
    let view: StoryDetailView = { story: row, topic: feed.topic, feedId: feed.id };
    return view;
  }

  feeds(): string {
    return this.repository.listingByTopic();
  }

  places(): PlaceView[] {
    let feeds = this.repository.everyFeed();
    let out: PlaceView[] = [];
    let i: int = 0;
    while (i < feeds.length) {
      let feed = feeds[i];
      if (feed.enabled && feed.country != "" && this.repository.storiesOf(feed.id).length > 0) {
        let place: PlaceView = { country: feed.country };
        out.push(place);
      }
      i = i + 1;
    }
    return out;
  }

  addFeed(ask: FeedAsk): Outcome {
    let row: DiscoverFeed = {
      id: ask.id,
      topic: ask.topic,
      query: ask.query,
      lang: ask.lang,
      country: ask.country,
      enabled: ask.enabled,
      digestedAt: ask.digestedAt,
    };
    let written = this.repository.saveFeed(row);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(JSON.stringify(row));
  }

  dropFeed(id: string): Outcome {
    let fault = this.repository.forgetFeed(id);
    if (fault != "") {
      return refusing(fault);
    }
    let gone: DeletedView = { deleted: id };
    return produced(JSON.stringify(gone));
  }
}

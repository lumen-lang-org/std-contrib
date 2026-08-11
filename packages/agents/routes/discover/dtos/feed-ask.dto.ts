import { Rule, validated, Required } from "../../../../validation/validation.ts";

@validated
export class FeedAsk {
  @Required("a feed needs an id, a topic and a query")
  id: string;

  @Required("a feed needs an id, a topic and a query")
  topic: string;

  @Required("a feed needs an id, a topic and a query")
  query: string;

  lang: string;

  country: string;

  enabled: bool;

  digestedAt: string;

  constructor(id: string, topic: string, query: string, lang: string,
              country: string, enabled: bool, digestedAt: string) {
    this.id = id;
    this.topic = topic;
    this.query = query;
    this.lang = lang;
    this.country = country;
    this.enabled = enabled;
    this.digestedAt = digestedAt;
  }
}

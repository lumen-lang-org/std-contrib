import { validated, Rule } from "../../../../validation/validation.ts";

@validated
export class FeedAsk {
  @required("a feed needs an id, a topic and a query")
  id: string;

  @required("a feed needs an id, a topic and a query")
  topic: string;

  @required("a feed needs an id, a topic and a query")
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

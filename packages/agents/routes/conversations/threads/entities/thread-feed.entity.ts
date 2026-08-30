import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("thread_feed")
export class ThreadFeed {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("kind", "text")
  kind: string;

  @Column("seq", "int")
  seq: int;

  @Column("bumped", "text")
  bumped: string;

  constructor(id: string, threadId: string, kind: string, seq: int, bumped: string) {
    this.id = id;
    this.threadId = threadId;
    this.kind = kind;
    this.seq = seq;
    this.bumped = bumped;
  }
}

export function threadFeedRepository(): DbRepository {
  return entityThreadFeed;
}

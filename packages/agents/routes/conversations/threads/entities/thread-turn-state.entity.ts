import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("thread_turn_state")
export class ThreadTurnState {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("seq", "int")
  seq: int;

  @Column("state", "text")
  state: string;

  @Column("body", "text")
  body: string;

  @Column("started_at", "text")
  startedAt: string;

  @Column("ended_at", "text")
  endedAt: string;

  constructor(id: string, threadId: string, seq: int, state: string, body: string, startedAt: string, endedAt: string) {
    this.id = id;
    this.threadId = threadId;
    this.seq = seq;
    this.state = state;
    this.body = body;
    this.startedAt = startedAt;
    this.endedAt = endedAt;
  }
}

export function threadTurnStateRepository(): DbRepository {
  return entityThreadTurnState;
}

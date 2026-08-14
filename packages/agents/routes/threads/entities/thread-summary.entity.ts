import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("thread_summaries")
export class ThreadSummary {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("through_seq", "int")
  throughSeq: int;

  @Column("text", "text")
  text: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, threadId: string, throughSeq: int, text: string, updatedAt: string) {
    this.id = id;
    this.threadId = threadId;
    this.throughSeq = throughSeq;
    this.text = text;
    this.updatedAt = updatedAt;
  }
}

export function threadSummaryRepository(): DbRepository {
  return entityThreadSummary;
}

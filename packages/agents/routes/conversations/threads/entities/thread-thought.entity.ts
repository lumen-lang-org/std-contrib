import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("thread_thoughts")
export class ThreadThought {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("seq", "int")
  seq: int;

  @Column("depth", "int")
  depth: int;

  @Column("rotation", "int")
  rotation: int;

  @Column("text", "text")
  text: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, threadId: string, seq: int, depth: int, rotation: int, text: string, createdAt: string) {
    this.id = id;
    this.threadId = threadId;
    this.seq = seq;
    this.depth = depth;
    this.rotation = rotation;
    this.text = text;
    this.createdAt = createdAt;
  }
}

export function threadThoughtRepository(): DbRepository {
  return entityThreadThought;
}

import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("thread_partials")
export class ThreadPartial {
  @Id
  @Column("thread_id", "text")
  id: string;

  @Column("seq", "int")
  seq: int;

  @Column("text", "text")
  text: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, seq: int, text: string, updatedAt: string) {
    this.id = id;
    this.seq = seq;
    this.text = text;
    this.updatedAt = updatedAt;
  }
}

export function threadPartialRepository(): DbRepository {
  return entityThreadPartial;
}

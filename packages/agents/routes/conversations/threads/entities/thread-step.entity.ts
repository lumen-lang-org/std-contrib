import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("thread_steps")
export class ThreadStep {
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

  @Column("idx", "int")
  idx: int;

  @Column("kind", "text")
  kind: string;

  @Column("name", "text")
  name: string;

  @Column("target", "text")
  target: string;

  @Column("args", "text")
  args: string;

  @Column("started_at", "text")
  startedAt: string;

  @Column("ended_at", "text")
  endedAt: string;

  @Column("millis", "int")
  millis: int;

  @Column("ok", "bool")
  ok: bool;

  @Column("result", "text")
  result: string;

  constructor(id: string, threadId: string, seq: int, depth: int, rotation: int, idx: int, kind: string, name: string, target: string, args: string, startedAt: string, endedAt: string, millis: int, ok: bool, result: string) {
    this.id = id;
    this.threadId = threadId;
    this.seq = seq;
    this.depth = depth;
    this.rotation = rotation;
    this.idx = idx;
    this.kind = kind;
    this.name = name;
    this.target = target;
    this.args = args;
    this.startedAt = startedAt;
    this.endedAt = endedAt;
    this.millis = millis;
    this.ok = ok;
    this.result = result;
  }
}

export function threadStepRepository(): DbRepository {
  return entityThreadStep;
}

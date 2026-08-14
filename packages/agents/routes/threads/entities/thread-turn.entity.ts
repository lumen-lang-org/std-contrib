import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("thread_turns")
export class ThreadTurn {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("seq", "int")
  seq: int;

  @Column("role", "text")
  role: string;

  @Column("text", "text")
  text: string;

  @Column("calls", "text")
  calls: string;

  @Column("call_id", "text")
  callId: string;

  @Column("tool_name", "text")
  toolName: string;

  constructor(id: string, threadId: string, seq: int, role: string, text: string, calls: string, callId: string, toolName: string) {
    this.id = id;
    this.threadId = threadId;
    this.seq = seq;
    this.role = role;
    this.text = text;
    this.calls = calls;
    this.callId = callId;
    this.toolName = toolName;
  }
}

export function threadTurnRepository(): DbRepository {
  return entityThreadTurn;
}

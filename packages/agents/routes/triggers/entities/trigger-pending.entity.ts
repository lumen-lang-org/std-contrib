import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("trigger_pending")
export class TriggerPending {
  @Id
  @Column("id", "text")
  id: string;

  @Column("bot_id", "text")
  botId: string;

  @Column("chat_id", "text")
  chatId: string;

  @Column("workflow_id", "text")
  workflowId: string;

  @Column("run_id", "text")
  runId: string;

  @Column("node_id", "text")
  nodeId: string;

  @Column("graph", "text")
  graph: string;

  @Column("input", "text")
  input: string;

  @Column("outputs", "text")
  outputs: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("expires_at", "text")
  expiresAt: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, botId: string, chatId: string, workflowId: string, runId: string,
              nodeId: string, graph: string, input: string, outputs: string, threadId: string,
              expiresAt: string, createdAt: string) {
    this.id = id;
    this.botId = botId;
    this.chatId = chatId;
    this.workflowId = workflowId;
    this.runId = runId;
    this.nodeId = nodeId;
    this.graph = graph;
    this.input = input;
    this.outputs = outputs;
    this.threadId = threadId;
    this.expiresAt = expiresAt;
    this.createdAt = createdAt;
  }
}

export function triggerPendingRepository(): DbRepository {
  return entityTriggerPending;
}

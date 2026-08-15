import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("trigger_inbox")
export class TriggerInbox {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("bot_id", "text")
  botId: string;

  @Column("workflow_id", "text")
  workflowId: string;

  @Column("update_id", "text")
  updateId: string;

  @Column("chat_id", "text")
  chatId: string;

  @Column("input", "text")
  input: string;

  @Column("status", "text")
  status: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("file_name", "text")
  fileName: string;

  @Column("file_body", "text")
  fileBody: string;

  @Column("speaker", "text")
  speaker: string;

  @Column("run_id", "text")
  runId: string;

  @Column("answer", "text")
  answer: string;

  @Column("error", "text")
  error: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, owner: string, botId: string, workflowId: string, updateId: string,
              chatId: string, input: string, status: string, threadId: string, fileName: string,
              fileBody: string, speaker: string, runId: string, answer: string, fault: string,
              createdAt: string, updatedAt: string) {
    this.id = id;
    this.owner = owner;
    this.botId = botId;
    this.workflowId = workflowId;
    this.updateId = updateId;
    this.chatId = chatId;
    this.input = input;
    this.status = status;
    this.threadId = threadId;
    this.fileName = fileName;
    this.fileBody = fileBody;
    this.speaker = speaker;
    this.runId = runId;
    this.answer = answer;
    this.error = fault;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export function triggerInboxRepository(): DbRepository {
  return entityTriggerInbox;
}

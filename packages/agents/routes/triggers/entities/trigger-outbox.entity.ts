import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("trigger_outbox")
export class TriggerOutbox {
  @Id
  @Column("id", "text")
  id: string;

  @Column("bot_id", "text")
  botId: string;

  @Column("chat_id", "text")
  chatId: string;

  @Column("run_id", "text")
  runId: string;

  @Column("text", "text")
  text: string;

  @Column("status", "text")
  status: string;

  @Column("options", "text")
  options: string;

  @Column("file_thread", "text")
  fileThread: string;

  @Column("file_path", "text")
  filePath: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, botId: string, chatId: string, runId: string, text: string,
              status: string, options: string, fileThread: string, filePath: string,
              createdAt: string, updatedAt: string) {
    this.id = id;
    this.botId = botId;
    this.chatId = chatId;
    this.runId = runId;
    this.text = text;
    this.status = status;
    this.options = options;
    this.fileThread = fileThread;
    this.filePath = filePath;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export function triggerOutboxRepository(): DbRepository {
  return entityTriggerOutbox;
}

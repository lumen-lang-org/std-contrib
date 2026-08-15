export class PromptBody {
  id: string;
  promptName: string;
  version: int;
  body: string;
  createdAt: string;

  constructor(id: string, promptName: string, version: int, body: string, createdAt: string) {
    this.id = id;
    this.promptName = promptName;
    this.version = version;
    this.body = body;
    this.createdAt = createdAt;
  }
}

export type PromptRecord = {
  id: string,
  promptName: string,
  version: int,
  body: string,
  createdAt: string,
};

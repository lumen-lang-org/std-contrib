import { MessageView } from "./message-view.dto.ts";

export type TranscriptView = {
  modelChoiceId: string,
  title: string,
  mine: bool,
  messages: MessageView[],
};

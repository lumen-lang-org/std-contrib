import { RefView } from "./ref-view.dto.ts";

export type MessageView = {
  role: string,
  seq: int,
  text: string,
  refs: RefView[],
};

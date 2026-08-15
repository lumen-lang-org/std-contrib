import { RefView } from "./ref-view.dto.ts";
import { StepView } from "./step-view.dto.ts";
import { ThoughtView } from "./thought-view.dto.ts";

export type GuestAnsweredView = {
  runId: string,
  ok: bool,
  text: string,
  refs: RefView[],
  seq: int,
  modelChoiceId: string,
  routeNote: string,
  toolCalls: int,
  steps: StepView[],
  thoughts: ThoughtView[],
  inputTokens: int,
  outputTokens: int,
  traceId: string,
  error: string,
  guestRemaining: int,
};

import { RefView } from "./ref-view.dto.ts";
import { StepView } from "./step-view.dto.ts";
import { ThoughtView } from "./thought-view.dto.ts";

export type TurnAnswerView = {
  state: string,
  seq: int,
  runId: string,
  ok: bool,
  text: string,
  refs: RefView[],
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

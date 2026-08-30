import { StepView } from "./step-view.dto.ts";
import { ThoughtView } from "./thought-view.dto.ts";

export type RoundView = {
  seq: int,
  running: bool,
  state: string,
  partial: string,
  thoughts: ThoughtView[],
  steps: StepView[],
};

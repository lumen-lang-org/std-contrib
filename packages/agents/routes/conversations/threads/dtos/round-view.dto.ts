import { StepView } from "./step-view.dto.ts";
import { ThoughtView } from "./thought-view.dto.ts";

export type RoundView = {
  seq: int,
  running: bool,
  partial: string,
  thoughts: ThoughtView[],
  steps: StepView[],
};

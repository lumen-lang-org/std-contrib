import { ToolCall } from "../../../../provider.ts";

/* What a completion answers with. runId is the runs-table row this call
 * wrote, so the spend is visible in /runs like every other model call -
 * the in-process path this endpoint replaces counted tokens that nothing
 * ever read. calls carries any tool calls the model asked for: empty on an
 * ordinary text answer, non-empty when a caller sent tools[] and the model
 * used one - the caller runs the tool itself and hands the result back as
 * the next turn, same as every other provider's tool-calling loop. */
export type CompletionView = {
  ok: bool,
  text: string,
  model: string,
  inputTokens: int,
  outputTokens: int,
  runId: string,
  calls: ToolCall[],
};

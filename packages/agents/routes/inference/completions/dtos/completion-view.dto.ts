/* What a completion answers with. runId is the runs-table row this call
 * wrote, so the spend is visible in /runs like every other model call —
 * the in-process path this endpoint replaces counted tokens that nothing
 * ever read. */
export type CompletionView = {
  ok: bool,
  text: string,
  model: string,
  inputTokens: int,
  outputTokens: int,
  runId: string,
};

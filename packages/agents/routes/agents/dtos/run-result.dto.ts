export type RunResult = {
  runId: string,
  ok: bool,
  text: string,
  agentName: string,
  promptVersion: int,
  modelApiName: string,
  stopReason: string,
  toolCalls: int,
  traceId: string,
  error: string,
};

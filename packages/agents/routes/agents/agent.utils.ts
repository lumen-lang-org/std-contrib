import { AgentRun } from "../../run.ts";
import { RunResult } from "./dtos/run-result.dto.ts";

export function scopeFromPath(escaped: string): string {
  return escaped.replaceAll("~", "/");
}

export function runResultOf(runId: string, answered: AgentRun, traced: string): RunResult {
  return {
    runId: runId,
    ok: answered.ok,
    text: answered.text,
    agentName: answered.agentName,
    promptVersion: answered.promptVersion,
    modelApiName: answered.modelApiName,
    stopReason: answered.stopReason,
    toolCalls: answered.steps.length,
    traceId: traced,
    error: answered.error,
  };
}

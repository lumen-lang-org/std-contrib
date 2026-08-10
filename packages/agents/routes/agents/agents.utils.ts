import { AgentRun } from "../../run.ts";
import { RunResult } from "./agents.dto.ts";

// A scope reads like a path, so it cannot travel in one: `/` is written `~` in
// the URL and put back here.
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

import { bodyInt, bodyJson, bodyText } from "../../../../api-core.ts";
import { Turn, ToolSpec, userTurn } from "../../../../provider.ts";

/* What a headless caller may ask for. Exactly one of modelChoiceId and
 * modelConfigId names the model. Either a flat system/input prompt (the
 * shape of provider.complete() - Discover's shape, and still the whole
 * story for a caller that never sends turns or tools) or an explicit
 * turns[] array with a tools[] declaration - what a caller running its own
 * tool-calling loop against the Platform's /chat/completions sends once it
 * has a prior assistant turn or a tool result to hand back. */
export type CompletionAsk = {
  modelChoiceId: string,
  modelConfigId: string,
  system: string,
  input: string,
  turns: Turn[],
  tools: ToolSpec[],
  maxTokens: int,
};

function parseTurns(body: string): Turn[] {
  let raw = bodyJson(body, "turns", "");
  if (raw == "" || raw == "[]") {
    let none: Turn[] = [];
    return none;
  }
  return JSON.parse<Turn[]>(raw);
}

function parseTools(body: string): ToolSpec[] {
  let raw = bodyJson(body, "tools", "");
  if (raw == "" || raw == "[]") {
    let none: ToolSpec[] = [];
    return none;
  }
  return JSON.parse<ToolSpec[]>(raw);
}

export function completionAskOf(body: string): CompletionAsk {
  let ask: CompletionAsk = {
    modelChoiceId: bodyText(body, "modelChoiceId", ""),
    modelConfigId: bodyText(body, "modelConfigId", ""),
    system: bodyText(body, "system", ""),
    input: bodyText(body, "input", ""),
    turns: parseTurns(body),
    tools: parseTools(body),
    maxTokens: bodyInt(body, "maxTokens", 0),
  };
  return ask;
}

/* The turns this ask actually resolves to: the caller's own turns[] when it
 * sent one, else the single-input shape wrapped the way provider.complete()
 * always has. Kept here, next to the parsing, so "what did the caller ask
 * for" has one answer instead of being reconstructed in the service. */
export function turnsOf(ask: CompletionAsk): Turn[] {
  if (ask.turns.length > 0) {
    return ask.turns;
  }
  return [userTurn(ask.input)];
}

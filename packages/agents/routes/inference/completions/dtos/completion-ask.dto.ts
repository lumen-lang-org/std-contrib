import { bodyInt, bodyText } from "../../../../api-core.ts";

/* What a headless caller may ask for. Exactly one of modelChoiceId and
 * modelConfigId names the model; system and input are the whole prompt.
 * Deliberately the shape of provider.complete() and nothing more — turns,
 * tools and routing stay with threads until a caller actually needs them
 * here, and Discover (the first caller) does not. */
export type CompletionAsk = {
  modelChoiceId: string,
  modelConfigId: string,
  system: string,
  input: string,
  maxTokens: int,
};

export function completionAskOf(body: string): CompletionAsk {
  let ask: CompletionAsk = {
    modelChoiceId: bodyText(body, "modelChoiceId", ""),
    modelConfigId: bodyText(body, "modelConfigId", ""),
    system: bodyText(body, "system", ""),
    input: bodyText(body, "input", ""),
    maxTokens: bodyInt(body, "maxTokens", 0),
  };
  return ask;
}

// Shared result record for AI provider calls.

type AiResult = {
  status: int,
  ok: bool,
  content: string,
  raw: string,
};

export function makeAiResult(status: int, ok: bool, content: string, raw: string): AiResult {
  return {
    status: status,
    ok: ok,
    content: content,
    raw: raw,
  };
}

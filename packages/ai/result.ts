// Shared result record for AI provider calls.

type LumenAiResult = {
  status: int,
  ok: bool,
  content: string,
  raw: string,
};

export function makeAiResult(status: int, ok: bool, content: string, raw: string): LumenAiResult {
  return {
    status: status,
    ok: ok,
    content: content,
    raw: raw,
  };
}

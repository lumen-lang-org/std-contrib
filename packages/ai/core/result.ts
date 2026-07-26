// Shared result record for AI provider calls.

export type Result = {
  status: int,
  ok: bool,
  content: string,
  raw: string,
};

export function makeAiResult(status: int, ok: bool, content: string, raw: string): Result {
  return {
    status: status,
    ok: ok,
    content: content,
    raw: raw,
  };
}

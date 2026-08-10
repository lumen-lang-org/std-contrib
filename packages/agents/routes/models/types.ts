export type ModelTestFailed = { ok: bool, error: string };

export type EmbeddingProbe = {
  ok: bool,
  dimensions: int,
  declared: int,
  error: string,
};

export type ChatProbe = {
  ok: bool,
  reply: string,
  inputTokens: int,
  outputTokens: int,
};

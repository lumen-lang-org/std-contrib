export type QuotaNone = { limit: int };

export type QuotaView = {
  limit: int,
  used: int,
  remaining: int,
  resetsAt: string,
};

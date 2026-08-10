// The shapes the servers routes read and write.

export type ServerAuth = { authKind: string, authHeader: string, token: string };

// The one member PUT /servers/:id/tools/:tool reads.
export type ToolSwitch = { on: bool };

// The one member PUT /servers/:id/mine reads.
export type MineAsk = {
  token: string,
};

export type ServerAuth = { authKind: string, authHeader: string, token: string };

export type ToolSwitch = { on: bool };

export type MineAsk = {
  token: string,
};

export type ToolView = {
  name: string,
  description: string,
  on: bool,
};

export type ServerToolsView = {
  serverId: string,
  problem: string,
  stale: bool,
  listedAt: string,
  tools: ToolView[],
};

export type StoredView = {
  stored: bool,
};

export type ConnectionView = {
  serverId: string,
  authKind: string,
  state: string,
  whose: string,
  clientId: string,
  connectedAt: string,
};

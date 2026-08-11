export type ConnectorBody = {
  id: string,
  serverName: string,
  transport: string,
  endpoint: string,
  authKind: string,
  authHeader: string,
  enabled: bool,
};

export type TraceSecret = { secretKey: string };

export type TraceStatusOff = { configured: bool, active: bool };

export type TraceStatus = {
  configured: bool,
  active: bool,
  backend: string,
  endpoint: string,
  publicKey: string,
  serviceName: string,
  environment: string,
  enabled: bool,
  secretStored: bool,
};
